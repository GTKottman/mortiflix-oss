// The usage ledger (owner, 2026-11-02: "the token counter should count as many things as possible. Claude tokens and 11 lab
// credits. And there should be as much detail as we can give. So per day, per project, per week, month, high score").
// One append-only JSONL in the studio's state folder (<studio>/state/usage-ledger.jsonl), one row per spend:
//   { id?, at, project|null, stage|null, provider: 'claude'|'elevenlabs', kind, model|null, role?,
//     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,   (Claude; input = fresh input only)
//     credits,                                                              (ElevenLabs)
//     calls?, ok }
// No dollars anywhere (owner, 2026-11-02): Claude is counted in tokens, ElevenLabs in credits.
// Rows with an `id` are never booked twice (a backfill and a live booking of the same session are the same row).
// usage.get (usageGet) turns the rows into totals, splits, a daily series, records and the ElevenLabs balance.
import { replayOn } from '../replay.mjs';
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { paths, writeJson } from '../studio.mjs';
import { projectPaths, loadProject, projectPipeline } from '../projects.mjs';
import { stepView } from '../gates.mjs';
import { stageSet, stageOf } from './stages.mjs';
import { voiceRows } from '../voiceusage.mjs';
import { elevenKey, voiceConfig } from '../voice/index.mjs';
import { SERVERS } from '../voice/elevenlabs.mjs';

export const BALANCE_TTL_MS = 10 * 60_000;
const RUN_ID = /^[0-9A-Za-z-]{8,64}$/;
const RUNNING_GRACE_MS = 120_000; // a transcript touched this recently may still be running: not backfilled

export const ledgerFile = (root) => join(paths(root).state, 'usage-ledger.jsonl');
const markerFile = (root) => join(paths(root).state, 'usage-ledger.backfilled');
const balanceFile = (root) => join(paths(root).state, 'usage-balance.json');

const n0 = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- reading and writing

const caches = new Map(); // ledger file -> { size, mtimeMs, rows, ids }
const listeners = new Set(); // (root, row) => void

// The file only grows (rows are appended), so a known cache reads just the bytes added since (another process's
// rows), up to the last complete line; a file that shrank was replaced and is read again from the start.
function load(root) {
  const file = ledgerFile(root);
  let c = caches.get(file);
  const st = existsSync(file) ? statSync(file) : null;
  if (!st) { c = { size: 0, rows: [], ids: new Set() }; caches.set(file, c); return c; }
  if (c && c.size === st.size) return c;
  if (!c || st.size < c.size) c = { size: 0, rows: [], ids: new Set() };
  const buf = Buffer.alloc(st.size - c.size);
  const fd = openSync(file, 'r');
  let got = 0;
  try { while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, c.size + got); if (!n) break; got += n; } } finally { closeSync(fd); }
  const end = buf.lastIndexOf(0x0a, got - 1) + 1; // a line still being written by another process is read next time
  for (const l of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); c.rows.push(r); if (r.id) c.ids.add(r.id); } catch { /* a cut line */ }
  }
  c.size += end;
  caches.set(file, c);
  return c;
}

export function readRows(root) {
  return load(root).rows;
}

/** Subscribe to every new row booked in this process (any studio). Returns an unsubscribe function. */
export function onRow(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A row's time as ISO text; a missing or unreadable time (an old log row with a bad `t`) becomes now, so one bad row can
// never throw (toISOString throws RangeError on an invalid date) and stop the ledger.
const isoOr = (at) => { const d = at ? new Date(at) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString(); };

function normalize(row) {
  const provider = row.provider === 'elevenlabs' ? 'elevenlabs' : 'claude';
  const out = {
    ...(row.id ? { id: String(row.id) } : {}),
    at: isoOr(row.at),
    project: row.project || null,
    stage: row.stage || null,
    provider,
    kind: String(row.kind || (provider === 'claude' ? 'call' : 'audio')),
    model: row.model ? String(row.model) : null,
    ...(row.role ? { role: String(row.role) } : {}),
  };
  if (provider === 'claude') {
    out.input_tokens = n0(row.input_tokens);
    out.output_tokens = n0(row.output_tokens);
    out.cache_read_tokens = n0(row.cache_read_tokens);
    out.cache_write_tokens = n0(row.cache_write_tokens);
    if (row.calls !== undefined) out.calls = n0(row.calls);
  } else {
    out.credits = n0(row.credits);
    if (row.estimated) out.estimated = true;
    if (row.credits_unknown) out.credits_unknown = true;
    if (row.seconds) out.seconds = n0(row.seconds);
  }
  out.ok = row.ok !== false;
  // replay mode: nothing was spent; the row says so and carries no credits or tokens
  if (replayOn() || row.replay) {
    out.replay = true;
    for (const k of ['credits', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd']) if (k in out) out[k] = 0;
  }
  return out;
}

/** Book one spend. Never throws (the work still counts; only its record is lost). Returns the row, or null when it was
 *  already booked (same id) or could not be written. */
export function record(root, row) {
  try {
    ensureBackfilled(root);
    return append(root, row);
  } catch { return null; }
}

function append(root, row) {
  const c = load(root);
  const r = normalize(row);
  if (r.id && c.ids.has(r.id)) return null;
  mkdirSync(paths(root).state, { recursive: true });
  const line = `${JSON.stringify(r)}\n`;
  appendFileSync(ledgerFile(root), line);
  c.rows.push(r);
  if (r.id) c.ids.add(r.id);
  const size = statSync(ledgerFile(root)).size;
  if (size === c.size + Buffer.byteLength(line)) c.size = size; else caches.delete(ledgerFile(root)); // another process appended too: reload next time
  for (const fn of listeners) { try { fn(root, r); } catch { /* a listener must not break the spend */ } }
  return r;
}

/** The studio root and project id of a work folder (<root>/projects/<id>), or null when it is not one. */
export function ofWork(work) {
  const w = String(work || '');
  const id = basename(w);
  const projects = dirname(w);
  if (basename(projects) !== 'projects' || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) return null;
  const root = dirname(projects);
  return existsSync(join(root, 'state')) ? { root, project: id } : null;
}

/** Book an ElevenLabs spend made in a project's work folder (a folder outside a studio is ignored). */
export function recordForWork(work, row) {
  const w = ofWork(work);
  if (!w) return null;
  return record(w.root, { stage: stageForKind(row.kind), ...row, project: w.project, provider: 'elevenlabs' });
}

const stageForKind = (kind) => ({ tts: 'voice', 'tts sample': 'voice', music: 'music', sfx: 'sound' }[kind] || null);

/** Credits ElevenLabs charges for text-to-speech: a character each, half for the flash and turbo models. */
export function ttsCredits(model, characters) {
  return /flash|turbo/i.test(String(model || '')) ? n0(characters) / 2 : n0(characters);
}

// The stage of a canvas piece kind (beat = script, line/cue = voice & music, frame = look, shot = motion), or -1.
export const stageOfKind = (set, kind) => set.kinds.findIndex((k) => k.includes(kind));

// The pipeline stage a project is working on now (null when it cannot be told). In order: the pieces with an edit
// waiting (an edit session works on them: E001 on a beat is Script work), a step being made, a step in review (what
// the owner's screen and its quick calls serve), else the first step not finished. Never "the last step" while earlier
// work goes on (Dir3 61dc 2026-11-02: 111 rows booked to Artcraft from 09:10, long before Finish).
export function currentStage(root, id) {
  try {
    const project = loadProject(root, id);
    const pipeline = projectPipeline(root, id);
    const set = stageSet(pipeline);
    const edits = (() => { try { return JSON.parse(readFileSync(join(projectPaths(root, id).state, 'canvas', 'edits.json'), 'utf8')).edits || []; } catch { return []; } })();
    const edit = edits.find((e) => ['requested', 'working'].includes(e.state) && stageOfKind(set, e.kind) >= 0);
    if (edit) return set.keys[stageOfKind(set, edit.kind)];
    const steps = stepView(project, pipeline);
    const step = steps.find((s) => ['working', 'changes', 'ready'].includes(s.state))
      || steps.find((s) => s.state === 'in_review')
      || steps.find((s) => !['approved', 'done', 'skipped'].includes(s.state))
      || steps[steps.length - 1];
    const idx = step ? stageOf(step, set) : -1;
    return idx >= 0 ? set.keys[idx] : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- Claude: transcripts

const startedAt = (id) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
};

/** Read a session transcript (Claude Code stream-json or the API backend's records) into one entry per Claude process
 *  and model: tokens by kind, calls, whether it ended. Streams the file; only lines that carry usage are parsed. */
export async function scanTranscript(file) {
  const segs = [];
  let seg = null;
  const open = (init = {}) => {
    const tools = Array.isArray(init.tools) ? init.tools.map((t) => (typeof t === 'string' ? t : t?.name)) : [];
    seg = { kind: tools.some((t) => ['Bash', 'Task', 'Agent', 'Edit', 'Write'].includes(t)) ? 'session' : 'quick call', msgs: new Map(), api: [], outputTotal: 0, ended: false, ok: true };
    segs.push(seg);
  };
  const wrote = (content) => (Array.isArray(content) ? content.reduce((a, b) => a + (b?.type === 'text' ? String(b.text || '').length : b?.type === 'thinking' ? String(b.thinking || '').length : b?.type === 'tool_use' || b?.type === 'server_tool_use' ? JSON.stringify(b.input ?? '').length : 0), 0) : 0);
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) {
    if (l.length < 20) continue;
    const init = l.includes('"subtype":"init"');
    const asst = !init && l.includes('"type":"assistant"');
    const res = !init && !asst && l.includes('"type":"result"');
    if (!init && !asst && !res) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (init && m.type === 'system') { open(m); continue; }
    if (m.type === 'assistant' && m.message && typeof m.message === 'object') {
      if (!seg) open();
      const id = String(m.message.id || `anon${seg.msgs.size}`);
      const u = m.message.usage || {};
      const e = seg.msgs.get(id) || { model: '', input: 0, cw: 0, cr: 0, out: 0, wrote: 0, helper: Boolean(m.parent_tool_use_id) };
      e.model = m.message.model || e.model;
      e.input = Math.max(e.input, n0(u.input_tokens)); e.cw = Math.max(e.cw, n0(u.cache_creation_input_tokens));
      e.cr = Math.max(e.cr, n0(u.cache_read_input_tokens)); e.out = Math.max(e.out, n0(u.output_tokens));
      e.wrote += wrote(m.message.content);
      seg.msgs.set(id, e);
    } else if (m.type === 'assistant' && m.usage) { // the API backend: one record per call
      if (!seg) { open(); seg.kind = 'session'; seg.apiBackend = true; }
      const u = m.usage;
      seg.api.push({ model: m.model || '', input: n0(u.input_tokens), cw: n0(u.cache_creation_input_tokens), cr: n0(u.cache_read_input_tokens), out: n0(u.output_tokens) });
    } else if (m.type === 'result') {
      if (!seg) open();
      seg.ended = true;
      seg.ok = !m.is_error;
      if (m.usage && Number.isFinite(Number(m.usage.output_tokens))) seg.outputTotal += Number(m.usage.output_tokens);
    }
  }
  const out = [];
  segs.forEach((s, i) => {
    const by = new Map();
    const bucket = (model) => { const k = model || ''; let b = by.get(k); if (!b) { b = { model: k, calls: 0, input: 0, cw: 0, cr: 0, out: 0 }; by.set(k, b); } return b; };
    if (s.apiBackend) {
      for (const c of s.api) { const b = bucket(c.model); b.calls++; b.input += c.input; b.cw += c.cw; b.cr += c.cr; b.out += c.out; }
    } else {
      // Claude Code's per-message output is a placeholder; its result line has the exact total for the main session.
      // Main calls are scaled to it by what each wrote; helper agents keep their estimate.
      const est = (e) => Math.max(e.out, Math.ceil(e.wrote / 4));
      const mainEst = [...s.msgs.values()].reduce((a, e) => a + (e.helper ? 0 : est(e)), 0) || 1;
      const scale = s.outputTotal ? s.outputTotal / mainEst : 1;
      for (const e of s.msgs.values()) {
        const b = bucket(e.model); b.calls++; b.input += e.input; b.cw += e.cw; b.cr += e.cr;
        b.out += Math.round(e.helper || !s.outputTotal ? est(e) : est(e) * scale);
      }
    }
    for (const b of by.values()) if (b.calls) out.push({ n: i + 1, kind: s.kind, model: b.model, calls: b.calls, input_tokens: b.input, cache_write_tokens: b.cw, cache_read_tokens: b.cr, output_tokens: b.out, ended: s.ended || Boolean(s.apiBackend), ok: s.ended ? s.ok : false });
  });
  return out;
}

const bookedSize = new Map(); // transcript -> size at the last booking (an unchanged file is not read again)

/** Book one run's transcript (state/<project>/sessions/<run>.jsonl): one row per Claude process and model in it.
 *  Incremental and crash safe: only what is new since the rows already in the ledger is booked (a delta row per call of
 *  this function), so the runner can call it every minute while the session runs and once more at the end without
 *  counting anything twice, and a crash loses at most the last minute. */
export async function bookSession(root, projectId, runId, { stage = null, backend = null, force = false } = {}) {
  try {
    if (!RUN_ID.test(String(runId || ''))) return [];
    const file = join(projectPaths(root, projectId).sessions, `${runId}.jsonl`);
    if (!existsSync(file)) return [];
    ensureBackfilled(root);
    const size = statSync(file).size;
    if (!force && bookedSize.get(file) === size) return [];
    const started = startedAt(runId) || new Date(statSync(file).mtimeMs).toISOString();
    const rows = [];
    for (const s of await scanTranscript(file)) {
      const prefix = `claude:${projectId}:${runId}:${s.n}:${s.model}#`;
      const have = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, k: 0 };
      for (const r of readRows(root)) {
        if (!r.id || !r.id.startsWith(prefix)) continue;
        have.k++; have.calls += r.calls || 0; have.input_tokens += r.input_tokens; have.output_tokens += r.output_tokens; have.cache_read_tokens += r.cache_read_tokens; have.cache_write_tokens += r.cache_write_tokens;
      }
      const d = Object.fromEntries(Object.keys(have).filter((x) => x !== 'k').map((f) => [f, Math.max(0, s[f] - have[f])]));
      if (!d.calls && !d.input_tokens && !d.output_tokens && !d.cache_read_tokens && !d.cache_write_tokens) continue;
      const r = append(root, { id: `${prefix}${have.k}`, at: have.k ? new Date().toISOString() : started, project: projectId, stage, provider: 'claude', kind: s.kind, model: s.model || null, ...(backend ? { role: backend } : {}), ...d, ok: s.ended ? s.ok : true });
      if (r) rows.push(r);
    }
    bookedSize.set(file, size);
    return rows;
  } catch { return []; }
}

/** A quick Claude call (`claude -p --output-format json`): its answer carries usage and, per model, the tokens. */
export function recordClaudeJson(root, project, j, { role = null, model = null, stage: own = null } = {}) {
  try {
    if (!j || typeof j !== 'object') return [];
    const mu = j.modelUsage && typeof j.modelUsage === 'object' ? Object.entries(j.modelUsage) : [];
    const stage = own || (project ? currentStage(root, project) : null); // a call made for one stage (options) books that stage
    const base = { project: project || null, stage, provider: 'claude', kind: 'quick call', role, ok: !j.is_error };
    const rows = [];
    if (mu.length) {
      for (const [m, u] of mu) rows.push(record(root, { ...base, model: m, input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_tokens: u.cacheReadInputTokens, cache_write_tokens: u.cacheCreationInputTokens }));
    } else if (j.usage) {
      rows.push(record(root, { ...base, model: model || null, input_tokens: j.usage.input_tokens, output_tokens: j.usage.output_tokens, cache_read_tokens: j.usage.cache_read_input_tokens, cache_write_tokens: j.usage.cache_creation_input_tokens }));
    }
    return rows.filter(Boolean);
  } catch { return []; }
}

/** A quick Claude API call (messages.create): its response object. */
export function recordApiMessage(root, project, r, { role = null, stage = null } = {}) {
  try {
    if (!r?.usage) return null;
    return record(root, { project: project || null, stage: stage || (project ? currentStage(root, project) : null), provider: 'claude', kind: 'quick call', role, model: r.model, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, cache_read_tokens: r.usage.cache_read_input_tokens, cache_write_tokens: r.usage.cache_creation_input_tokens });
  } catch { return null; }
}

// ---------------------------------------------------------------- backfill

let backfilling = new Map(); // root -> Promise

const readJsonl = (f) => {
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
};

/** Once per studio, before the first live row: book what the studio already kept (session transcripts, the voice usage
 *  logs, the music and sound call logs). Ids make it idempotent; the marker file makes it once. Returns a promise. */
export function ensureBackfilled(root) {
  if (existsSync(markerFile(root)) || !existsSync(paths(root).state)) return Promise.resolve();
  if (!backfilling.has(root)) {
    // The synchronous sources go in right now (so a live row never lands before the old ones); transcripts follow.
    // A source that cannot be read is skipped (never blocks the live row). The marker is written last, once the
    // transcripts are in, so a crash part-way repeats the backfill next start (ids make that safe).
    try { backfillSmall(root); } catch (e) { console.error(`usage ledger: backfill of the logs stopped: ${e.message}`); }
    backfilling.set(root, backfillTranscripts(root).catch((e) => { console.error(`usage ledger: backfill of the transcripts stopped: ${e.message}`); })
      .then(() => { try { writeFileSync(markerFile(root), `${new Date().toISOString()}\n`); } catch { /* retried next start: ids make it safe */ } }));
  }
  return backfilling.get(root);
}

/** Resolves when the backfill started by ensureBackfilled has finished. */
export async function backfillDone(root) {
  await ensureBackfilled(root);
  await backfilling.get(root);
}

function backfillSmall(root) {
  const dir = paths(root).state;
  for (const id of readdirSync(dir)) {
    if (!existsSync(join(dir, id, 'project.json'))) continue;
    let pp;
    try { pp = projectPaths(root, id); } catch { continue; }
    let created = null;
    try { created = JSON.parse(readFileSync(pp.file, 'utf8')).created_at || null; } catch { /* no date */ }
    try {
      voiceRows(pp.work).forEach((r, i) => {
        if (r.engine !== 'elevenlabs') return;
        const chars = n0(r.characters);
        append(root, { id: `tts:${id}:${i}`, at: r.t || created, project: id, stage: 'voice', provider: 'elevenlabs', kind: 'tts', model: r.model, credits: n0(r.credits) || ttsCredits(r.model, chars), estimated: !n0(r.credits) });
      });
    } catch { /* unreadable log */ }
    try {
      readJsonl(join(pp.work, 'music', 'calls.jsonl')).forEach((r, i) => {
        if (r.cache === 'hit') return;
        append(root, { id: `music:${id}:${i}`, at: r.t, project: id, stage: 'music', provider: 'elevenlabs', kind: 'music', model: r.model || 'music_v2_5', credits: r.ok ? n0(r.credits_actual) || n0(r.credits_estimate) : 0, estimated: r.ok && !n0(r.credits_actual), seconds: r.seconds, ok: r.ok !== false });
      });
    } catch { /* unreadable log */ }
    try {
      readJsonl(join(pp.work, 'sound', 'calls.jsonl')).forEach((r, i) => {
        if (r.cache === 'hit') return;
        append(root, { id: `sfx:${id}:${i}`, at: r.at, project: id, stage: 'sound', provider: 'elevenlabs', kind: 'sfx', model: r.model || null, credits: r.ok ? n0(r.credits) : 0, estimated: r.ok && r.credits_estimated !== false, seconds: r.seconds, ok: r.ok !== false });
      });
    } catch { /* unreadable log */ }
  }
}

async function backfillTranscripts(root) {
  const dir = paths(root).state;
  for (const id of readdirSync(dir)) {
    const sessions = join(dir, id, 'sessions');
    if (!existsSync(join(dir, id, 'project.json')) || !existsSync(sessions)) continue;
    for (const f of readdirSync(sessions).sort()) {
      if (!f.endsWith('.jsonl') || f.endsWith('.activity.jsonl')) continue;
      const runId = f.slice(0, -'.jsonl'.length);
      if (!RUN_ID.test(runId)) continue;
      if (Date.now() - statSync(join(sessions, f)).mtimeMs < RUNNING_GRACE_MS) continue;
      await bookSession(root, id, runId, { stage: null });
    }
  }
}

// ---------------------------------------------------------------- ElevenLabs balance

const memBalance = new Map(); // root -> { at, value }

/** The ElevenLabs credits left: { remaining, limit, used, tier, resets_at, checked_at, stale? } or null with the reason.
 *  Read from /v1/user/subscription (free), at most every 10 minutes (kept in memory and in the state folder). */
export async function elevenBalance(root, { fetch: fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  const key = elevenKey(root);
  if (!key) return { balance: null, why: 'no ElevenLabs API key is saved (Settings › Keys)' };
  let cached = memBalance.get(root);
  if (!cached) { try { cached = JSON.parse(readFileSync(balanceFile(root), 'utf8')); } catch { cached = null; } if (cached) memBalance.set(root, cached); }
  // a fresh entry answers, success or failure alike: a failed read is not tried again before the interval is over
  if (cached && now - cached.at < BALANCE_TTL_MS) return cached.value ? { balance: cached.stale ? { ...cached.value, stale: true } : cached.value, why: cached.why || null } : { balance: null, why: cached.why || 'could not read the ElevenLabs balance' };
  try {
    const cfg = voiceConfig(root).elevenlabs;
    const r = await fetchFn(new URL('/v1/user/subscription', SERVERS[cfg.server] || SERVERS.default), { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(8000) });
    if (!r?.ok) throw new Error(`ElevenLabs answered ${r?.status}`);
    const s = await r.json();
    const limit = n0(s.character_limit);
    const used = n0(s.character_count);
    const value = { remaining: Math.max(0, limit - used), limit, used, tier: s.tier || null, resets_at: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null, checked_at: new Date(now).toISOString() };
    cached = { at: now, value };
    memBalance.set(root, cached);
    try { writeJson(balanceFile(root), cached); } catch { /* memory still has it */ }
    return { balance: value, why: null };
  } catch (e) {
    // a failed refresh keeps the last known balance, marked stale; never retried more often than the cache interval
    if (cached?.value) {
      const why = `could not refresh: ${String(e.message || e).slice(0, 120)}`;
      memBalance.set(root, { at: now, value: cached.value, stale: true, why });
      return { balance: { ...cached.value, stale: true }, why };
    }
    const why = `could not read the ElevenLabs balance: ${String(e.message || e).slice(0, 120)}`;
    memBalance.set(root, { at: now, value: null, why });
    return { balance: null, why };
  }
}

export function _forget() { bookedSize.clear(); caches.clear(); memBalance.clear(); backfilling = new Map(); }

// ---------------------------------------------------------------- usage.get

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** ElevenLabs credits booked today (this computer's local day), for the daily credit cap (svc/paidgate.mjs). */
export function creditsToday(root, now = Date.now()) {
  const today = dayOf(now);
  let sum = 0;
  for (const r of readRows(root)) if (r.provider === 'elevenlabs' && dayOf(r.at) === today) sum += n0(r.credits);
  return r6(sum);
}

const emptyC = () => ({ calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, rows: 0 });
// `credits` sums every row; `estimated_rows` / `unknown_rows` say how many of those rows hold an estimate or an unknown
// amount rather than what ElevenLabs reported, so a total built on guesses can be shown as such.
const emptyE = () => ({ calls: 0, credits: 0, rows: 0, estimated_rows: 0, unknown_rows: 0 });

function addRow(t, r) {
  if (r.provider === 'claude') {
    const c = t.claude;
    c.rows++; c.calls += r.calls ?? 1;
    c.input_tokens += r.input_tokens; c.output_tokens += r.output_tokens; c.cache_read_tokens += r.cache_read_tokens; c.cache_write_tokens += r.cache_write_tokens;
    c.total_tokens += r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
  } else {
    const e = t.elevenlabs;
    e.rows++; e.calls++; e.credits = r6(e.credits + r.credits);
    if (r.estimated) e.estimated_rows++;
    if (r.credits_unknown) e.unknown_rows++;
  }
}

const both = () => ({ claude: emptyC(), elevenlabs: emptyE() });

function group(rows, keyOf, extra = () => ({})) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    let g = m.get(k);
    if (!g) { g = { ...extra(r, k), ...both() }; m.set(k, g); }
    addRow(g, r);
  }
  return [...m.values()];
}

const weight = (g) => g.claude.total_tokens + g.elevenlabs.credits;

/** The data behind the token counter. `range`: today | week (last 7 days) | month (last 30 days) | all (default). */
export async function usageGet(root, { range = 'all', project } = {}, deps = {}) {
  await backfillDone(root);
  if (!['today', 'week', 'month', 'all'].includes(range)) throw Object.assign(new Error(`range must be today, week, month or all, not ${JSON.stringify(range)}`), { code: 'bad_request' });
  const now = new Date(deps.now ?? Date.now());
  const all = readRows(root).filter((r) => !project || r.project === project);
  const back = { today: 0, week: 6, month: 29 }[range];
  const since = back === undefined ? null : new Date(dayStart(now).getTime() - back * 86_400_000 + (now.getTimezoneOffset() - dayStart(new Date(dayStart(now).getTime() - back * 86_400_000)).getTimezoneOffset()) * 60_000);
  const rows = since ? all.filter((r) => new Date(r.at) >= since) : all;

  const totals = both();
  for (const r of rows) addRow(totals, r);
  const by_project = group(rows, (r) => r.project || '', (r, k) => ({ project: k || null })).sort((a, b) => weight(b) - weight(a));
  const by_stage = group(rows, (r) => r.stage || '', (r, k) => ({ stage: k || null })).sort((a, b) => weight(b) - weight(a));
  const by_model = group(rows, (r) => `${r.provider}|${r.kind}|${r.model || ''}`, (r) => ({ provider: r.provider, kind: r.kind, model: r.model })).sort((a, b) => weight(b) - weight(a));

  // the last 30 days, every day present (zeroes included); filtered by project, not by range
  const series = [];
  const byDay = new Map();
  for (const r of all) { const d = dayOf(r.at); let t = byDay.get(d); if (!t) { t = both(); byDay.set(d, t); } addRow(t, r); }
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    series.push({ date, ...(byDay.get(date) || both()) });
  }

  // high scores, over everything the ledger holds (project filter applies)
  const days = [...byDay.entries()].map(([date, t]) => ({ date, ...t }));
  const projects = group(all, (r) => r.project || '', (r, k) => ({ project: k || null }));
  const top = (list, f) => list.reduce((best, x) => (!best || f(x) > f(best) ? x : best), null);
  const claudeRows = all.filter((r) => r.provider === 'claude');
  const eleven = all.filter((r) => r.provider === 'elevenlabs');
  const tok = (r) => r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
  const slim = (g, f) => (g && f(g) > 0 ? g : null);
  const records = {
    biggest_day: {
      claude: slim(top(days, (d) => d.claude.total_tokens), (d) => d.claude.total_tokens),
      elevenlabs: slim(top(days, (d) => d.elevenlabs.credits), (d) => d.elevenlabs.credits),
    },
    biggest_project: {
      claude: slim(top(projects.filter((p) => p.project), (p) => p.claude.total_tokens), (p) => p.claude.total_tokens),
      elevenlabs: slim(top(projects.filter((p) => p.project), (p) => p.elevenlabs.credits), (p) => p.elevenlabs.credits),
    },
    biggest_call: {
      claude: slim(top(claudeRows, tok), tok),
      elevenlabs: slim(top(eleven, (r) => r.credits), (r) => r.credits),
    },
    longest_streak: streak(days.map((d) => d.date), dayOf(now)),
  };

  const bal = await elevenBalance(root, deps).catch((e) => ({ balance: null, why: String(e.message || e) }));
  return { range, project: project || null, since: since ? since.toISOString() : null, rows: rows.length, totals, by_project, by_stage, by_model, series, records, elevenlabs_balance: bal.balance, elevenlabs_balance_why: bal.why };
}

// Longest run of consecutive days with any spend, and the run that reaches today (or yesterday) right now.
function streak(dates, today) {
  const set = [...new Set(dates)].sort();
  const next = (d) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(y, m - 1, dd + 1); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  let best = { days: 0, from: null, to: null };
  let run = { days: 0, from: null, to: null };
  for (const d of set) {
    run = run.to && next(run.to) === d ? { days: run.days + 1, from: run.from, to: d } : { days: 1, from: d, to: d };
    if (run.days > best.days) best = { ...run };
  }
  const yesterday = (() => { const [y, m, dd] = today.split('-').map(Number); const x = new Date(y, m - 1, dd - 1); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; })();
  const current = run.to === today || run.to === yesterday ? run.days : 0;
  return { days: best.days, from: best.from, to: best.to, current };
}
