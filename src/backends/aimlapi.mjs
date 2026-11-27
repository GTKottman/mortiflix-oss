// Backend: AI/ML API (aimlapi.com) with your own AI/ML API key. One key reaches Claude, GPT, Gemini and other chat
// models through an OpenAI-compatible API, so Mortiflix runs the agent loop itself, like the Claude API backend: the
// same persistent bash shell and the same file editor confined to the project folder (which can also *show* the model
// the frames it rendered). Anthropic's server tools (web search, compaction, refusal fallbacks) don't exist on the
// chat completions API, so those settings don't apply here.
import { refuseReal } from '../replay.mjs';
import { createWriteStream, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, readSecret } from '../studio.mjs';
import { withPath } from '../platform.mjs';
import { Shell, editorTool } from './anthropic-api.mjs';

export const name = 'aimlapi';
export const API_BASE = 'https://api.aimlapi.com/v1';
export const API_HOST = 'api.aimlapi.com';
// From the live catalog (GET /v1/models?include=all, type openai/chat-completions): tools, vision and streaming.
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

const SYSTEM = `You are a production session in Mortiflix, a motion design studio that runs on one machine. You make
videos step by step through a pipeline for the studio's owner, one person who approves every reviewed step.

There is no human in this conversation. Nobody will answer if you ask here: the owner only sees what you send
with \`mfx\` (submissions, questions, status lines). So work on your own, keep going through setbacks, and stop only
at a gate, exactly as the project's CLAUDE.md and .mortiflix/GATES.md describe.

Your tools: \`bash\` runs in a persistent shell in the project folder (each command may take up to 10 minutes; heavy
renders go through \`mfx render\` + \`mfx render-wait\`), and \`str_replace_based_edit_tool\` reads and writes files in
the project folder. Viewing an image file with the editor shows you the picture: use it to check frames you render.

End your turn only after \`mfx handoff\`.`;

// The two tools of the Claude API backend, described as functions (the chat completions API has no built-in ones).
export const TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'Run a command in a persistent bash shell in the project folder. The working directory and exported variables persist between calls. Set restart to true to start a fresh shell.', parameters: { type: 'object', properties: { command: { type: 'string' }, restart: { type: 'boolean' } } } } },
  { type: 'function', function: { name: 'str_replace_based_edit_tool', description: 'View, create and edit files in the project folder. view: a file (with line numbers, optional view_range [start, end]), a folder listing, or an image (you see the picture). create: write file_text. str_replace: replace old_str (must appear once) with new_str. insert: put insert_text after line insert_line.', parameters: { type: 'object', properties: { command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] }, path: { type: 'string' }, file_text: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' }, insert_line: { type: 'integer' }, insert_text: { type: 'string' }, view_range: { type: 'array', items: { type: 'integer' } } }, required: ['command', 'path'] } } },
];

export function credentials(root) {
  return { key: readSecret(root, 'aimlapi_api_key') || process.env.AIMLAPI_API_KEY || null };
}

export function available(config, root) {
  if (credentials(root).key) return { ok: true, detail: `AI/ML API (${config.model || DEFAULT_MODEL})` };
  return { ok: false, detail: 'no AI/ML API key: add one in Settings, or set AIMLAPI_API_KEY' };
}

export class AimlApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// One call to the API. The key goes only to https://api.aimlapi.com: any other URL is refused before a request is made,
// and redirects are not followed (a redirect would carry the Authorization header to wherever it points).
export async function request(key, path, { method = 'GET', body, signal, fetch = globalThis.fetch } = {}) {
  const url = new URL(`${API_BASE}${path}`);
  if (url.protocol !== 'https:' || url.hostname !== API_HOST) throw new AimlApiError(0, `refusing to send the AI/ML API key to ${url.host}`);
  const res = await fetch(url.href, {
    method,
    redirect: 'manual',
    signal,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status >= 300 && res.status < 400) throw new AimlApiError(res.status, `the AI/ML API answered with a redirect (${res.status}); not followed`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || text; } catch { /* plain text */ }
    throw new AimlApiError(res.status, String(msg || res.statusText || 'error').slice(0, 500));
  }
  return res.json();
}

// chat/completions with a few retries on rate limits and server errors (like the Anthropic SDK's maxRetries).
export async function chat(key, body, { signal, fetch, retries = 4, delayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(key, '/chat/completions', { method: 'POST', body, signal, fetch });
    } catch (e) {
      const again = e instanceof AimlApiError && (e.status === 429 || e.status >= 500) && attempt < retries && !signal?.aborted;
      if (!again) throw e;
      await new Promise((ok) => setTimeout(ok, delayMs * 2 ** attempt));
    }
  }
}

// One short answer with no tools (chat replies, beat names, "Improve my brief"), shaped like a Claude API message so
// the usage ledger books it the same way.
export async function quickMessage(root, { model, system, prompt, maxTokens, fetch } = {}) {
  const { key } = credentials(root);
  if (!key) throw new Error('no AI/ML API key: add one in Settings › Keys, or set AIMLAPI_API_KEY');
  refuseReal('AI/ML API (chat)');
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  const r = await chat(key, { model: model || DEFAULT_MODEL, max_tokens: maxTokens, messages }, { fetch, retries: 1 });
  return { model: r.model || model || DEFAULT_MODEL, text: String(r.choices?.[0]?.message?.content || ''), usage: usageOf(r) };
}

const usageOf = (r) => ({ input_tokens: r?.usage?.prompt_tokens || 0, output_tokens: r?.usage?.completion_tokens || 0 });

// An editor result as chat messages: text goes in the tool message; a picture follows as a user message, since tool
// messages carry text only on most models.
function toolMessages(id, r) {
  if (typeof r.content === 'string') return [{ role: 'tool', tool_call_id: id, content: r.error ? `Error: ${r.content}` : r.content }];
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = r.content.filter((b) => b.type === 'image').map((b) => ({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }));
  return [
    { role: 'tool', tool_call_id: id, content: `${text || 'image'} (the picture follows)` },
    { role: 'user', content: [{ type: 'text', text: `The picture from viewing ${text}:` }, ...images] },
  ];
}

export async function run({ root, workdir, prompt, env, transcript, onActivity, signal, config }) {
  refuseReal('the AI/ML API backend');
  // `_fetch` is for tests: a fake API that answers scripted turns (no network, no cost).
  const key = config._fetch ? 'test' : credentials(root).key;
  const model = config.model || DEFAULT_MODEL;
  const work = realpathSync(workdir);
  const shell = new Shell(work, withPath({ ...process.env, ...env }, join(REPO, 'bin')));
  const out = createWriteStream(transcript, { flags: 'a' });
  const record = (obj) => out.write(JSON.stringify(obj) + '\n');
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let continuations = 0;

  try {
    if (!key) return { ok: false, error: 'no AI/ML API key: add one in Settings, or set AIMLAPI_API_KEY', usage };
    for (let turn = 0; turn < (config.maxTurns || 500); turn++) {
      if (signal?.aborted) return { ok: false, error: 'stopped', usage };
      const r = await chat(key, { model, max_tokens: 32000, messages, tools: TOOLS }, { signal, fetch: config._fetch });
      const u = usageOf(r);
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      const choice = r.choices?.[0] || {};
      const msg = choice.message || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const text = typeof msg.content === 'string' ? msg.content : '';
      // Recorded in the Claude API backend's shape, so the session's token accounting reads it the same way.
      record({ type: 'assistant', stop_reason: choice.finish_reason, model: r.model || model, usage: u,
        content: [...(text ? [{ type: 'text', text }] : []), ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.function?.name, input: c.function?.arguments }))] });
      if (text.trim()) onActivity({ kind: 'text', text });

      if (!calls.length) {
        if (choice.finish_reason === 'length' && continuations++ < 3) {
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: 'Continue.' });
          continue;
        }
        if (choice.finish_reason === 'content_filter') return { ok: false, error: 'the model declined to continue (content filter)', usage };
        return { ok: true, usage, summary: text.slice(-2000) };
      }
      if (choice.finish_reason === 'length') {
        // A tool call cut off mid-arguments: never run it. Ask for it again, smaller.
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: 'Your last tool call was cut off by the output limit. Make it again in smaller pieces (e.g. write a long file in parts).' });
        continue;
      }

      messages.push({ role: 'assistant', content: text || null, tool_calls: calls });
      const results = [];
      for (const c of calls) {
        if (signal?.aborted) break;
        let r2;
        try {
          const input = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
          if (c.function?.name === 'bash') r2 = await bashTool(shell, input, onActivity);
          else if (c.function?.name === 'str_replace_based_edit_tool') r2 = editorTool(work, input, onActivity);
          else r2 = { error: true, content: `unknown tool ${c.function?.name}` };
        } catch (e) {
          r2 = { error: true, content: e.message };
        }
        if (r2.error) onActivity({ kind: 'error', text: String(typeof r2.content === 'string' ? r2.content : 'error').slice(0, 400) });
        results.push({ id: c.id, r: r2 });
      }
      record({ type: 'tool_results', results: results.map(({ id, r: x }) => ({ type: 'tool_result', tool_use_id: id, content: typeof x.content === 'string' ? x.content.slice(0, 20000) : '[image]', ...(x.error ? { is_error: true } : {}) })) });
      if (signal?.aborted) return { ok: false, error: 'stopped', usage };
      // Tool messages first (every call answered, in order), then any pictures.
      const after = results.map(({ id, r: x }) => toolMessages(id, x));
      messages.push(...after.map((m) => m[0]), ...after.flatMap((m) => m.slice(1)));
    }
    return { ok: false, error: `stopped after ${config.maxTurns || 500} turns`, usage };
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: 'stopped', usage };
    if (e instanceof AimlApiError) {
      if (e.status === 401) return { ok: false, error: 'the AI/ML API key was rejected (check it in Settings)', usage };
      if (e.status === 403) return { ok: false, error: `the AI/ML API refused this request: ${e.message}`, usage };
      if (e.status === 400) return { ok: false, error: `bad request: ${e.message}`, usage };
      if (e.status === 429) return { ok: false, error: 'rate limited by the AI/ML API; the session will be retried', usage };
      return { ok: false, error: `AI/ML API error ${e.status || ''}: ${e.message}`, usage };
    }
    return { ok: false, error: e.message, usage };
  } finally {
    shell.close();
    out.end();
  }
}

async function bashTool(shell, input, onActivity) {
  if (input?.restart) { shell.kill(); shell.start(); return { content: 'The shell was restarted.' }; }
  const command = String(input?.command || '');
  if (!command.trim()) return { error: true, content: 'empty command' };
  onActivity({ kind: 'tool', text: `$ ${command.split('\n')[0].slice(0, 200)}` });
  const { output, code } = await shell.run(command);
  const text = clip(output.replace(/\s+$/, ''), 30_000);
  return { content: `${text || '(no output)'}${code ? `\n(exit code ${code})` : ''}`, error: code !== 0 && !text };
}

function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)}\n… (${text.length - max} characters cut) …\n${text.slice(-(max - head))}`;
}
