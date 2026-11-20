// Backend: any model behind a LiteLLM proxy (https://docs.litellm.ai/docs/simple_proxy): OpenAI, Gemini, Bedrock,
// Vertex, Azure, Mistral, a local Ollama, ... through one OpenAI-compatible endpoint. Mortiflix runs the same agent loop
// as the Claude API backend (the persistent bash shell and the file editor confined to the project folder) over the
// proxy's /v1/chat/completions with function tools. Frames the editor shows come back as image parts, so a model with
// vision can still check its renders. The proxy reports what each call cost, so sessions book real spend.
import { refuseReal } from '../replay.mjs';
import { createWriteStream, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, readSecret } from '../studio.mjs';
import { withPath } from '../platform.mjs';
import { Shell, bashTool, editorTool } from './anthropic-api.mjs';

export const name = 'litellm';
export const DEFAULT_BASE_URL = 'http://localhost:4000';

const SYSTEM = `You are a production session in Mortiflix, a motion design studio that runs on one machine. You make
videos step by step through a pipeline for the studio's owner, one person who approves every reviewed step.

There is no human in this conversation. Nobody will answer if you ask here: the owner only sees what you send
with \`mfx\` (submissions, questions, status lines). So work on your own, keep going through setbacks, and stop only
at a gate, exactly as the project's CLAUDE.md and .mortiflix/GATES.md describe.

Your tools: \`bash\` runs in a persistent shell in the project folder (each command may take up to 10 minutes; heavy
renders go through \`mfx render\` + \`mfx render-wait\`), and \`str_replace_based_edit_tool\` reads and writes files in
the project folder. Viewing an image file with the editor shows you the picture: use it to check frames you render.

End your turn only after \`mfx handoff\`.`;

// The same two tools as the Claude API backend, described as OpenAI function tools.
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a command in a persistent bash shell in the project folder. Output and the exit code come back. Set restart to start a fresh shell.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, restart: { type: 'boolean' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'str_replace_based_edit_tool',
      description: 'View, create and edit files in the project folder. view shows a file (with line numbers), a folder listing, or an image; create writes file_text; str_replace swaps one unique old_str for new_str; insert adds insert_text after insert_line.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
          path: { type: 'string' },
          file_text: { type: 'string' },
          old_str: { type: 'string' },
          new_str: { type: 'string' },
          insert_line: { type: 'integer' },
          insert_text: { type: 'string' },
          view_range: { type: 'array', items: { type: 'integer' } },
        },
        required: ['command', 'path'],
      },
    },
  },
];

export function credentials(root) {
  return { key: readSecret(root, 'litellm_api_key') || process.env.LITELLM_API_KEY || null };
}

// The proxy's base URL without a trailing /v1 (requests add it), from Settings, LITELLM_BASE_URL or the default.
export function baseUrl(config = {}) {
  const url = String(config.litellmBaseUrl || process.env.LITELLM_BASE_URL || DEFAULT_BASE_URL).trim();
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function available(config, root) {
  if (!config.litellmBaseUrl && !process.env.LITELLM_BASE_URL) return { ok: false, detail: 'no LiteLLM proxy: add its URL in Settings, or set LITELLM_BASE_URL' };
  if (!config.model) return { ok: false, detail: 'pick one of the proxy\'s models in Settings' };
  return { ok: true, detail: `LiteLLM proxy (${config.model} at ${baseUrl(config)})` };
}

function headers(root) {
  const { key } = credentials(root);
  return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

// The models the proxy serves (GET /v1/models), for the Settings picker.
export async function listModels(root, config, { fetch = globalThis.fetch } = {}) {
  const r = await fetch(`${baseUrl(config)}/v1/models`, { headers: headers(root), signal: AbortSignal.timeout(10_000) });
  if (r.status === 401 || r.status === 403) throw new Error('the LiteLLM proxy rejected the key');
  if (!r.ok) throw new Error(`the LiteLLM proxy answered ${r.status}`);
  const body = await r.json();
  return (body.data || []).map((m) => m.id).filter(Boolean).sort();
}

const RETRIABLE = new Set([429, 500, 502, 503, 504]);

class ProxyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// One /v1/chat/completions call. Transient failures (rate limits, 5xx, a dropped connection) are retried with backoff;
// a rejected key or a bad request is not.
async function complete(root, config, body, { signal, fetch = config._fetch || globalThis.fetch, attempts = 4 } = {}) {
  const url = `${baseUrl(config)}/v1/chat/completions`;
  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: headers(root), body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt >= attempts) throw new ProxyError(null, `couldn't reach the LiteLLM proxy at ${baseUrl(config)} (${e.message})`);
      await sleep(attempt, signal);
      continue;
    }
    if (r.ok) {
      const cost = Number(r.headers.get('x-litellm-response-cost'));
      return { data: await r.json(), cost: Number.isFinite(cost) ? cost : 0 };
    }
    const text = (await r.text()).slice(0, 500);
    if (RETRIABLE.has(r.status) && attempt < attempts) { await sleep(attempt, signal); continue; }
    throw new ProxyError(r.status, proxyMessage(text) || `HTTP ${r.status}`);
  }
}

const sleep = (attempt, signal) => new Promise((ok) => {
  const t = setTimeout(ok, Math.min(30_000, 1000 * 2 ** attempt));
  signal?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
});

function proxyMessage(text) {
  try { return JSON.parse(text).error?.message || text; } catch { return text; }
}

function errorText(e) {
  if (e.status === 401 || e.status === 403) return 'the LiteLLM proxy rejected the key (check it in Settings)';
  if (e.status === 429) return 'rate limited by the LiteLLM proxy; the session will be retried';
  if (e.status === 400 || e.status === 404) return `bad request: ${e.message}`;
  if (e.status) return `LiteLLM proxy error ${e.status}: ${e.message}`;
  return e.message;
}

// One short call with no tools (quick replies, beat names): the text, the usage and what it cost.
export async function chatOnce(root, config, { system = null, prompt, maxTokens = 600, model = null }) {
  refuseReal('the LiteLLM proxy (chat)');
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  try {
    const { data, cost } = await complete(root, config, { model: model || config.model, messages, max_tokens: maxTokens, drop_params: true }, { attempts: 2 });
    return { text: data.choices?.[0]?.message?.content || '', model: data.model, usage: data.usage || {}, cost_usd: cost };
  } catch (e) {
    throw new Error(errorText(e));
  }
}

// An editor result can hold an image (the frame it was asked to view). Tool messages carry text only, so the picture
// follows as a user message the model sees on its next turn.
function toolMessages(callId, result) {
  if (typeof result.content === 'string') return { tool: { role: 'tool', tool_call_id: callId, content: result.content }, image: null };
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') || 'image';
  const img = parts.find((p) => p.type === 'image');
  const image = img ? { type: 'image_url', image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } } : null;
  return { tool: { role: 'tool', tool_call_id: callId, content: image ? `${text} (the image follows)` : text }, image: image ? { label: text, part: image } : null };
}

// Only the newest picture is kept in full: older ones become a line of text, so a long QC session doesn't resend
// every frame on every turn.
function dropOldImages(messages) {
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) {
      m.content = m.content.map((p) => (p.type === 'image_url' ? { type: 'text', text: '[a frame shown earlier]' } : p));
    }
  }
}

export async function run({ root, workdir, prompt, env, transcript, onActivity, signal, config }) {
  refuseReal('the LiteLLM backend');
  if (!config.model) return { ok: false, error: 'no model: pick one of the LiteLLM proxy\'s models in Settings', usage: { input_tokens: 0, output_tokens: 0 } };
  const work = realpathSync(workdir);
  const shell = new Shell(work, withPath({ ...process.env, ...env }, join(REPO, 'bin')));
  const out = createWriteStream(transcript, { flags: 'a' });
  const record = (obj) => out.write(JSON.stringify(obj) + '\n');
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let cost = 0;
  let continuations = 0;

  try {
    for (let turn = 0; turn < (config.maxTurns || 500); turn++) {
      if (signal?.aborted) return { ok: false, error: 'stopped', usage, cost_usd: cost };
      const { data, cost: callCost } = await complete(root, config, {
        model: config.model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: config.litellmMaxTokens || 16000,
        // The proxy drops parameters a model rejects instead of failing the call.
        drop_params: true,
      }, { signal });
      cost += callCost;
      usage.input_tokens += data.usage?.prompt_tokens || 0;
      usage.output_tokens += data.usage?.completion_tokens || 0;
      const choice = data.choices?.[0] || {};
      const msg = choice.message || {};
      record({ type: 'assistant', finish_reason: choice.finish_reason, model: data.model, message: msg, usage: data.usage, cost_usd: callCost });
      if (msg.content?.trim()) onActivity({ kind: 'text', text: msg.content });
      if (choice.finish_reason === 'content_filter') return { ok: false, error: 'the model declined to continue (content filter)', usage, cost_usd: cost };

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        if (choice.finish_reason === 'length' && continuations++ < 3) {
          messages.push({ role: 'assistant', content: msg.content || '' });
          messages.push({ role: 'user', content: 'Continue.' });
          continue;
        }
        return { ok: true, usage, cost_usd: cost, summary: String(msg.content || '').slice(-2000) };
      }
      if (choice.finish_reason === 'length') {
        // A tool call cut off mid-arguments: never run it. Ask for it again, smaller.
        messages.push({ role: 'assistant', content: msg.content || '' });
        messages.push({ role: 'user', content: 'Your last tool call was cut off by the output limit. Make it again in smaller pieces (e.g. write a long file in parts).' });
        continue;
      }

      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
      const images = [];
      const results = [];
      for (const call of calls) {
        if (signal?.aborted) break;
        let r;
        try {
          const input = JSON.parse(call.function?.arguments || '{}');
          if (call.function?.name === 'bash') r = await bashTool(shell, input, onActivity);
          else if (call.function?.name === 'str_replace_based_edit_tool') r = editorTool(work, input, onActivity);
          else r = { error: true, content: `unknown tool ${call.function?.name}` };
        } catch (e) {
          r = { error: true, content: e instanceof SyntaxError ? `the tool arguments weren't valid JSON: ${e.message}` : e.message };
        }
        if (r.error) onActivity({ kind: 'error', text: String(typeof r.content === 'string' ? r.content : 'error').slice(0, 400) });
        const { tool, image } = toolMessages(call.id, r);
        messages.push(tool);
        results.push({ tool_call_id: call.id, content: tool.content.slice(0, 20000), ...(r.error ? { is_error: true } : {}) });
        if (image) images.push(image);
      }
      record({ type: 'tool_results', results });
      if (signal?.aborted) return { ok: false, error: 'stopped', usage, cost_usd: cost };
      if (images.length) {
        dropOldImages(messages);
        messages.push({ role: 'user', content: images.flatMap((i) => [{ type: 'text', text: i.label }, i.part]) });
      }
    }
    return { ok: false, error: `stopped after ${config.maxTurns || 500} turns`, usage, cost_usd: cost };
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: 'stopped', usage, cost_usd: cost };
    return { ok: false, error: errorText(e), usage, cost_usd: cost };
  } finally {
    shell.close();
    out.end();
  }
}
