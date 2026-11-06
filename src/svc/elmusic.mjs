// Music cues for the Voice & music stage, made with ElevenLabs music (not Strudel).
//   music.plan.get / music.plan.make   one quick AI call proposes cues over the video, cut at scene changes
//   music.cue.set / .make / .ok        edit a cue; make it (cost first, every call logged); approve it
//   music.mix                          narration + cues, crossfaded, ducked under the voice, -14 LUFS
// Files (in the project's work folder): music/cues.json, music/calls.jsonl, music/<cue>.mp3, out/voice/mix.wav.
// The ElevenLabs call is the same as pipelines/_shared/skills/voiceover/sound.mjs `music` (POST /v1/music,
// music_v2_5, music_length_ms 3 s to 10 min, force_instrumental). `fetch` and `ask` are injectable for tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectPaths } from '../projects.mjs';
import { readBeats, approveIfAllDecided } from '../canvas.mjs';
import { musicExpected } from './musicneed.mjs';
import { voiceConfig, elevenKey } from '../voice/index.mjs';
import { SERVERS, TIMEOUT_MS, timeoutSignal, lostWhy, elevenWhy } from '../voice/elevenlabs.mjs';
import { rememberQuote, takeQuote } from './paidgate.mjs';
import { askAI } from './chat.mjs';
import { recordForWork } from './ledger.mjs';
import { cacheKey, cacheHas, cacheCopy, cachePut, cacheDir } from './elcache.mjs';
import { writeJson } from '../studio.mjs';

export const MODEL = 'music_v2_5';
export const MIN_SEC = 3;
export const MAX_SEC = 600;
// ElevenLabs bills music by length; the exact rate depends on the plan, so this is an estimate ("about N credits").
export const CREDITS_PER_SEC = 33;
export const MIX_LUFS = -14;
const BILLING = new Set([401, 402, 429]);

const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const r3 = (n) => Math.round(n * 1000) / 1000;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

const dirs = (root, id) => { const work = projectPaths(root, id).work; return { work, music: join(work, 'music'), cues: join(work, 'music', 'cues.json'), calls: join(work, 'music', 'calls.jsonl'), narration: join(work, 'out', 'voice', 'narration.wav'), mix: join(work, 'out', 'voice', 'mix.wav') }; };

export const creditsFor = (sec) => Math.ceil(sec * CREDITS_PER_SEC);
// A cue's audio runs its own length plus a tail the next cue fades in over.
// The first music is made alone and heard before the rest (owner rule: a paid test first; Dirs 1 and 2 made 4 cues at once
// with Make the music). No cue made yet: only the first cue to make. One made but none OK'd: nothing, until the owner hears
// and OKs it. One OK'd: every cue still to make. `only` (cue ids) narrows the list first. Returns {todo, wait}: wait says
// why the rest wait (null when nothing waits).
export const cueWords = (id) => `Music ${Number(String(id).replace(/\D/g, '')) || id}`;
export function musicBatch(cues, only = null) {
  const all = Array.isArray(cues) ? cues : [];
  const made = all.filter((c) => c.file && c.state !== 'stale');
  let todo = all.filter((c) => !(c.file && c.state !== 'stale') && String(c.prompt || '').trim());
  if (Array.isArray(only)) todo = todo.filter((c) => only.includes(c.id));
  if (!todo.length) return { todo, wait: null };
  if (!made.length) return { todo: todo.slice(0, 1), wait: todo.length > 1 ? `the first music is made alone: hear ${cueWords(todo[0].id)} and OK it, then make the rest` : null };
  if (!all.some((c) => c.state === 'ok')) return { todo: [], wait: `hear ${cueWords(made[0].id)} and OK it first, then make the rest` };
  return { todo, wait: null };
}

// where a cue's made music goes: music/<id>.mp3, unless a cue kept by Plan again already uses that name
const fileFor = (j, c) => { const base = join('music', `${c.id}.mp3`); return j.cues.some((x) => x !== c && x.file === base) ? join('music', `${c.id}-${Date.now()}.mp3`) : base; };
export const cueLength = (c) => Math.min(MAX_SEC, Math.max(MIN_SEC, r3(c.to_sec - c.from_sec + (c.crossfade_sec || 0))));

// Where each scene sits on the voice timeline: [{id, from, to}] from voice/timing.json (line ids b01-1 → beat b01).
export function sceneSpans(work) {
  const timing = readOr(join(work, 'voice', 'timing.json'), { lines: [] });
  const spans = [];
  for (const l of timing.lines || []) {
    const beat = String(l.id).match(/^(b\d{2,3})/)?.[1];
    if (!beat || !Number.isFinite(l.start) || !Number.isFinite(l.end)) continue;
    const last = spans.at(-1);
    if (last && last.id === beat) { last.from = Math.min(last.from, l.start); last.to = Math.max(last.to, l.end); } else spans.push({ id: beat, from: l.start, to: l.end });
  }
  return { spans, total: num(timing.seconds, spans.at(-1)?.to ?? 0) };
}

const view = (d, c) => ({ ...c, length_sec: cueLength(c), credits: creditsFor(cueLength(c)), ...(c.file && existsSync(join(d.work, c.file)) ? { path: join(d.work, c.file) } : {}) });

function load(d) {
  const j = readOr(d.cues, null);
  return j && Array.isArray(j.cues) ? j : { cues: [], total_sec: 0, source: null };
}
function save(d, j) { mkdirSync(d.music, { recursive: true }); writeJson(d.cues, j); }

const clampXf = (v, len) => Math.min(Math.max(0, num(v, 2)), 8, Math.max(0, len / 2));

// Cues from the AI's answer (or none): snapped to scene starts, contiguous over 0..total, none shorter than MIN_SEC.
export function normalizeCues(raw, spans, total) {
  const starts = [0, ...spans.map((s) => s.from).filter((t) => t > 0), total].map(r3);
  const snap = (t) => starts.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), starts[0]);
  const cuts = [...new Set([0, ...raw.slice(1).map((c) => snap(num(c.from_sec, 0))), total].map(r3))].sort((a, b) => a - b);
  const keep = [0];
  for (const t of cuts.slice(1)) { if (t - keep.at(-1) >= MIN_SEC || t === total) keep.push(t); }
  if (keep.length > 1 && keep.at(-1) - keep.at(-2) < MIN_SEC && keep.length > 2) keep.splice(-2, 1);
  const cues = [];
  for (let i = 0; i < keep.length - 1; i++) {
    const src = raw.find((c) => Math.abs(num(c.from_sec, 0) - keep[i]) <= (raw.length > 1 ? 1e9 : 0) && snap(num(c.from_sec, 0)) === keep[i]) || raw[Math.min(i, raw.length - 1)] || {};
    const from = keep[i]; const to = keep[i + 1];
    cues.push({ id: `mc${String(i + 1).padStart(2, '0')}`, from_sec: from, to_sec: to, mood: String(src.mood || 'neutral').slice(0, 60), prompt: String(src.prompt || '').slice(0, 600), energy: Math.min(1, Math.max(0, num(src.energy, 0.5))), crossfade_sec: clampXf(src.crossfade_sec, to - from), duck_db: Math.min(0, Math.max(-30, num(src.duck_db, -9))), state: 'planned' });
  }
  return cues;
}

function planPrompt(beats, spans, total) {
  const at = Object.fromEntries(spans.map((s) => [s.id, s]));
  const rows = beats.map((b) => `${b.id} [${r3(at[b.id]?.from ?? 0)}s to ${r3(at[b.id]?.to ?? 0)}s] ${b.words}${b.visual ? ` (visual: ${b.visual})` : ''}`).join('\n');
  return `You score a ${r3(total)} second narrated video. Propose music cues that cover it from 0 to ${r3(total)} seconds, cut only where a scene changes (use the scene start times below). Each cue is at least ${MIN_SEC} seconds, instrumental, fits the mood of its scenes, and sits under a voice. Reply with JSON only: {"cues":[{"from_sec":0,"to_sec":20,"mood":"two or three words","prompt":"one sentence for a music generator: style, instruments, tempo, no vocals","energy":0.4,"crossfade_sec":2,"duck_db":-9}]}\nenergy is 0 to 1. Scenes:\n${rows}`;
}

function parseCues(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return Array.isArray(j.cues) && j.cues.length ? j.cues : null; } catch { return null; }
}

// The plan: the AI's cues when it answers, else one cue per run of scenes from the script alone (marked source: "beats").
export async function makeMusicPlan(project, opts = {}) {
  const { root, id } = project;
  const d = dirs(root, id);
  const { spans, total } = sceneSpans(d.work);
  if (!spans.length || !(total > 0)) throw Object.assign(new Error('make the voice first: there is no voice timing to cut the music at'), { code: 'no_voice' });
  const beats = readBeats(d.work).filter((b) => spans.some((s) => s.id === b.id));
  const ask = opts.ask || ((prompt) => askAI(root, id, prompt, { maxTokens: 2500 }));
  let raw = null; let source = 'ai';
  try { raw = parseCues(await ask(planPrompt(beats, spans, total))); } catch { raw = null; }
  if (!raw) {
    source = 'beats';
    const per = Math.max(1, Math.ceil(spans.length / Math.max(1, Math.round(total / 30))));
    raw = []; for (let i = 0; i < spans.length; i += per) raw.push({ from_sec: spans[i].from, mood: 'neutral', prompt: `Calm instrumental underscore, no vocals. ${beats.slice(i, i + per).map((b) => b.words).join(' ').slice(0, 200)}` });
  }
  const cues = normalizeCues(raw, spans, total);
  // Plan again keeps the paid work: a cue made before over the same span stays as it was (its words, file and OK), only
  // its id follows the new list; the plan before is kept beside it (music/cues.before-<time>.json). The same rule as
  // the Sound plan (svc/sfx.mjs makePlan: made and OK'd cues survive a re-plan).
  const prev = load(d);
  const madeBefore = prev.cues.filter((c) => c.file);
  if (madeBefore.length) {
    mkdirSync(d.music, { recursive: true });
    writeJson(join(d.music, `cues.before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), prev);
    cues.forEach((c, k) => {
      const old = madeBefore.find((x) => r3(x.from_sec) === c.from_sec && r3(x.to_sec) === c.to_sec);
      if (old) { cues[k] = { ...old, id: c.id }; madeBefore.splice(madeBefore.indexOf(old), 1); }
    });
  }
  const j = { cues, total_sec: total, source, made_at: new Date().toISOString() };
  save(d, j);
  return j;
}

export function musicHandlers({ root, ProtocolError, needProject, emit = () => {}, previous = {}, fetchFn = (...a) => fetch(...a), ask }) {
  const prevSet = previous['music.cue.set']; // taken now: `previous` is the live handler table that this replaces it in
  const err = (code, msg) => new ProtocolError(code, msg);
  const ctx = (p) => { const id = needProject(p); return { id, d: dirs(root, id) }; };
  const findCue = (j, cue) => j.cues.find((c) => c.id === cue) || (() => { throw err('no_cue', `no music cue ${JSON.stringify(cue)}`); })();
  const changed = (id) => emit('music.changed', { project: id });
  // v3: the voice step makes the music, so the owner may make cues (cost first) even with the sessions' Eleven Music
  // switch off; `expected`: the step is not done until the music is made and OK'd (svc/musicneed.mjs)
  const allowed = (id) => Boolean(voiceConfig(root).elevenlabs.music) || musicExpected(root, id);
  const status = (d, id) => ({ enabled: allowed(id), expected: musicExpected(root, id), making: making.has(id), key: Boolean(elevenKey(root)), mix: existsSync(d.mix) ? d.mix : null });
  const making = new Set();
  // the real balance and rate, from the free /v1/user/subscription read before and after the first real cue
  const rateFile = join(cacheDir(root), 'music-rate.json');
  const known = () => readOr(rateFile, {});
  async function subscription() {
    try {
      const cfg = voiceConfig(root).elevenlabs;
      const r = await fetchFn(new URL('/v1/user/subscription', SERVERS[cfg.server] || SERVERS.default), { headers: { 'xi-api-key': elevenKey(root) }, signal: timeoutSignal(TIMEOUT_MS.read) });
      if (!r?.ok) return null;
      const j = await r.json();
      const left = Number(j.character_limit) - Number(j.character_count);
      return Number.isFinite(left) ? left : null;
    } catch { return null; }
  }
  // mix_stale: out/voice/mix.wav exists but is older than what it is made from (musicMixState); the next mix remakes it
  const mixStale = (d) => { if (!existsSync(d.mix)) return false; const m = musicMixState(d.work); return m.cues.length > 0 && !m.fresh; };
  const out = (id, d, j) => ({ project: id, ...status(d, id), mix_stale: mixStale(d), balance: known().balance ?? null, credits_per_sec_measured: known().credits_per_sec_measured ?? null, total_sec: j.total_sec, source: j.source, credits_per_sec: CREDITS_PER_SEC, cues: j.cues.map((c) => view(d, c)) });

  const log = (d, row) => { if (row.cache !== 'hit') recordForWork(d.work, { kind: 'music', model: MODEL, credits: row.ok ? Number(row.credits_actual) || Number(row.credits_estimate) || 0 : 0, estimated: row.ok && !Number(row.credits_actual), seconds: row.seconds, ok: row.ok !== false }); try { mkdirSync(d.music, { recursive: true }); appendFileSync(d.calls, `${JSON.stringify({ t: new Date().toISOString(), engine: 'elevenlabs', model: MODEL, ...row })}\n`); } catch { /* the cue still counts */ } };

  async function callMusic(d, c, prompt, seconds) {
    const key = elevenKey(root);
    const cfg = voiceConfig(root).elevenlabs;
    const url = new URL(`/v1/music?output_format=mp3_44100_128`, SERVERS[cfg.server] || SERVERS.default);
    const body = JSON.stringify({ prompt, model_id: MODEL, force_instrumental: true, music_length_ms: Math.round(seconds * 1000) });
    // at most 1 retry, and only after ElevenLabs answered with a server error; a request with no answer (network error,
    // timeout) is never sent again: the ElevenLabs docs do not say whether it was billed (src/voice/elevenlabs.mjs lostWhy)
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res;
      try { res = await fetchFn(url, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body, signal: timeoutSignal(TIMEOUT_MS.music) }); } catch (e) {
        log(d, { cue: c.id, seconds, attempt, ok: false, error: String(e.message || e).slice(0, 200), maybe_charged: true });
        throw err('failed', lostWhy(e, 'ElevenLabs music'));
      }
      if (res.ok) {
        const real = Number(res.headers?.get?.('character-cost')) || 0; // what ElevenLabs charged, when it says
        let bytes;
        try { bytes = Buffer.from(await res.arrayBuffer()); } catch (e) {
          log(d, { cue: c.id, seconds, attempt, ok: false, status: res.status, error: String(e.message || e).slice(0, 200), maybe_charged: true });
          throw err('failed', lostWhy(e, 'ElevenLabs music'));
        }
        log(d, { cue: c.id, seconds, attempt, ok: true, status: res.status, credits_estimate: creditsFor(seconds), ...(real ? { credits_actual: real } : {}) });
        return bytes;
      }
      const text = (await res.text().catch(() => '')).slice(0, 300);
      log(d, { cue: c.id, seconds, attempt, ok: false, status: res.status, error: text });
      if (BILLING.has(res.status)) throw err('billing', `ElevenLabs stopped the music: ${elevenWhy(res.status, text)}`);
      if (res.status < 500 || attempt === 2) throw err('failed', `ElevenLabs music: ${elevenWhy(res.status, text)}`);
    }
    throw err('failed', 'ElevenLabs music failed');
  }

  return {
    'music.plan.get': (p) => { const { id, d } = ctx(p); return out(id, d, load(d)); },
    'music.plan.make': async (p) => {
      const { id, d } = ctx(p);
      let j;
      try { j = await makeMusicPlan({ root, id }, { ask: ask ? (q) => ask(q) : undefined }); } catch (e) { if (e.code === 'no_voice') throw err('no_voice', e.message); throw e; }
      changed(id);
      // every line OK'd already and the step waited only for this plan: the voice is approved now (Look can start)
      let approved = null;
      try { approved = approveIfAllDecided(root, id, 'line'); } catch (e) { console.error(`voice approve after the music plan ${id}: ${e.message}`); }
      return { ...out(id, d, j), ...(approved ? { approved } : {}) };
    },
    // `music.cue.set` also exists for the score's cues (m01...): those still go to the earlier handler
    'music.cue.set': (p) => {
      if (!/^mc\d+$/.test(String(p?.cue)) && prevSet) return prevSet(p);
      const { id, d } = ctx(p); const j = load(d); const c = findCue(j, p.cue);
      const before = JSON.stringify([c.prompt, c.from_sec, c.to_sec, c.crossfade_sec]);
      if (p.mood !== undefined) c.mood = String(p.mood).slice(0, 60);
      if (p.prompt !== undefined) c.prompt = String(p.prompt).slice(0, 600);
      if (p.from_sec !== undefined) c.from_sec = Math.max(0, r3(num(p.from_sec, c.from_sec)));
      if (p.to_sec !== undefined) c.to_sec = r3(num(p.to_sec, c.to_sec));
      if (!(c.to_sec - c.from_sec >= MIN_SEC)) throw err('bad_request', `a cue is at least ${MIN_SEC} seconds long`);
      if (p.energy !== undefined) c.energy = Math.min(1, Math.max(0, num(p.energy, c.energy)));
      if (p.duck_db !== undefined) c.duck_db = Math.min(0, Math.max(-30, num(p.duck_db, c.duck_db)));
      if (p.crossfade_sec !== undefined) c.crossfade_sec = clampXf(p.crossfade_sec, c.to_sec - c.from_sec);
      // new words, or more length than the made music has (the cue plus its crossfade tail): it needs making again. A
      // shorter cue or crossfade is only trimmed at the mix (atrim), so the paid music stays (it was made without
      // made_seconds: any change, as before)
      const tooShort = !(Number(c.made_seconds) > 0) || cueLength(c) > Number(c.made_seconds) + 0.001;
      if (c.file && JSON.stringify([c.prompt, c.from_sec, c.to_sec, c.crossfade_sec]) !== before && (c.prompt !== JSON.parse(before)[0] || tooShort)) { c.state = 'stale'; }
      save(d, j); changed(id);
      return { cue: view(d, c) };
    },
    'music.cue.make': async (p) => {
      const { id, d } = ctx(p); const j = load(d); const c = findCue(j, p.cue);
      if (!String(c.prompt || '').trim()) throw err('bad_request', 'write what this music should sound like first');
      const seconds = cueLength(c);
      const credits = creditsFor(seconds);
      // library first (opt C4): the same prompt and length made in any project before costs nothing
      const ck = cacheKey({ kind: 'music', prompt: c.prompt, seconds, model: MODEL, instrumental: true });
      if (cacheHas(root, ck)) return fromLibrary(id, d, j, c, ck);
      // the price covers exactly this cue's words and length, once (svc/paidgate.mjs quotes)
      const what = { cue: c.id, prompt: c.prompt, seconds };
      if (p.confirm !== true) { rememberQuote(id, 'music', what, credits); return { project: id, cue: c.id, needs_confirm: true, seconds, credits_estimate: credits, message: `Making ${c.id} (${seconds} s) costs about ${credits} ElevenLabs credits.` }; }
      if (!allowed(id)) throw err('music_off', 'Eleven Music is switched off in Settings > Voice');
      if (!elevenKey(root)) throw err('no_key', 'no ElevenLabs key is set up in this studio');
      try { takeQuote(id, 'music', what, credits); } catch (e) { throw err(e.code || 'cost_changed', e.message); }
      return makePaid(id, d, j, c);
    },
    // Every cue not made yet (or stale), one after another, the library first; a billing stop ends it. Paid: only with
    // confirm (the app's Make the music goes through step.confirm_cost, which starts this). The first music is made alone
    // (musicBatch); `cues` (ids) narrows what is made.
    'music.make': async (p) => {
      const { id, d } = ctx(p); const j = load(d);
      const only = Array.isArray(p.cues) ? p.cues.map(String) : null;
      const { todo, wait } = musicBatch(j.cues, only);
      const credits = todo.reduce((n, c) => n + creditsFor(cueLength(c)), 0);
      if (!todo.length && wait) throw err('first_music', wait);
      if (!todo.length) return { project: id, made: [], credits_estimate: 0 };
      if (p.confirm !== true) return { project: id, needs_confirm: true, cues: todo.map((c) => c.id), credits_estimate: credits, ...(wait ? { wait } : {}), message: `Making ${todo.length} music cue${todo.length === 1 ? '' : 's'} costs about ${credits} ElevenLabs credits.` };
      if (making.has(id)) return { project: id, already: true, cues: todo.map((c) => c.id) };
      making.add(id); changed(id);
      const made = [];
      try {
        for (const want of todo) {
          const now = load(d); const c = now.cues.find((x) => x.id === want.id);
          if (!c || (c.file && c.state !== 'stale')) continue;
          const ck = cacheKey({ kind: 'music', prompt: c.prompt, seconds: cueLength(c), model: MODEL, instrumental: true });
          if (cacheHas(root, ck)) { fromLibrary(id, d, now, c, ck); made.push(c.id); continue; }
          await makePaid(id, d, now, c);
          made.push(c.id);
        }
      } finally { making.delete(id); changed(id); }
      return { project: id, made, credits_estimate: credits };
    },
    'music.cue.ok': (p) => {
      const { id, d } = ctx(p); const j = load(d); const c = findCue(j, p.cue);
      if (!c.file) throw err('not_made', 'make this cue before approving it');
      c.state = 'ok'; save(d, j); changed(id);
      return { cue: view(d, c) };
    },
    'music.mix': async (p) => {
      const { id, d } = ctx(p); const j = load(d);
      const cues = j.cues.filter((c) => c.file && c.state !== 'stale' && existsSync(join(d.work, c.file)));
      if (!cues.length) throw err('no_music', 'no music cue is made yet');
      if (!existsSync(d.narration)) throw err('no_voice', 'the narration is missing (out/voice/narration.wav)');
      const timing = readOr(join(d.work, 'voice', 'timing.json'), { lines: [] });
      const r = mixMusic({ narration: d.narration, cues: cues.map((c) => ({ ...c, file: join(d.work, c.file) })), allCues: j.cues, timing, out: d.mix });
      if (!r.ok) throw err('failed', `the mix failed: ${r.error}`);
      writeFileSync(join(dirname(d.mix), 'mix.recipe'), MIX_RECIPE); // made by today's recipe: not stale (musicMixState)
      changed(id);
      return { project: id, path: d.mix, cues: cues.map((c) => c.id), lufs: MIX_LUFS };
    },
  };

  function fromLibrary(id, d, j, c, ck) {
    const seconds = cueLength(c);
    const file = fileFor(j, c);
    mkdirSync(d.music, { recursive: true });
    cacheCopy(root, ck, join(d.work, file));
    log(d, { cue: c.id, seconds, ok: true, cache: 'hit', credits_estimate: 0 });
    c.file = file; c.state = 'made'; c.made_prompt = c.prompt; c.made_seconds = seconds; c.made_credits_estimate = 0; c.from_library = true;
    save(d, j); changed(id);
    return { project: id, cue: view(d, c), credits_estimate: 0, from_library: true, cache: 'hit' };
  }

  async function makePaid(id, d, j, c) {
    const seconds = cueLength(c);
    const credits = creditsFor(seconds);
    const ck = cacheKey({ kind: 'music', prompt: c.prompt, seconds, model: MODEL, instrumental: true });
    if (!allowed(id)) throw err('music_off', 'Eleven Music is switched off in Settings > Voice');
    if (!elevenKey(root)) throw err('no_key', 'no ElevenLabs key is set up in this studio');
    const first = known().credits_per_sec_measured == null;
    const before = await subscription();
    const bytes = await callMusic(d, c, c.prompt, seconds);
    const after = await subscription();
    if (after != null) {
      const was = known();
      const rate = first && before != null && before > after ? Math.round(((before - after) / seconds) * 100) / 100 : was.credits_per_sec_measured ?? null;
      mkdirSync(cacheDir(root), { recursive: true });
      writeFileSync(rateFile, JSON.stringify({ balance: after, credits_per_sec_measured: rate, at: new Date().toISOString() }));
    }
    cachePut(root, ck, bytes);
    const file = fileFor(j, c);
    mkdirSync(d.music, { recursive: true });
    writeFileSync(join(d.work, file), bytes);
    c.file = file; c.state = 'made'; c.made_prompt = c.prompt; c.made_seconds = seconds; c.made_credits_estimate = credits; delete c.from_library;
    save(d, j); changed(id);
    return { project: id, cue: view(d, c), credits_estimate: credits, balance: known().balance ?? null, credits_per_sec_measured: known().credits_per_sec_measured ?? null };
  }
}

// Speech regions from word spans (a gap under `gap` s joins), padded; used to duck the music.
export function speechRegions(timing, { gap = 0.6, pad = 0.12, lines = false } = {}) {
  const spans = [];
  for (const l of timing.lines || []) {
    // lines: one span per voice line (its words run into each other, the pause is between lines)
    if (lines && Number.isFinite(l.start) && Number.isFinite(l.end)) spans.push([l.start, l.end]);
    else if (Array.isArray(l.words) && l.words.length) for (const w of l.words) { if (Number.isFinite(w.start) && Number.isFinite(w.end)) spans.push([w.start, w.end]); }
    else if (Number.isFinite(l.start) && Number.isFinite(l.end)) spans.push([l.start, l.end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of spans) { const last = out.at(-1); if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out.map(([a, b]) => [Math.max(0, r3(a - pad)), r3(b + pad)]);
}

// 1 while the voice speaks, easing to 10^(duck_db/20) over `ramp` s either side; as one ffmpeg expression.
export function duckExpression(regions, duckDb, ramp = 0.25) {
  const floor = r3(10 ** (duckDb / 20));
  if (!regions.length || floor >= 1) return '1';
  const bump = ([a, b]) => `clip(min((t-${a}+${ramp})/${ramp},(${b}+${ramp}-t)/${ramp}),0,1)`;
  const all = regions.map(bump).reduce((acc, x) => (acc ? `max(${acc},${x})` : x), '');
  return `(1-${r3(1 - floor)}*${all})`;
}

// integrated loudness (LUFS) of a file, or null
export function loudnessOf(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 });
  const m = String(r.stderr || '').match(/\{[^{}]*"input_i"[^{}]*\}/s);
  try { const v = Number(JSON.parse(m[0]).input_i); return Number.isFinite(v) ? v : null; } catch { return null; }
}

export function mixMusic({ narration, cues, allCues = cues, timing, out, ffmpegBin = 'ffmpeg' }) {
  // duck per voice line, not over the whole narration (lines closer than 0.25 s join), so the music comes back up in
  // the pauses between lines (2026-11-02, d4fd: gap 0.6 joined every word into one 0–62.59 s window and the
  // music sat ducked at -50 to -60 dB the whole film)
  const regions = speechRegions(timing, { gap: 0.25, pad: 0.05, lines: true });
  const parts = ['[0:a]aresample=44100,aformat=channel_layouts=stereo[v]'];
  const labels = ['[v]'];
  cues.forEach((c, i) => {
    const idx = allCues.findIndex((x) => x.id === c.id);
    const prev = idx > 0 ? allCues[idx - 1] : null;
    const fin = prev && Math.abs(prev.to_sec - c.from_sec) < 0.01 ? Math.max(0.05, prev.crossfade_sec || 0) : 0;
    const len = c.to_sec - c.from_sec + (c.crossfade_sec || 0);
    // the bed's level from the cue's own loudness: about -18 LUFS between lines (±2 by energy), ducked under the voice
    // by duck_db. A fixed -20 dB on a quiet ElevenLabs cue put the music near -50 dB (d4fd, 2026-11-02).
    const li = loudnessOf(c.file);
    const gain = li === null ? r3(-24 + 10 * (c.energy ?? 0.5)) : r3(Math.max(-30, Math.min(12, -18 + 4 * ((c.energy ?? 0.5) - 0.5) - li)));
    const chain = [`atrim=0:${r3(len)}`, 'asetpts=PTS-STARTPTS', 'aresample=44100', 'aformat=channel_layouts=stereo'];
    if (fin > 0) chain.push(`afade=t=in:d=${r3(fin)}`);
    if (c.crossfade_sec > 0) chain.push(`afade=t=out:st=${r3(Math.max(0, len - c.crossfade_sec))}:d=${r3(c.crossfade_sec)}`);
    else chain.push('afade=t=out:st=' + r3(Math.max(0, len - 0.05)) + ':d=0.05');
    chain.push(`volume=${gain}dB`, `adelay=${Math.round(c.from_sec * 1000)}:all=1`);
    // the duck gate: only while the voice speaks
    chain.push(`volume='${duckExpression(regions, c.duck_db ?? -9, 0.15)}':eval=frame`);
    parts.push(`[${i + 1}:a]${chain.join(',')}[m${i}]`);
    labels.push(`[m${i}]`);
  });
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first:dropout_transition=0,loudnorm=I=${MIX_LUFS}:TP=-1.5:LRA=11[o]`);
  mkdirSync(dirname(out), { recursive: true });
  const script = `${out}.filter.txt`;
  writeFileSync(script, parts.join(';\n'));
  const args = ['-hide_banner', '-nostdin', '-y', '-i', narration, ...cues.flatMap((c) => ['-i', c.file]), '-/filter_complex', script, '-map', '[o]', '-ar', '44100', '-c:a', 'pcm_s16le', out];
  const r = spawnSync(ffmpegBin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 });
  return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' ') };
}

// The voice with the made music under it (out/voice/mix.wav), made again when a cue or the narration is newer. The Sound
// step puts its sounds on this mix (2026-11-02, d4fd: the music was made and OK'd at Voice, but nothing called
// music.mix, so Sound mixed the bare narration). null when no music cue is made; {ok, path} or {ok:false, error}.
// What the voice-and-music mix is made from, and whether out/voice/mix.wav is current: made by this recipe (an older
// recipe, one long duck and a fixed -20 dB bed, is made again) and newer than the narration, the voice timing (the
// duck), cues.json (levels, ducking, crossfades) and every made cue file it uses.
export function musicMixState(work) {
  const cues = (readOr(join(work, 'music', 'cues.json'), { cues: [] }).cues || []).filter((c) => c.file && c.state !== 'stale' && existsSync(join(work, c.file)));
  const narration = [join(work, 'out', 'voice', 'narration.wav'), join(work, 'voice', 'narration.wav')].find((f) => existsSync(f)) || join(work, 'out', 'voice', 'narration.wav');
  const out = join(work, 'out', 'voice', 'mix.wav');
  const recipe = join(work, 'out', 'voice', 'mix.recipe');
  const t = (f) => statSync(f).mtimeMs;
  const fresh = cues.length > 0 && existsSync(out) && existsSync(recipe) && readFileSync(recipe, 'utf8').trim() === MIX_RECIPE
    && [narration, join(work, 'voice', 'timing.json'), join(work, 'music', 'cues.json'), ...cues.map((c) => join(work, c.file))].every((f) => !existsSync(f) || t(f) <= t(out));
  return { cues, narration, out, recipe, fresh };
}

export function ensureMusicMix(work) {
  const { cues, narration, out, recipe, fresh } = musicMixState(work);
  if (!cues.length) return null;
  mkdirSync(dirname(out), { recursive: true });
  if (!existsSync(narration)) return { ok: false, error: 'the narration is missing (out/voice/narration.wav)' };
  if (fresh) return { ok: true, path: out, fresh: false };
  const all = readOr(join(work, 'music', 'cues.json'), { cues: [] }).cues;
  const r = mixMusic({ narration, cues: cues.map((c) => ({ ...c, file: join(work, c.file) })), allCues: all, timing: readOr(join(work, 'voice', 'timing.json'), { lines: [] }), out });
  if (r.ok) writeFileSync(recipe, MIX_RECIPE);
  return r.ok ? { ok: true, path: out, fresh: true } : { ok: false, error: r.error };
}
const MIX_RECIPE = 'v2: duck per line (gap 0.25, ramp 0.15), bed at -18 LUFS by the cue\'s own loudness';
