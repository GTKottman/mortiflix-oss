// Backend: the Claude API with your own Anthropic API key. Mortiflix runs the agent loop itself: a persistent bash
// shell in the project folder, a file editor confined to that folder (which can also *show* Claude the frames it
// rendered, for visual QC), and optionally web search + fetch. Long sessions stay inside the context window with
// server-side compaction; the stable prefix is prompt-cached.
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, statSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, extname, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { REPO, readSecret, isInside } from '../studio.mjs';
import { withPath, groupOptions, killTree, findGitBash, fromShellPath } from '../platform.mjs';

export const name = 'anthropic-api';
export const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `You are a production session in Mortiflix, a motion design studio that runs on one machine. You make
videos step by step through a pipeline for the studio's owner, one person who approves every reviewed step.

There is no human in this conversation. Nobody will answer if you ask here: the owner only sees what you send
with \`mfx\` (submissions, questions, status lines). So work on your own, keep going through setbacks, and stop only
at a gate, exactly as the project's CLAUDE.md and .mortiflix/GATES.md describe.

Your tools: \`bash\` runs in a persistent shell in the project folder (each command may take up to 10 minutes; heavy
renders go through \`mfx render\` + \`mfx render-wait\`), and the file editor reads and writes files in the project folder.
Viewing an image file with the editor shows you the picture: use it to check frames you render.

End your turn only after \`mfx handoff\`.`;

export function credentials(root) {
  const key = readSecret(root, 'anthropic_api_key') || process.env.ANTHROPIC_API_KEY || null;
  return { key, other: Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE) };
}

export function available(config, root) {
  const c = credentials(root);
  if (c.key || c.other) return { ok: true, detail: `Claude API (${config.model || DEFAULT_MODEL})` };
  return { ok: false, detail: 'no API key: add one in Settings, or set ANTHROPIC_API_KEY' };
}

export async function run({ root, workdir, prompt, env, transcript, onActivity, signal, config }) {
  const { key } = credentials(root);
  // `_fetch` is for tests: a fake API that streams scripted turns (no network, no cost).
  const client = new Anthropic({ ...(key ? { apiKey: key } : {}), maxRetries: 4, ...(config._fetch ? { fetch: config._fetch, apiKey: 'test' } : {}) });
  const model = config.model || DEFAULT_MODEL;
  const work = realpathSync(workdir);
  const shell = new Shell(work, withPath({ ...process.env, ...env }, join(REPO, 'bin')));
  const out = createWriteStream(transcript, { flags: 'a' });
  const record = (obj) => out.write(JSON.stringify(obj) + '\n');

  const tools = [
    { type: 'bash_20250124', name: 'bash' },
    { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
  ];
  if (config.webTools) {
    tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 25 });
    tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 25 });
  }
  const betas = ['compact-2026-01-12'];
  if (config.fallbacks) betas.push('server-side-fallback-2026-07-01');

  const brief = existsSync(join(work, 'CLAUDE.md')) ? readFileSync(join(work, 'CLAUDE.md'), 'utf8') : '';
  const messages = [{ role: 'user', content: `${brief}\n\n---\n\n${prompt}` }];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let continuations = 0;

  try {
    for (let turn = 0; turn < (config.maxTurns || 500); turn++) {
      if (signal?.aborted) return { ok: false, error: 'stopped', usage };
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        system: SYSTEM,
        tools,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: config.effort || 'high' },
        cache_control: { type: 'ephemeral' },
        context_management: { edits: [{ type: 'compact_20260112' }] },
        betas,
        ...(config.fallbacks ? { fallbacks: 'default' } : {}),
      }, { signal });
      const msg = await stream.finalMessage();
      usage.input_tokens += (msg.usage?.input_tokens || 0) + (msg.usage?.cache_read_input_tokens || 0) + (msg.usage?.cache_creation_input_tokens || 0);
      usage.output_tokens += msg.usage?.output_tokens || 0;
      record({ type: 'assistant', stop_reason: msg.stop_reason, model: msg.model, content: msg.content, usage: msg.usage });

      const content = afterFallback(msg.content);
      for (const b of content) if (b.type === 'text' && b.text.trim()) onActivity({ kind: 'text', text: b.text });

      if (msg.stop_reason === 'refusal') {
        return { ok: false, error: `Claude declined to continue (${msg.stop_details?.category || 'policy'})`, usage };
      }
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content }); continue; }

      const uses = content.filter((b) => b.type === 'tool_use');
      if (!uses.length) {
        if (msg.stop_reason === 'max_tokens' && continuations++ < 3) {
          messages.push({ role: 'assistant', content });
          messages.push({ role: 'user', content: 'Continue.' });
          continue;
        }
        return { ok: true, usage, summary: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').slice(-2000) };
      }
      if (msg.stop_reason === 'max_tokens') {
        // A tool call cut off mid-input: never run it. Ask for it again, smaller.
        messages.push({ role: 'assistant', content: content.filter((b) => b.type !== 'tool_use') });
        messages.push({ role: 'user', content: 'Your last tool call was cut off by the output limit. Make it again in smaller pieces (e.g. write a long file in parts).' });
        continue;
      }

      messages.push({ role: 'assistant', content });
      const results = [];
      for (const tu of uses) {
        if (signal?.aborted) break;
        let r;
        try {
          if (tu.name === 'bash') r = await bashTool(shell, tu.input, onActivity);
          else if (tu.name === 'str_replace_based_edit_tool') r = editorTool(work, tu.input, onActivity);
          else r = { error: true, content: `unknown tool ${tu.name}` };
        } catch (e) {
          r = { error: true, content: e.message };
        }
        if (r.error) onActivity({ kind: 'error', text: String(typeof r.content === 'string' ? r.content : 'error').slice(0, 400) });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.error ? { is_error: true } : {}) });
      }
      record({ type: 'tool_results', results: results.map((x) => ({ ...x, content: typeof x.content === 'string' ? x.content.slice(0, 20000) : '[image]' })) });
      if (signal?.aborted) return { ok: false, error: 'stopped', usage };
      messages.push({ role: 'user', content: results });
    }
    return { ok: false, error: `stopped after ${config.maxTurns || 500} turns`, usage };
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: 'stopped', usage };
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: 'the API key was rejected (check it in Settings)', usage };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, error: `the API refused this request: ${e.message}`, usage };
    if (e instanceof Anthropic.BadRequestError) return { ok: false, error: `bad request: ${e.message}`, usage };
    if (e instanceof Anthropic.RateLimitError) return { ok: false, error: 'rate limited by the API; the session will be retried', usage };
    if (e instanceof Anthropic.APIError) return { ok: false, error: `API error ${e.status ?? ''}: ${e.message}`, usage };
    return { ok: false, error: e.message, usage };
  } finally {
    shell.close();
    out.end();
  }
}

// After a refusal fallback mid-output, the blocks before the last fallback marker that belong to the declined
// attempt (thinking, tool calls, unpaired server tool calls) must not be sent back.
export function afterFallback(content) {
  const last = content.map((b) => b.type).lastIndexOf('fallback');
  if (last < 0) return content;
  const resultIds = new Set(content.filter((b) => b.type?.endsWith('_tool_result')).map((b) => b.tool_use_id));
  return content.filter((b, i) => {
    if (i >= last) return true;
    if (['thinking', 'redacted_thinking', 'tool_use'].includes(b.type)) return false;
    if (b.type === 'server_tool_use') return resultIds.has(b.id);
    return ['text', 'fallback', 'compaction'].includes(b.type) || b.type?.endsWith('_tool_result');
  });
}

// ---- bash: one persistent shell per session ----

export class Shell {
  constructor(cwd, env) {
    this.cwd = cwd;
    this.env = env;
    this.start();
  }

  start() {
    this.buf = '';
    this.dead = false;
    // On Windows the shell is Git for Windows' bash (the installer puts it there; mortiflix doctor checks it).
    const bash = process.platform === 'win32' ? findGitBash() || 'bash.exe' : 'bash';
    const p = spawn(bash, ['--noprofile', '--norc'], { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], ...groupOptions() });
    this.p = p;
    // Each handler acts only for its own process: a killed shell's late events must not touch its replacement.
    const mine = () => this.p === p;
    p.stdout.on('data', (d) => { if (mine()) { this.buf += d; this.wake?.(); } });
    p.stderr.on('data', (d) => { if (mine()) { this.buf += d; this.wake?.(); } });
    p.on('close', () => { if (mine()) { this.dead = true; this.wake?.(); } });
    p.stdin.on('error', () => {});
  }

  async run(command, timeoutMs = 600_000) {
    if (this.dead) this.start();
    const marker = `__MFX_${randomBytes(6).toString('hex')}__`;
    this.buf = '';
    // stdin from /dev/null: a command that reads input must not swallow the next command.
    this.p.stdin.write(`{\n${command}\n} </dev/null 2>&1\nprintf '\\n${marker}:%s\\n' "$?"\n`);
    const re = new RegExp(`\\n?${marker}:(\\d+)\\n`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = this.buf.match(re);
      if (m) return { output: this.buf.slice(0, m.index), code: Number(m[1]) };
      if (this.dead) { const output = this.buf; this.start(); return { output: `${output}\n(the shell exited; a new one was started in the project folder)`, code: 1 }; }
      if (Date.now() > deadline) {
        const output = this.buf;
        this.kill();
        this.start();
        return { output: `${output}\n(timed out after ${Math.round(timeoutMs / 1000)} s; the shell was restarted. Heavy renders: mfx render + mfx render-wait)`, code: 124 };
      }
      await new Promise((ok) => { this.wake = ok; setTimeout(ok, 200); });
      this.wake = null;
    }
  }

  kill() {
    killTree(this.p.pid, { signal: 'SIGKILL' });
  }

  close() {
    this.kill();
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

// ---- the file editor: confined to the project folder ----

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export function editorTool(work, input, onActivity = () => {}) {
  const { command } = input || {};
  const target = confine(work, input?.path);
  const rel = relative(work, target) || '.';
  if (command === 'view') {
    onActivity({ kind: 'tool', text: `View ${rel}` });
    if (!existsSync(target)) return { error: true, content: `${rel} doesn't exist` };
    if (statSync(target).isDirectory()) return { content: listDir(target, work) };
    const type = IMAGE_TYPES[extname(target).toLowerCase()];
    if (type) {
      const size = statSync(target).size;
      if (size > 5_000_000) return { error: true, content: `${rel} is ${Math.round(size / 1e6)} MB; make a smaller copy to look at (ffmpeg -i in.png -vf scale=1280:-1 small.png)` };
      return { content: [{ type: 'image', source: { type: 'base64', media_type: type, data: readFileSync(target).toString('base64') } }, { type: 'text', text: rel }] };
    }
    const buf = readFileSync(target);
    if (buf.includes(0)) return { error: true, content: `${rel} is a binary file; inspect it with bash (ffprobe, file, xxd)` };
    let lines = buf.toString('utf8').split('\n');
    let start = 1;
    if (Array.isArray(input.view_range) && input.view_range.length === 2) {
      const [a, b] = input.view_range;
      start = Math.max(1, a);
      lines = lines.slice(start - 1, b === -1 ? undefined : b);
    }
    return { content: clip(lines.map((l, i) => `${String(i + start).padStart(6)}\t${l}`).join('\n'), 60_000) };
  }
  if (command === 'create') {
    onActivity({ kind: 'tool', text: `Write ${rel}` });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(input.file_text ?? ''));
    return { content: `Wrote ${rel}` };
  }
  if (command === 'str_replace') {
    onActivity({ kind: 'tool', text: `Edit ${rel}` });
    if (!existsSync(target)) return { error: true, content: `${rel} doesn't exist` };
    const text = readFileSync(target, 'utf8');
    const old = String(input.old_str ?? '');
    const count = old ? text.split(old).length - 1 : 0;
    if (count !== 1) return { error: true, content: count ? `old_str appears ${count} times in ${rel}; include more context so it's unique` : `old_str wasn't found in ${rel}` };
    writeFileSync(target, text.replace(old, () => String(input.new_str ?? '')));
    return { content: `Edited ${rel}` };
  }
  if (command === 'insert') {
    onActivity({ kind: 'tool', text: `Edit ${rel}` });
    if (!existsSync(target)) return { error: true, content: `${rel} doesn't exist` };
    const lines = readFileSync(target, 'utf8').split('\n');
    const at = Number(input.insert_line);
    if (!Number.isInteger(at) || at < 0 || at > lines.length) return { error: true, content: `insert_line must be between 0 and ${lines.length}` };
    lines.splice(at, 0, String(input.insert_text ?? ''));
    writeFileSync(target, lines.join('\n'));
    return { content: `Inserted into ${rel} after line ${at}` };
  }
  return { error: true, content: `unknown editor command ${command}` };
}

// Resolve a model-supplied path and refuse anything outside the project folder (.., absolute paths, symlinks).
const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };

export function confine(work, path) {
  if (typeof path !== 'string' || !path) throw new Error('path is required');
  // Paths from the shell on Windows are Git Bash's (/c/Users/…): read them as the C:\Users\… they are.
  const abs = resolve(work, fromShellPath(path));
  // The nearest part of the path that's there, links included (a link to somewhere that doesn't exist is still
  // there: existsSync follows links and would skip past it, and a later mkdir or write would go where it points).
  let probe = abs;
  while (!present(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let real;
  try { real = realpathSync(probe); } catch { real = null; }
  if (!real || !isInside(work, real) || !isInside(work, abs)) throw new Error(`${path} is outside the project folder`);
  return abs;
}

function listDir(dir, work, depth = 0, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') && depth === 0 && name !== '.claude' && name !== '.mortiflix') continue;
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    const isDir = statSync(full).isDirectory();
    out.push(`${'  '.repeat(depth)}${relative(work, full)}${isDir ? '/' : ''}`);
    if (isDir && depth < 1) listDir(full, work, depth + 1, out);
    if (out.length > 400) { out.push('… (more)'); break; }
  }
  return out.join('\n') || '(empty)';
}

function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)}\n… (${text.length - max} characters cut) …\n${text.slice(-(max - head))}`;
}
