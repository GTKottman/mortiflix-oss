// Token usage per Claude run (owner, 2026-10-18: "list token usage … the end goal would allow the user or me to poke
// through the process and token-optimize the pipeline"). Every session the runner starts writes a transcript
// (sessions/<id>.jsonl); this reads it into:
//   runs  newest first, each with its raw tokens split into input, cache write, cache read and output
//   run   one run's calls grouped by what they did (bars, sorted by raw tokens), and what was pulled into the
//         context: each tool result's size and how many later calls carried it (cache reads are the context
//         re-read on every call, so a big early result costs again on every call after it)
//
// Two transcript shapes: Claude Code's stream-json (assistant lines repeat one message's usage per content
// block: counted once per message id) and the API backend's own records (one line per call, tool results in
// `tool_results` lines). Raw tokens for both: on a plan the dollars aren't charged, so tokens are the usage.
//
// Fast: a transcript is read once, then only the bytes added since (a running session grows), asynchronously, a chunk
// at a time, so a big first read never stops the service from answering. Kept per file:
// sizes and short labels, never the file contents read or the commands' output. Hostile input: run ids are
// checked, labels capped, keys and tokens in commands blanked.
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const RUN_ID = /^[0-9A-Za-z-]{8,64}$/;
const MAX_LABEL = 160;
const MAX_TEXT = 400;
const MAX_KEPT = 64; // transcripts kept parsed
const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024; // a line longer than this is skipped, never held
const IMAGE_TOKENS = 1600; // a picture in a tool result, about
const cache = new Map(); // path -> parsed state

// ---------------------------------------------------------------- labels

const SECRET = [
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gh[ousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/g, '…'],
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=…'],
  [/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1…'],
  [/(xi-api-key:\s*)[^\s"']+/gi, '$1…'],
];

export function redact(s) {
  let out = String(s ?? '');
  for (const [re, to] of SECRET) out = out.replace(re, to);
  return out;
}

const clip = (s, n = MAX_LABEL) => {
  const t = redact(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function shortPath(p, work) {
  const s = String(p || '');
  if (work && isAbsolute(s)) {
    const r = relative(work, s);
    if (!r.startsWith('..')) return r || '.';
  }
  const home = homedir();
  return home && s.startsWith(home) ? `~${s.slice(home.length)}` : s;
}

// The program a shell command runs: past `cd x &&`, env assignments and sudo-less wrappers.
function program(cmd) {
  const parts = String(cmd || '').split(/&&|\|\||;|\n/).map((x) => x.trim()).filter(Boolean);
  for (const part of parts) {
    const words = part.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const w = (words[0] || '').replace(/^.*\//, '');
    if (!w || ['cd', 'export', 'set', 'source', '.'].includes(w)) continue;
    if (['timeout', 'nice', 'env', 'time', 'xargs'].includes(w) && words[1]) return words.slice(1).find((x) => !/^-|^\d/.test(x))?.replace(/^.*\//, '') || w;
    return w;
  }
  return 'shell';
}

// What one tool call did: a label (what exactly), a group (what kind, for the bars) and where it read from.
export function describe(name, input = {}, work = '') {
  const n = String(name || '');
  const i = input && typeof input === 'object' ? input : {};
  if (n === 'Read') return { label: `Read ${shortPath(i.file_path, work)}`, group: 'Read files', from: shortPath(i.file_path, work) };
  if (n === 'Write') return { label: `Write ${shortPath(i.file_path, work)}`, group: 'Write files' };
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return { label: `Edit ${shortPath(i.file_path || i.notebook_path, work)}`, group: 'Edit files' };
  if (n === 'Bash' || n === 'bash') {
    const cmd = i.command ?? (i.restart ? '(restart)' : '');
    return { label: `$ ${cmd}`, group: `Run: ${program(cmd)}`, from: `$ ${cmd}` };
  }
  if (n === 'str_replace_based_edit_tool') {
    const p = shortPath(i.path, work);
    if (i.command === 'view') return { label: `Read ${p}`, group: 'Read files', from: p };
    return { label: `${i.command === 'create' ? 'Write' : 'Edit'} ${p}`, group: i.command === 'create' ? 'Write files' : 'Edit files' };
  }
  if (n === 'Grep') return { label: `Search files for “${i.pattern}”${i.path ? ` in ${shortPath(i.path, work)}` : ''}`, group: 'Search files', from: `grep ${i.pattern}` };
  if (n === 'Glob') return { label: `List files ${i.pattern}`, group: 'Search files', from: `glob ${i.pattern}` };
  if (n === 'WebSearch' || n === 'web_search') return { label: `Web search: ${i.query}`, group: 'Web search', from: `web search “${i.query}”` };
  if (n === 'WebFetch' || n === 'web_fetch') {
    let host = '';
    try { host = new URL(i.url).host; } catch { host = String(i.url || ''); }
    return { label: `Fetch ${i.url}`, group: 'Web pages', from: host };
  }
  if (n === 'Task' || n === 'Agent') return { label: `Helper agent: ${i.description || i.subagent_type || ''}`, group: 'Helper agents' };
  if (n === 'Skill') return { label: `Skill ${i.skill || i.command || ''}`, group: 'Skills', from: `skill ${i.skill || i.command || ''}` };
  if (n === 'ToolSearch') return { label: `Load tools: ${i.query || ''}`, group: 'Loading tools', from: 'tool list' };
  if (n.startsWith('mcp__')) {
    const [, server = '', tool = ''] = n.split('__');
    return { label: `${server}: ${tool}`, group: `Tool server: ${server}`, from: `${server} ${tool}` };
  }
  return { label: n || 'tool', group: n || 'Other tools' };
}

// ---------------------------------------------------------------- reading a transcript

function fresh(work) {
  return {
    offset: 0, ino: 0, size: 0, partial: '', work,
    backend: '', model: '', calls: [], byMessage: new Map(), tools: new Map(), results: [],
    // per thread: the main session ('main') and each helper agent (its Task tool call's id)
    last: new Map(), pending: new Map(), count: new Map(),
    // a transcript holds several Claude processes one after another (quick calls, then a session): each
    // `system/init` line starts a segment with its own main thread, so a session's start-up context is never
    // booked to the quick call before it
    segs: [], mainThread: 'main',
    cost: null, ended: null, thinking: 0, outputTotal: null, wroteMs: 0,
  };
}

const isMain = (thread) => thread === 'main' || String(thread).startsWith('main#');

function startSeg(st, init = {}) {
  const tools = Array.isArray(init.tools) ? init.tools.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean).map((t) => clip(t, 40)).slice(0, 40) : [];
  const session = tools.some((t) => ['Bash', 'Task', 'Agent', 'Edit', 'Write'].includes(t));
  const seg = { idx: st.segs.length, thread: st.segs.length ? `main#${st.segs.length}` : 'main', kind: session ? 'session' : 'quick', tools, model: init.model ? String(init.model) : '', outputTotal: null, mainWrote: null, ended: false, cost: null };
  st.segs.push(seg);
  st.mainThread = seg.thread;
  return seg;
}

const segOf = (st) => st.segs[st.segs.length - 1] || startSeg(st);

const n0 = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join(' ');
}

function newCall(st, thread, model, usage, content) {
  const seq = st.count.get(thread) || 0;
  st.count.set(thread, seq + 1);
  const call = { thread, seq, seg: segOf(st).idx, model: String(model || ''), input: 0, cacheWrite: 0, cacheRead: 0, output: 0, wrote: st.thinking * 4, tools: [], why: '' };
  st.thinking = 0;
  setUsage(call, usage);
  st.calls.push(call);
  if (model && isMain(thread)) { st.model = String(model); st.segs[call.seg].model = String(model); }
  // what was added to this thread's context since its last call: the results waiting, sized by how much the
  // context grew (less what the last call wrote itself)
  const prev = st.last.get(thread);
  const pending = st.pending.get(thread) || [];
  if (pending.length) {
    const grew = prev ? ctx(call) - ctx(prev) - outputOf(st, prev) : 0;
    const chars = pending.reduce((a, r) => a + r.chars, 0) || 1;
    for (const r of pending) {
      r.tokens = grew > 0 ? Math.round((grew * r.chars) / chars) : r.estimate;
      r.after = seq; // carried by this call and every later one in its thread
    }
    st.pending.set(thread, []);
  }
  st.last.set(thread, call);
  addContent(st, call, content);
  return call;
}

function setUsage(call, u = {}) {
  call.input = Math.max(call.input, n0(u.input_tokens));
  call.cacheWrite = Math.max(call.cacheWrite, n0(u.cache_creation_input_tokens));
  call.cacheRead = Math.max(call.cacheRead, n0(u.cache_read_input_tokens));
  call.output = Math.max(call.output, n0(u.output_tokens));
}

const ctx = (c) => c.input + c.cacheWrite + c.cacheRead;

// A call's output tokens. The API backend's are exact. Claude Code's stream only carries a placeholder count
// per message, so its calls are sized by what they wrote (text, tool inputs, thinking) and scaled to the run's
// exact total once the run has ended.
function outputOf(st, c) {
  if (st.backend !== 'claude-code') return c.output;
  const est = Math.max(c.output, Math.ceil(c.wrote / 4));
  // Claude Code's total covers the main session only: helper agents keep their own estimate
  if (!isMain(c.thread)) return est;
  // Every segment ended: each is scaled to its own exact total. Some interrupted (no total of their own): the
  // exact totals of the rest are spread over all main calls of the run, so the run still adds up to what Claude Code reported.
  const all = st.segs.every((g) => g.ended);
  const key = all ? c.seg : -1;
  const total = all ? st.segs[c.seg]?.outputTotal : st.segs.reduce((a, g) => a + (g.outputTotal || 0), 0);
  if (!total) return est;
  const seg = st.segs[c.seg];
  const memo = all ? seg : st;
  if (memo.mainWrote == null) memo.mainWrote = st.calls.reduce((a, x) => a + ((all ? x.seg === key : true) && isMain(x.thread) ? Math.max(x.output, Math.ceil(x.wrote / 4)) : 0), 0) || 1;
  return Math.round((est * total) / memo.mainWrote);
}

function addContent(st, call, content) {
  if (!Array.isArray(content)) return;
  st.mainWrote = null;
  if (st.segs[call.seg]) st.segs[call.seg].mainWrote = null;
  for (const b of content) {
    if (b?.type === 'text') call.wrote += String(b.text || '').length;
    else if (b?.type === 'tool_use' || b?.type === 'server_tool_use') call.wrote += JSON.stringify(b.input ?? '').length;
    else if (b?.type === 'thinking') call.wrote += String(b.thinking || '').length;
  }
  if (!call.why) {
    const t = textOf(content).trim();
    if (t) call.why = clip(t, MAX_TEXT);
  }
  for (const b of content) {
    if (b?.type !== 'tool_use' && b?.type !== 'server_tool_use') continue;
    const d = describe(b.name, b.input, st.work);
    const tool = { label: clip(d.label), group: clip(d.group, 60), from: d.from ? clip(d.from) : '' };
    call.tools.push(tool);
    if (b.id) st.tools.set(String(b.id), tool);
  }
}

function resultChars(content) {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  if (!Array.isArray(content)) return { chars: JSON.stringify(content ?? '').length, images: 0 };
  let chars = 0;
  let images = 0;
  for (const b of content) {
    if (b?.type === 'image') images += 1;
    else if (typeof b?.text === 'string') chars += b.text.length;
    else chars += JSON.stringify(b ?? '').length;
  }
  return { chars, images };
}

function addResult(st, thread, toolUseId, content) {
  const tool = st.tools.get(String(toolUseId)) || { label: 'a tool result', group: 'Other tools', from: '' };
  const { chars, images } = resultChars(content);
  const r = { label: tool.label, group: tool.group, from: tool.from, chars: chars + images * IMAGE_TOKENS * 4, estimate: Math.ceil(chars / 4) + images * IMAGE_TOKENS, tokens: 0, after: -1 };
  r.tokens = r.estimate;
  r.thread = thread;
  st.results.push(r);
  if (!st.pending.has(thread)) st.pending.set(thread, []);
  st.pending.get(thread).push(r);
}

function line(st, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.type === 'system' && m.subtype === 'init') { st.backend = 'claude-code'; if (m.model) st.model = String(m.model); startSeg(st, m); return; }
  if (m.type === 'system' && m.subtype === 'thinking_tokens') { st.thinking += n0(m.estimated_tokens_delta); return; }
  if (m.type === 'assistant' && m.message && typeof m.message === 'object') {
    // Claude Code: one line per content block, the same message id and usage on each
    st.backend ||= 'claude-code';
    const thread = m.parent_tool_use_id ? String(m.parent_tool_use_id) : st.mainThread;
    const id = String(m.message.id || '');
    const known = id && st.byMessage.get(id);
    if (known) {
      setUsage(known, m.message.usage);
      addContent(st, known, m.message.content);
    } else {
      const call = newCall(st, thread, m.message.model, m.message.usage, m.message.content);
      if (id) st.byMessage.set(id, call);
    }
    return;
  }
  if (m.type === 'assistant' && !('message' in m) && (m.usage || Array.isArray(m.content))) {
    st.backend ||= 'anthropic-api';
    newCall(st, st.mainThread, m.model, m.usage, m.content);
    return;
  }
  if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
    const thread = m.parent_tool_use_id ? String(m.parent_tool_use_id) : st.mainThread;
    for (const b of m.message.content) if (b?.type === 'tool_result') addResult(st, thread, b.tool_use_id, b.content);
    return;
  }
  if (m.type === 'tool_results' && Array.isArray(m.results)) {
    for (const b of m.results) addResult(st, st.mainThread, b?.tool_use_id, b?.content);
    return;
  }
  if (m.type === 'result') {
    // each Claude process reports its own total: the run's cost is the sum over its processes (the largest report per
    // process, so a process that reports a running total is not counted twice)
    if (m.total_cost_usd != null && Number.isFinite(Number(m.total_cost_usd))) {
      const seg = segOf(st);
      seg.cost = Math.max(seg.cost ?? 0, Number(m.total_cost_usd));
      st.cost = st.segs.reduce((a, g) => (g.cost == null ? a : (a ?? 0) + g.cost), null);
    }
    if (m.usage && Number.isFinite(Number(m.usage.output_tokens))) {
      const seg = segOf(st);
      seg.outputTotal = (seg.outputTotal || 0) + Number(m.usage.output_tokens);
      seg.mainWrote = null;
      st.mainWrote = null;
    }
    segOf(st).ended = true;
    st.ended = true;
  }
}

// Read what was added to a transcript since last time (all of it the first time, or when it was replaced).
// Asynchronous (fs.promises FileHandle.read): each chunk is an I/O callback, so the service answers other requests
// between chunks. One read per file at a time: a second caller waits for the first, then reads only what is new.
const reading = new Map(); // path -> Promise of the read in progress
function read(file, work) {
  const p = (reading.get(file) || Promise.resolve()).catch(() => {}).then(() => readNow(file, work));
  reading.set(file, p);
  p.then(() => {}, () => {}).then(() => { if (reading.get(file) === p) reading.delete(file); });
  return p;
}

async function readNow(file, work) {
  let st = cache.get(file);
  const fh = await open(file, 'r');
  try {
    const s = await fh.stat();
    if (!st || s.ino !== st.ino || s.size < st.offset) st = fresh(work);
    st.ino = s.ino;
    st.mtimeMs = s.mtimeMs;
    if (st.offset < s.size) st.wroteMs = s.mtimeMs; // the last time lines were added (a later touch alone does not move it)
    const buf = Buffer.allocUnsafe(CHUNK);
    while (st.offset < s.size) {
      const { bytesRead: got } = await fh.read(buf, 0, Math.min(CHUNK, s.size - st.offset), st.offset);
      if (got <= 0) break;
      st.offset += got;
      const text = st.partial + buf.toString('utf8', 0, got);
      const lines = text.split('\n');
      st.partial = lines.pop() ?? '';
      if (st.partial.length > MAX_LINE) st.partial = ''; // never hold a runaway line
      for (const l of lines) if (l.trim()) line(st, l);
    }
    st.size = s.size;
  } finally {
    await fh.close();
  }
  cache.delete(file);
  cache.set(file, st);
  while (cache.size > MAX_KEPT) cache.delete(cache.keys().next().value);
  return st;
}

// ---------------------------------------------------------------- what the app asks for

function sessionsDir(root, projectId) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,120}$/.test(projectId) || projectId.includes('..')) throw new Error('bad project id');
  return join(root, 'state', projectId, 'sessions');
}

function totals(st) {
  const t = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
  for (const c of st.calls) {
    t.input += c.input;
    t.cache_write += c.cacheWrite;
    t.cache_read += c.cacheRead;
    t.output += outputOf(st, c);
  }
  t.total = t.input + t.cache_write + t.cache_read + t.output;
  return t;
}

// The reason the runner gave for the session (its activity log's first line), e.g. "Carrying on: …".
function reasonOf(dir, id) {
  const f = join(dir, `${id}.activity.jsonl`);
  if (!existsSync(f)) return '';
  try {
    const fd = openSync(f, 'r');
    const buf = Buffer.alloc(4096);
    const got = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    for (const l of buf.toString('utf8', 0, got).split('\n')) {
      try {
        const a = JSON.parse(l);
        if (a.kind === 'info' && /^Session started/.test(a.text || '')) return clip(String(a.text).replace(/^Session started \([^)]*\)\.\s*/, ''), 240);
      } catch { /* a cut line */ }
    }
  } catch { /* unreadable: no reason */ }
  return '';
}

function startedAt(id) {
  // ids are ISO times with : and . made into - (runner.mjs)
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

/** Every Claude run of a project, newest first, with its tokens. Async (the transcripts are read in chunks). */
export async function tokenRuns(root, projectId, { running = null, limit = 200 } = {}) {
  const dir = sessionsDir(root, projectId);
  if (!existsSync(dir)) return { runs: [] };
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.activity.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((id) => RUN_ID.test(id))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
  const runs = [];
  for (const id of ids) {
    const file = join(dir, `${id}.jsonl`);
    let st;
    try { st = await read(file, join(root, 'projects', projectId)); } catch { continue; }
    runs.push(summary(dir, id, st, running));
  }
  return { runs };
}

/** What one run's transcript says it used, as the runner books it (input incl. cache, output), and how many Claude
 *  processes in it were interrupted. `fresh_tokens`: input + cache writes + output, cache reads left out (the token
 *  coin's "fresh tokens"; the runner's token cap counts these). Resolves to null when there is no transcript. Never rejects. */
export async function runUsage(root, projectId, runId) {
  try {
    const id = String(runId || '');
    if (!RUN_ID.test(id)) return null;
    const file = join(sessionsDir(root, projectId), `${id}.jsonl`);
    if (!existsSync(file)) return null;
    const st = await read(file, join(root, 'projects', projectId));
    const t = totals(st);
    const segs = segments(st, null, id);
    return { input_tokens: t.input + t.cache_write + t.cache_read, output_tokens: t.output, fresh_tokens: t.input + t.cache_write + t.output, interrupted: segs.filter((g) => g.interrupted).length };
  } catch { return null; }
}

// "claude-sonnet-5-5" -> "Sonnet 5.5"; other ids as they are. One run can use several models (a cheaper one for reviews
// and fixes, src/models.mjs; Claude Code's own helper calls): the split shows which did what.
export function modelName(id) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(String(id || ''));
  if (!m) return String(id || '') || 'Claude';
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`;
}

function byModel(st, calls) {
  const g = new Map();
  for (const c of calls) {
    const name = modelName(c.model || st.model);
    const x = g.get(name) || { model: name, calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0 };
    x.calls += 1; x.input += c.input; x.cache_write += c.cacheWrite; x.cache_read += c.cacheRead; x.output += outputOf(st, c);
    g.set(name, x);
  }
  return [...g.values()].map((x) => ({ ...x, total: x.input + x.cache_write + x.cache_read + x.output })).sort((a, b) => b.total - a.total);
}

// Each Claude process in the transcript on its own: quick call or session, with its tokens by kind. A segment with
// no result line was interrupted (stopped, crashed, or still running).
function segments(st, running, id) {
  return st.segs.map((g) => {
    const calls = st.calls.filter((c) => c.seg === g.idx);
    const t = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
    for (const c of calls) { t.input += c.input; t.cache_write += c.cacheWrite; t.cache_read += c.cacheRead; t.output += outputOf(st, c); }
    return {
      n: g.idx + 1, kind: g.kind, label: g.kind === 'session' ? 'Session' : `Quick call (${g.tools.join(', ') || 'no tools'})`,
      model: modelName(g.model || st.model), calls: calls.length, ...t, total: t.input + t.cache_write + t.cache_read + t.output,
      interrupted: !g.ended && running !== id,
    };
  });
}

function summary(dir, id, st, running) {
  const models = byModel(st, st.calls);
  const segs = segments(st, running, id);
  return {
    id,
    started: startedAt(id),
    // when lines were last added (not the file's mtime: a later touch is not the end); none while it runs
    ended: running !== id && st.wroteMs ? new Date(st.wroteMs).toISOString() : null,
    running: running === id,
    backend: st.backend || 'claude-code',
    model: models.map((m) => m.model).join(' + ') || modelName(st.model),
    models,
    calls: st.calls.length,
    cost_usd: st.cost,
    why: reasonOf(dir, id),
    segments: segs,
    interrupted: segs.filter((g) => g.interrupted).length,
    ...totals(st),
  };
}

/** One run in detail: bars by what the calls did, and what was pulled into the context. Async, like tokenRuns. */
export async function tokenRun(root, projectId, runId, { running = null, bars: maxBars = 60, pulled: maxPulled = 40 } = {}) {
  const id = String(runId || '');
  if (!RUN_ID.test(id)) throw new Error('bad run id');
  const dir = sessionsDir(root, projectId);
  const file = join(dir, `${id}.jsonl`);
  if (!existsSync(file)) throw new Error(`no run ${id}`);
  const st = await read(file, join(root, 'projects', projectId));

  // bars: calls grouped by what they did (a call doing several things counts under its first)
  const groups = new Map();
  for (const c of st.calls) {
    const agent = c.thread !== 'main' ? st.tools.get(c.thread) : null;
    const key = agent ? clip(agent.label, 80) : c.tools[0]?.group || 'Thinking and answering (no tool)';
    let g = groups.get(key);
    if (!g) {
      g = { key, calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, examples: new Map(), why: '', models: new Set() };
      groups.set(key, g);
    }
    g.calls += 1;
    g.models.add(modelName(c.model || st.model));
    g.input += c.input;
    g.cache_write += c.cacheWrite;
    g.cache_read += c.cacheRead;
    g.output += outputOf(st, c);
    for (const t of c.tools) g.examples.set(t.label, (g.examples.get(t.label) || 0) + 1);
    if (!g.why && c.why) g.why = c.why;
  }
  const bars = [...groups.values()]
    .map((g) => ({
      key: g.key,
      calls: g.calls,
      input: g.input,
      cache_write: g.cache_write,
      cache_read: g.cache_read,
      output: g.output,
      total: g.input + g.cache_write + g.cache_read + g.output,
      examples: [...g.examples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, times]) => ({ label, times })),
      why: g.why,
      models: [...g.models],
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, Math.max(1, Math.min(500, Number(maxBars) || 60)));

  // pulled into the context: each result's tokens, and how many calls re-read it after
  const pulled = st.results
    .map((r) => {
      const carriedBy = r.after >= 0 ? (st.count.get(r.thread) || 0) - r.after : 0;
      return { label: r.label, group: r.group, from: r.from, tokens: r.tokens, calls_after: carriedBy, carried: r.tokens * carriedBy };
    })
    .sort((a, b) => b.carried - a.carried || b.tokens - a.tokens)
    .slice(0, Math.max(1, Math.min(500, Number(maxPulled) || 40)));

  return { run: summary(dir, id, st, running), bars, pulled };
}

// for tests
export function _forget() {
  cache.clear();
  reading.clear();
}
