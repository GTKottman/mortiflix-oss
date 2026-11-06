// Sound stage (v3 stage 6): every visible action gets its own sound effect, made AFTER the motion is OK'd.
//   sfx.plan.make  cue list from the finished motion (library match first, else "generate")
//   sfx.plan       the saved plan + credit estimate
//   sfx.make       {cue|all, confirm}: ElevenLabs sound generation; without confirm only the estimate, no network
//   sfx.set / sfx.ok / sfx.cut   edit one cue
//   sfx.mix        ffmpeg: voice+music (or narration) + every kept sound at its time -> out/sound/final-mix.wav
// Files in the project: sound/sfx-plan.json, sound/sfx/<id>.mp3, sound/calls.jsonl (every paid call), out/sound/final-mix.wav.
// Where the action times come from, best first: video/src/actions.json (the motion step writes
// [{shot, at_sec|at_frame, dur_sec?, what, sound?}]), else the `cues` block of video/src/timing.ts evaluated over the
// narration's word timings (voice-timing.json), the way the scenes themselves are timed.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectPaths } from '../projects.mjs';
import { elevenKey } from '../voice/index.mjs';
import { cacheKey, cacheHas, cacheCopy, cachePut, cachePath } from './elcache.mjs';
import { TIMEOUT_MS, timeoutSignal, lostWhy, elevenWhy } from '../voice/elevenlabs.mjs';
import { rememberQuote, takeQuote } from './paidgate.mjs';
import { recordForWork } from './ledger.mjs';
import { writeJson } from '../studio.mjs';

// ElevenLabs sound generation, credits per second of sound: measured from the real calls (sound/calls.jsonl in every
// project, answered 200, not estimated); 2026-11-02 every one was 7 credits for 0.6 s, so ~11.7/s, not the 20/s the
// estimate used (61dc: ~20 shown per new sound, 7 charged). CREDITS_PER_SECOND is the fallback with no calls yet.
export const CREDITS_PER_SECOND = 12;
let rateMemo = { at: 0, dir: null, rate: CREDITS_PER_SECOND, calls: 0 };
export function measuredRate(projectsDir) {
  if (!projectsDir) return rateMemo.rate;
  if (rateMemo.dir === projectsDir && Date.now() - rateMemo.at < 10_000) return rateMemo.rate;
  let credits = 0, seconds = 0, calls = 0;
  let ids = []; try { ids = readdirSync(projectsDir); } catch { /* none */ }
  for (const id of ids) {
    let text = ''; try { text = readFileSync(join(projectsDir, id, 'sound', 'calls.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.ok && j.status === 200 && j.cache !== 'hit' && !j.credits_estimated && Number(j.credits) > 0 && Number(j.seconds) > 0) { credits += Number(j.credits); seconds += Math.max(0.5, Number(j.seconds)); calls++; }
    }
  }
  rateMemo = { at: Date.now(), dir: projectsDir, rate: calls ? credits / seconds : CREDITS_PER_SECOND, calls };
  return rateMemo.rate;
}
const projectsOf = (work) => join(work, '..');
export const BILLING = [401, 402, 429];
const SFX_MODEL = 'eleven_text_to_sound_v2';
const PROMPT_INFLUENCE = 0.5;
const LIBRARY = () => process.env.MFX_SFX_LIBRARY || join(homedir(), 'MortiDrive', 'files', 'Sound Effects', 'ElevenLabs');
const r3 = (n) => Math.round(n * 1000) / 1000;
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function soundPaths(work) {
  return {
    dir: join(work, 'sound'), plan: join(work, 'sound', 'sfx-plan.json'), files: join(work, 'sound', 'sfx'),
    calls: join(work, 'sound', 'calls.jsonl'), mixOut: join(work, 'out', 'sound', 'final-mix.wav'),
  };
}

// ---- reading the motion ----
const HINTS = [
  [/tick|check/, 'Pencil tick, short dry scratch'], [/pop|row|item|card/, 'Soft bubble pop, bright'],
  [/title|header|name|label|callit/, 'Marker pen writing a heading'], [/caption|text/, 'Soft keyboard tap, quiet'],
  [/arrow|slide|web|engine|shelf/, 'Soft whoosh, paper slides across a desk'], [/fire|stranger|key/, 'Low soft thud, digital'],
  [/patch/, 'Short confident click, UI confirm'],
];
const words = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const pretty = (s) => (/\s/.test(s) ? s : words(s).join(' ').replace(/^./, (m) => m.toUpperCase()));
const hint = (name) => (HINTS.find(([re]) => re.test(name.toLowerCase())) || [null, `Soft UI sound for ${words(name).join(' ')}`])[1];

// The `cues` block of timing.ts is written by the AI, so it is read, never run (MDN eval / Function(): "evaluate
// arbitrary code"; for data, use a data parser). This strict reader takes only what the block holds: objects, arrays,
// numbers, strings, + - * / and parentheses, and calls to the functions given (word, rel, sec). Anything else throws.
export function readCues(src, fns) {
  let i = 0;
  const fail = (why) => { throw new Error(`timing.ts cues: ${why} at ${i}`); };
  const skip = () => {
    for (;;) {
      if (/\s/.test(src[i] || '')) i++;
      else if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e + 1; }
      else if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); if (e < 0) fail('open comment'); i = e + 2; }
      else return;
    }
  };
  const peek = () => { skip(); return src[i]; };
  const eat = (ch) => { if (peek() !== ch) fail(`expected ${ch}`); i++; };
  const ident = () => { skip(); const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i)); if (!m) fail('expected a name'); i += m[0].length; return m[0]; };
  const str = () => { const q = src[i++]; let s = ''; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; s += src[i++]; } if (src[i] !== q) fail('open string'); i++; return s; };
  const numb = () => { const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i)); if (!m) fail('expected a number'); i += m[0].length; return Number(m[0]); };
  const isNum = (v) => (typeof v === 'number' ? v : fail('arithmetic on a non-number'));
  function primary() {
    const c = peek();
    if (c === '(') { i++; const v = expr(); eat(')'); return v; }
    if (c === '"' || c === "'") return str();
    if (/[\d.]/.test(c || '')) return numb();
    const name = ident();
    if (!Object.hasOwn(fns, name)) fail(`unknown name ${name}`);
    eat('(');
    const args = [];
    if (peek() !== ')') { args.push(expr()); while (peek() === ',') { i++; args.push(expr()); } }
    eat(')');
    return fns[name](...args);
  }
  function unary() { const c = peek(); if (c === '-' || c === '+') { i++; const v = isNum(unary()); return c === '-' ? -v : v; } return primary(); }
  function term() { let v = unary(); while (peek() === '*' || peek() === '/') { const op = src[i++]; const b = isNum(unary()); v = op === '*' ? isNum(v) * b : isNum(v) / b; } return v; }
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const op = src[i++]; const b = isNum(term()); v = op === '+' ? isNum(v) + b : isNum(v) - b; } return v; }
  function value() {
    const c = peek();
    if (c === '{') {
      i++; const o = {};
      while (peek() !== '}') {
        const k = peek() === '"' || peek() === "'" ? str() : /\d/.test(peek()) ? String(numb()) : ident();
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') fail(`key ${k}`);
        eat(':'); o[k] = value();
        if (peek() === ',') i++; else if (peek() !== '}') fail('expected , or }');
      }
      i++; return o;
    }
    if (c === '[') {
      i++; const a = [];
      while (peek() !== ']') { a.push(value()); if (peek() === ',') i++; else if (peek() !== ']') fail('expected , or ]'); }
      i++; return a;
    }
    return expr();
  }
  const v = value();
  if (peek() !== undefined) fail('text after the cues');
  return v;
}

// Read the `cues` block of timing.ts (plain expressions over word()/rel()/sec()) with the narration's timings.
export function cuesFromTiming(work) {
  const src = join(work, 'video', 'src');
  const ts = existsSync(join(src, 'timing.ts')) ? readFileSync(join(src, 'timing.ts'), 'utf8') : null;
  const voice = readJson(join(src, 'voice-timing.json')) || readJson(join(work, 'voice', 'timing.json'));
  if (!ts || !voice) return [];
  const fps = Number(/fps:\s*(\d+)/.exec(readFileSync(join(src, 'video.ts'), 'utf8') || '')?.[1]) || 30;
  const start = ts.indexOf('export const cues');
  const open = ts.indexOf('{', start);
  if (start < 0 || open < 0) return [];
  let depth = 0, end = open;
  for (; end < ts.length; end++) { if (ts[end] === '{') depth++; else if (ts[end] === '}' && --depth === 0) break; }
  const lines = voice.lines;
  const line = (id) => lines.find((l) => l.id === id) || (() => { throw new Error(`no line ${id}`); })();
  const sec = (s) => Math.round(s * fps);
  const word = (id, i) => sec(line(id).words[i].start);
  const firstOf = (b) => lines.find((l) => l.id.startsWith(`${b}-`));
  const rel = (b, f) => f - sec(firstOf(b)?.start ?? 0);
  let cues;
  try { cues = readCues(ts.slice(open, end + 1), { word, rel, sec }); } catch { return []; }
  const beatStart = (b) => sec(firstOf(b)?.start ?? 0) / fps;
  const out = [];
  for (const [shot, c] of Object.entries(cues)) {
    for (const [name, v] of Object.entries(c)) {
      (Array.isArray(v) ? v : [v]).forEach((rf, i, a) => {
        if (!Number.isFinite(rf)) return;
        const label = a.length > 1 || Array.isArray(v) ? `${name} ${i + 1}` : name;
        out.push({ shot, at_sec: r3(beatStart(shot) + rf / fps), what: words(label).join(' ').replace(/^./, (m) => m.toUpperCase()), sound: hint(name) });
      });
    }
  }
  return out;
}

export function actionsOf(work) {
  const f = readJson(join(work, 'video', 'src', 'actions.json'));
  const fps = 30;
  if (Array.isArray(f) && f.length) {
    return f.map((a) => ({ shot: String(a.shot), at_sec: a.at_sec ?? r3((a.at_frame ?? 0) / (a.fps || fps)), dur_sec: a.dur_sec ?? (a.dur_frames ? r3(a.dur_frames / (a.fps || fps)) : null), what: pretty(String(a.what || a.name || 'Action')), sound: a.sound || a.prompt || hint(String(a.what || '')), raw: !(a.sound || a.prompt) }));
  }
  return cuesFromTiming(work);
}

// ---- beats: what a sound designer would mark ----
// The motion data lists every element that moves (d4fd: 284 actions in 62 s, 189 sounds to make, ~4300 credits). A
// sound goes on a meaningful beat only: actions that start within `gap` s are one beat (an element's children move
// together), exits, colour/text changes and tiny moves are left out, the strongest beats are kept at most one per
// `per` s (and `minSpace` s apart), each scene's first beat first. One kind of move gets one sound, reused.
export const VERB_SOUND = {
  'slides in': ['Soft whoosh, paper slides across a desk', 0.6, 3],
  appears: ['Soft bubble pop, bright', 0.5, 2],
  moves: ['Light airy swish', 0.5, 2],
  scales: ['Soft rising pop', 0.5, 2],
};
const SKIP = /\b(leaves|changes|fades out|exits)\b/;
export function soundBeats(acts, { seconds = null, gap = 0.15, per = 1.75, minSpace = 0.5 } = {}) {
  // "5 elements slides in" (merged by the motion data) or "<layer id> slides in" (one element)
  const VERB = /(slides in|appears|leaves|changes|moves|scales|fades out|exits)$/i;
  const parsed = acts.map((a) => { const w = String(a.what); const m = /^(\d+) elements? (.+)$/i.exec(w); return { ...a, n: m ? Number(m[1]) : 1, verb: String(m ? m[2] : (VERB.exec(w)?.[1] ?? w)).toLowerCase().trim() }; })
    .filter((a) => !SKIP.test(a.verb) && !((a.dur_sec ?? 1) < 0.1 && a.n <= 2))
    .sort((p, q) => p.at_sec - q.at_sec);
  const clusters = [];
  for (const a of parsed) {
    const last = clusters.at(-1);
    if (last && last.shot === a.shot && a.at_sec - last.at_sec <= gap) last.members.push(a);
    else clusters.push({ shot: a.shot, at_sec: a.at_sec, members: [a] });
  }
  const seen = new Set();
  for (const c of clusters) {
    const w = (a) => a.n * (VERB_SOUND[a.verb]?.[2] ?? 2);
    c.lead = c.members.reduce((p, q) => (w(q) > w(p) ? q : p));
    c.weight = c.members.reduce((t, a) => t + w(a), 0);
    c.first = !seen.has(c.shot); seen.add(c.shot);
  }
  const span = seconds ?? Math.max(0, ...acts.map((a) => a.at_sec + (a.dur_sec || 0)));
  const cap = Math.max(1, Math.round(span / per));
  const picked = [];
  for (const c of [...clusters].sort((p, q) => (q.first - p.first) || (q.weight - p.weight) || (p.at_sec - q.at_sec))) {
    if (picked.length >= cap) break;
    if (picked.some((x) => Math.abs(x.at_sec - c.at_sec) < minSpace)) continue;
    picked.push(c);
  }
  return picked.sort((p, q) => p.at_sec - q.at_sec).map((c) => {
    const kind = VERB_SOUND[c.lead.verb];
    const n = c.members.reduce((t, a) => t + a.n, 0);
    return { shot: c.shot, at_sec: c.at_sec, dur_sec: kind ? kind[1] : c.lead.dur_sec, what: kind ? `${c.lead.verb.replace(/^./, (m) => m.toUpperCase())} (${n} element${n === 1 ? '' : 's'})` : c.lead.what, sound: kind ? kind[0] : c.lead.sound, merged: c.members.length };
  });
}
// one made sound per prompt and length: the cues that repeat it reuse it (makeSounds' cache), and cost nothing more
const soundKey = (c) => `${c.prompt}|${Math.max(0.5, c.dur_sec)}`;
export const uniqueCredits = (cues) => { const seen = new Set(); let n = 0; for (const c of cues) { const k = soundKey(c); if (seen.has(k)) continue; seen.add(k); n += creditsFor(c); } return n; };

// ---- library ----
export function loadLibrary(dir = LIBRARY()) {
  const items = readJson(join(dir, 'index.json'), []);
  return (Array.isArray(items) ? items : []).filter((i) => i.file && existsSync(join(dir, i.file))).map((i) => ({ ...i, abs: join(dir, i.file), tokens: new Set(words(`${i.name} ${i.prompt} ${i.category}`)) }));
}
const STOP = new Set(['a', 'the', 'of', 'in', 'on', 'with', 'and', 'soft', 'short']);
// A library sound must fit the action (2026-11-02, bdb9: "page ripped in two" got "big block letters landing on paper",
// "page folds up" got "armful of cards swept off a table"). The description's verb (its first one: tear, fold, slam,
// stamp, whoosh, click, snap, zap, pop, ...) must be the library sound's verb too, and its material (paper, metal,
// plastic, ...) must not differ; below MATCH_MIN the cue becomes a new sound instead. Each match says why (`match`).
export const ACTION_VERBS = {
  tear: /\b(tear|tears|tearing|torn|rip|rips|ripped|ripping|shred\w*)\b/,
  fold: /\b(fold|folds|folded|folding|crease\w*|crumpl\w*)\b/,
  stamp: /\b(stamp|stamps|stamped|stamping)\b/,
  slam: /\b(slam\w*|thud\w*|thump\w*|slap\w*|smack\w*|bang\w*|drop|drops|dropped|land|lands|landing|impact\w*|press|pressed|presses|pound\w*)\b/,
  whoosh: /\b(whoosh\w*|swish\w*|swoosh\w*|sweep\w*|swept|slide|slides|sliding|slid|swing\w*|fly|flies|flying|flung|throw\w*|thrown)\b/,
  click: /\b(click\w*|tick|ticks|ticking|ticked|blip\w*|beep\w*)\b/,
  snap: /\b(snap\w*)\b/,
  pin: /\b(pin|pins|pinned|clip|clips|clipped)\b/,
  zap: /\b(zap\w*|spark\w*|electric\w*|buzz\w*)\b/,
  pop: /\b(pop|pops|popping|popped|bubble)\b/,
  ring: /\b(ring|rings|ringing|ringtone\w*|chime\w*|bell\w*|ding\w*)\b/,
  pull: /\b(yank\w*|pull|pulls|pulled|unplug\w*|plug)\b/,
};
export const MATERIALS = {
  paper: /\b(paper\w*|page|pages|sheet|sheets|card|cards|cardstock|cardboard|envelope|letter|ticket|calendar|scrap|folder|tag)\b/,
  metal: /\b(metal\w*|steel|iron|chain|coin\w*|tin)\b/,
  plastic: /\b(plastic)\b/,
  wood: /\b(wood\w*|board)\b/,
  glass: /\b(glass)\b/,
  electronic: /\b(electronic|digital|scan\w*|beep\w*|blip\w*)\b/,
  electric: /\b(electric\w*|spark\w*|zap\w*|socket|plug\w*|cable|cord)\b/,
};
const firstVerb = (t) => { let best = null; for (const [k, re] of Object.entries(ACTION_VERBS)) { const m = re.exec(t); if (m && (!best || m.index < best[1])) best = [k, m.index]; } return best?.[0] || null; };
const verbsOf = (t) => Object.keys(ACTION_VERBS).filter((k) => ACTION_VERBS[k].test(t));
const materialsOf = (t) => Object.keys(MATERIALS).filter((k) => MATERIALS[k].test(t));
export const MATCH_MIN = 0.7;
// A library sound whose name has a recognisable source (a phone ringtone, an alarm, a voice, an animal...) fits only an
// action that names that source too (2026-11-02, bdb9: "camera lock-on beep click" got "rapid cascade of phone
// ringtones and electronic blips" through its "blips", twice; Dir1 cut both).
export const SIGNATURES = {
  phone: /\b(phone\w*|ringtone\w*|ringing|telephone|cellphone|smartphone|notification\w*)\b/,
  alarm: /\b(alarm\w*|siren\w*|klaxon\w*)\b/,
  bell: /\b(bell\w*|chime\w*|church)\b/,
  voice: /\b(voice\w*|laugh\w*|scream\w*|shout\w*|whisper\w*|crowd\w*|applause|cheer\w*|gasp\w*|sigh\w*|breath\w*)\b/,
  animal: /\b(dog\w*|cat|cats|bird\w*|horse\w*|cow\w*|bark\w*|meow\w*|chirp\w*)\b/,
  vehicle: /\b(car horn|horn\w*|engine\w*|motor\w*|tyre\w*|tire screech\w*)\b/,
  music: /\b(music\w*|melod\w*|guitar\w*|piano\w*|drum\w*|choir\w*)\b/,
  water: /\b(water\w*|splash\w*|rain\w*|drip\w*|pour\w*)\b/,
  fire: /\b(fire\w*|flame\w*|explosion\w*|explod\w*)\b/,
  glass: /\b(glass\w*|shatter\w*)\b/,
};
const signaturesOf = (t) => Object.keys(SIGNATURES).filter((k) => SIGNATURES[k].test(t));
export function matchLibrary(prompt, dur, lib, { what = '' } = {}) {
  const text = String(prompt).toLowerCase();
  const want = words(prompt).filter((w) => !STOP.has(w));
  if (!want.length) return null;
  const verb = firstVerb(text) || firstVerb(String(what).toLowerCase());
  const mats = materialsOf(`${text} ${String(what).toLowerCase()}`);
  let best = null;
  for (const it of lib) {
    const lenOk = !dur || !it.length_s || it.length_s >= dur * 0.6;
    if (!lenOk) continue;
    const name = String(it.name || '').toLowerCase();
    const desc = `${name} ${String(it.prompt || '').toLowerCase()}`;
    const words_ = want.filter((w) => it.tokens.has(w)).length / want.length;
    const asked = `${text} ${String(what).toLowerCase()}`;
    if (signaturesOf(name).some((k) => !SIGNATURES[k].test(asked))) continue;
    let score, why;
    if (verb) {
      // the verb must be in the library sound's own name (its prompt says how it was made, not what it is)
      const itVerbs = verbsOf(name);
      if (!itVerbs.includes(verb)) continue;
      const itMats = materialsOf(desc);
      const matOk = !mats.length || !itMats.length || mats.some((m) => itMats.includes(m));
      if (!matOk) continue;
      const matHit = mats.length && itMats.some((m) => mats.includes(m));
      score = 0.55 + (matHit ? 0.25 : mats.length ? 0 : 0.15) + 0.2 * words_;
      why = `${verb}${matHit ? ` + ${mats.find((m) => itMats.includes(m))}` : ''}`;
    } else {
      score = words_;
      why = 'same words';
    }
    if (score >= MATCH_MIN && (!best || score > best.score)) best = { item: it, score, why };
  }
  return best ? { ...best.item, match: `${best.why}: "${best.item.name}" (${Math.round(best.score * 100)}%)` } : null;
}
// why no library sound was used: the action's verb and material, for the row
export const noMatchWhy = (prompt, what = '') => {
  const t = String(prompt).toLowerCase();
  const v = firstVerb(t) || firstVerb(String(what).toLowerCase());
  const m = materialsOf(`${t} ${String(what).toLowerCase()}`);
  return `no library sound fits ${v ? `"${v}${m.length ? ` + ${m[0]}` : ''}"` : 'these words'}`;
};

// ---- plan ----
const gen = (c) => c.source === 'generate' && c.status !== 'cut';
const fileOf = (c) => (c.file && existsSync(c.file) ? c.file : c.source === 'library' && c.library_file && existsSync(c.library_file) ? c.library_file : null);
export const creditsFor = (c, rate = measuredRate()) => (c.source === 'generate' ? Math.max(1, Math.ceil(Math.max(0.5, c.dur_sec) * rate - 1e-6)) : 0);
// cached(c): the sound is already in the studio's library of made sounds, so making it costs nothing
export function summary(plan, { cached = () => false } = {}) {
  const live = plan.cues.filter((c) => c.status !== 'cut');
  const todo = live.filter((c) => gen(c) && !c.file && !cached(c));
  return { cues: live.length, library: live.filter((c) => c.source === 'library').length, new: live.filter((c) => c.source === 'generate').length, to_make: todo.length, sounds_to_make: new Set(todo.map(soundKey)).size, credits: uniqueCredits(todo), made: live.filter((c) => c.source === 'generate' && c.file).length };
}
// Shots with their time range, name and where the narration speaks (for the lanes).
export function shotsOf(work, plan) {
  const voice = readJson(join(work, 'video', 'src', 'voice-timing.json')) || readJson(join(work, 'voice', 'timing.json'));
  let names = {};
  try { for (const f of readdirSync(join(work, 'video', 'src', 'scenes'))) { const m = /^([A-Za-z]\d+)(.*)\.tsx$/.exec(f); if (m) names[m[1].toLowerCase()] = m[2].replace(/([a-z])([A-Z])/g, '$1 $2').trim(); } } catch { /* none */ }
  const ids = plan.shots;
  // the approved motion's own scenes (out/scenes.json: key s01, beat b01, frames): each shot's real range and its clip
  // (2026-11-02, d4fd: voice lines are b01-1, never s01-…, so every shot ran 0:00 to the end and had no picture)
  const sj = readJson(join(work, 'out', 'scenes.json'));
  const clips = readJson(join(work, 'out', 'scenes', 'clips.json'), []) || [];
  const fpsJ = Number(sj?.fps) || 30;
  const sceneOf = (id) => (sj?.scenes || []).find((x) => x.key === id);
  if (sceneOf(ids[0])) {
    return ids.map((id, i) => {
      const sc = sceneOf(id);
      if (!sc) return { id, number: i + 1, name: names[id] || '', from: 0, to: 0, talk: [] };
      const from = r3(sc.from_frame / fpsJ), to = r3((sc.from_frame + sc.frames) / fpsJ);
      const mine = (voice?.lines || []).filter((l) => sc.beat && l.id.startsWith(`${sc.beat}-`));
      // the approved clip: scenes.json's own file (every layout writes it; bdb9's are s01-e011.mp4…), placed by
      // clips.json when that lists it, else starting at the scene; then clips.json by beat
      const own = sc.file && existsSync(join(work, sc.file)) ? join(work, sc.file) : null;
      const byFile = own && clips.find((x) => x.file === basename(own));
      const c = clips.find((x) => (x.beats || []).includes(sc.beat));
      const clip = own ? { path: own, from_sec: byFile ? Math.max(0, r3(from - byFile.from / fpsJ)) : 0 }
        : c && existsSync(join(work, 'out', 'scenes', c.file)) ? { path: join(work, 'out', 'scenes', c.file), from_sec: Math.max(0, r3(from - c.from / fpsJ)) } : null;
      return { id, beat: sc.beat || null, number: i + 1, name: sc.name || names[id] || '', from, to, talk: mine.flatMap((l) => (l.words || []).map((w) => [w.start, w.end])), clip };
    });
  }
  return ids.map((id, i) => {
    const mine = (voice?.lines || []).filter((l) => l.id.startsWith(`${id}-`));
    const nextLine = ids[i + 1] && (voice?.lines || []).find((l) => l.id.startsWith(`${ids[i + 1]}-`));
    const cues = plan.cues.filter((c) => c.shot === id);
    const from = mine.length ? mine[0].start : Math.min(...cues.map((c) => c.at_sec));
    const to = nextLine ? nextLine.start : voice?.seconds ?? Math.max(...cues.map((c) => c.at_sec + c.dur_sec));
    return { id, number: i + 1, name: names[id] || '', from: r3(from), to: r3(to), talk: mine.flatMap((l) => (l.words || []).map((w) => [w.start, w.end])) };
  });
}
// ready: every cue (so every shot) is OK or cut; nothing made yet is not ready
export const planReady = (plan) => plan.cues.length > 0 && plan.cues.every((c) => c.status === 'ok' || c.status === 'cut');
// a cue that reuses another's sound names it (shot number and time), so the screen says "same sound, no extra credits"
const withReuse = (plan) => { const first = new Map(); return plan.cues.map((c) => { if (c.source !== 'generate' || c.status === 'cut') return c; const k = soundKey(c); const f = first.get(k); if (!f) { first.set(k, c); return c; } return { ...c, reuse: { id: f.id, shot: f.shot, shot_number: plan.shots.indexOf(f.shot) + 1, at_sec: f.at_sec } }; }); };
const sfxKey = (c) => cacheKey({ kind: 'sfx', prompt: c.prompt, seconds: Math.max(0.5, c.dur_sec), model: SFX_MODEL, influence: PROMPT_INFLUENCE });
// each row's own cost (what the footer adds up): 0 when made, cached, or the same sound as an earlier row
const view = (work) => {
  const p = soundPaths(work); const plan = readJson(p.plan);
  if (!plan) return null;
  const root = join(work, '..', '..');
  const rate = measuredRate(projectsOf(work));
  const cached = (c) => { try { return cacheHas(root, sfxKey(c)); } catch { return false; } };
  const cues = withReuse(plan).map((c) => {
    if (c.source !== 'generate' || c.status === 'cut' || c.file) return c;
    const inLib = cached(c);
    return { ...c, ...(inLib ? { cached: true } : {}), credits: inLib || c.reuse ? 0 : creditsFor(c, rate) };
  });
  return { ...plan, cues, shots: shotsOf(work, plan), base: baseAudio(work), summary: { ...summary(plan, { cached }), credit_rate: Math.round(rate * 100) / 100 }, ready: planReady(plan) };
};
const save = (work, plan) => { const p = soundPaths(work); mkdirSync(p.dir, { recursive: true }); writeJson(p.plan, plan); };

export function makePlan(work, { library, story = null } = {}) {
  const all = actionsOf(work);
  if (!all.length && !story?.length) throw Object.assign(new Error('no motion yet: the sound comes after the motion is OK\'d'), { code: 'not_ready' });
  const voice = readJson(join(work, 'voice', 'timing.json'));
  // only the motion data's raw moves ("N elements appears") are reduced to beats; cues the motion's code names itself
  // (timing.ts cues, actions with their own sound) were chosen on purpose and stay as they are
  const raw = all.filter((a) => a.raw);
  // story actions (svc/storysfx.mjs) replace the raw moves when given: the sounds mark what happens in the story
  const acts = story?.length
    ? [...all.filter((a) => !raw.includes(a)), ...story.map((a) => ({ ...a, merged: 1 }))]
    : [...all.filter((a) => !raw.includes(a)), ...(raw.length ? soundBeats(raw, { seconds: Number(voice?.seconds) || null }) : [])];
  const prev = readJson(soundPaths(work).plan);
  const lib = loadLibrary(library);
  acts.sort((a, b) => a.at_sec - b.at_sec);
  const sceneKeys = (readJson(join(work, 'out', 'scenes.json'))?.scenes || []).map((x) => x.key);
  const shots = sceneKeys.length ? sceneKeys : [...new Set(acts.map((a) => a.shot))];
  // kept: the owner's OK'd/edited cues and made sounds survive a re-plan; an untouched pick is matched again. A kept cue
  // keeps its id, each old cue is kept once, and the new cues take ids no kept cue has (a re-plan gave two cues one id).
  const usedOld = new Set(); const taken = new Set();
  const keptOf = acts.map((a) => {
    const old = (prev?.cues || []).find((c) => !usedOld.has(c) && c.at_sec === a.at_sec && c.what === a.what && c.shot === a.shot);
    if (!(old && (old.status === 'ok' || old.status === 'cut' || (old.source === 'generate' && old.file) || old.gain_db))) return null;
    usedOld.add(old);
    if (taken.has(old.id)) return { ...old, id: null }; // a duplicate left by an earlier re-plan: a new id below
    taken.add(old.id);
    return old;
  });
  let n = 0;
  const nextId = () => { let id; do id = `fx${String(++n).padStart(2, '0')}`; while (taken.has(id)); taken.add(id); return id; };
  const cues = acts.map((a, i) => {
    const dur = Math.max(0.5, Math.min(30, r3(a.dur_sec ?? 0.8)));
    const old = keptOf[i];
    if (old) return old.id ? old : { ...old, id: nextId() };
    const id = nextId();
    const hit = matchLibrary(a.sound, dur, lib, { what: a.what });
    let copy = null;
    if (hit) { mkdirSync(soundPaths(work).files, { recursive: true }); copy = join(soundPaths(work).files, `${id}-library.mp3`); copyFileSync(hit.abs, copy); }
    return { id, shot: a.shot, at_sec: a.at_sec, dur_sec: dur, what: a.what, prompt: a.sound, merged: a.merged, source: hit ? 'library' : 'generate', ...(hit ? { library_file: hit.abs, library_name: hit.name, file: copy, match: hit.match } : { match: noMatchWhy(a.sound, a.what) }), gain_db: 0, status: hit ? 'ready' : 'planned' };
  });
  // a cue that repeats an earlier one's sound reuses it (named, so the screen can say so)
  const firstOf = new Map();
  for (const c of cues) { if (c.source !== 'generate') continue; const k = soundKey(c); if (firstOf.has(k)) c.reuse_of = firstOf.get(k); else { firstOf.set(k, c.id); delete c.reuse_of; } }
  const plan = { made: new Date().toISOString(), shots, cues, from_actions: all.length, from: story?.length ? 'story' : 'moves' };
  save(work, plan);
  return view(work);
}

// ---- generation ----
const log = (work, row) => { if (row.cache !== 'hit') recordForWork(work, { kind: 'sfx', model: SFX_MODEL, credits: row.ok ? Number(row.credits) || 0 : 0, estimated: row.ok && Boolean(row.credits_estimated), seconds: row.seconds, ok: row.ok !== false }); const p = soundPaths(work); mkdirSync(p.dir, { recursive: true }); appendFileSync(p.calls, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); };
function probeSeconds(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 60_000 });
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) && n > 0 ? r3(n) : null;
}

// A made sound must be audible (2026-11-02, 61dc fx32 "thick liquid slosh": -56 dB mean, -36 dB peak, shown as
// "Made · to check"). Peak under SILENT_PEAK dBFS: the cue stays unmade with `failed` saying so, it is not cached, and
// it is never made again on its own (the owner presses Make again).
export const SILENT_PEAK = -20;
export function peakOf(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 });
  const m = String(r.stderr || '').match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!m) return null;
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}
const silentWhy = (peak) => `came back nearly silent (peak ${peak === -Infinity ? '-inf' : peak.toFixed(1)} dBFS)`;

// Stop for a paid batch (sfx.cancel): the batch stops after the sound being made now (that request is never cut off
// mid-way: it may already be paid). `running`: the project work folders with a paid batch in progress.
const running = new Set(); const stopAsked = new Set();
/** Whether a paid sound batch is being made for this work folder now (project.delete refuses then). */
export const soundsRunning = (work) => running.has(work);
export function cancelSounds(work) {
  if (!running.has(work)) return { cancelled: false, running: false };
  stopAsked.add(work);
  return { cancelled: true, running: true, note: 'stops after the sound being made now' };
}

export async function makeSounds(root, work, { cue, shot, all, confirm } = {}, { fetchImpl = globalThis.fetch } = {}) {
  const plan = readJson(soundPaths(work).plan);
  if (!plan) throw Object.assign(new Error('make the cue list first (sfx.plan.make)'), { code: 'not_ready' });
  const pick = cue ? plan.cues.filter((c) => c.id === cue) : shot ? plan.cues.filter((c) => c.shot === shot) : all ? plan.cues : [];
  if (!pick.length) throw Object.assign(new Error(cue ? `no cue ${cue}` : shot ? `no shot ${shot}` : 'say which: cue, shot or all'), { code: 'bad_request' });
  const p = soundPaths(work);
  const keyOf = sfxKey;
  measuredRate(projectsOf(work));
  // the studio's own library first: a sound made in any project before costs nothing ("from your library"); one that
  // came back silent before is made anew. Only read here: the price question changes nothing (copied below, on confirm)
  const silentCached = (c) => { const pk = peakOf(cachePath(root, keyOf(c))); return pk !== null && pk < SILENT_PEAK; };
  const inLibrary = pick.filter((c) => gen(c) && !c.file && cacheHas(root, keyOf(c)) && !silentCached(c));
  const todo = pick.filter((c) => gen(c) && !c.file && !inLibrary.includes(c));
  const credits = uniqueCredits(todo); // a repeated sound is made once
  // exactly what would be paid for: a confirm pays only for what this price covered (svc/paidgate.mjs quotes)
  const what = { scope: cue ? { cue } : shot ? { shot } : { all: true }, sounds: todo.map((c) => `${c.id}|${soundKey(c)}`) };
  if (!confirm) {
    rememberQuote(work, 'sfx', what, credits);
    return { confirm_needed: true, needs_confirm: true, calls: todo.length, credits, credits_estimate: credits, from_library: inLibrary.map((c) => c.id), cues: todo.map((c) => ({ id: c.id, dur_sec: c.dur_sec, credits: creditsFor(c) })), summary: summary(plan, { cached: (c) => inLibrary.includes(c) }) };
  }
  const key = todo.length ? elevenKey(root) : null;
  if (todo.length && !key) throw Object.assign(new Error('no ElevenLabs key: add it in Settings first'), { code: 'no_key' });
  if (running.has(work)) throw Object.assign(new Error('sounds are being made for this project already'), { code: 'busy' });
  if (todo.length) takeQuote(work, 'sfx', what, credits); // nothing copied or paid when the price shown does not cover it
  running.add(work); stopAsked.delete(work);
  try {
  // the plan on disk may change while sounds are made (the owner OKs, cuts or edits a cue): each result goes into the
  // plan as it is then, onto its own cue only, and only while that cue still asks for the same sound (their edit wins)
  const commit = (c, set, drop = []) => {
    Object.assign(c, set); for (const k of drop) delete c[k];
    const now = readJson(p.plan);
    const x = now?.cues?.find((y) => y.id === c.id);
    if (!x || x.source !== 'generate' || soundKey(x) !== soundKey(c)) return false;
    const { status, ...rest } = set;
    Object.assign(x, rest); for (const k of drop) delete x[k];
    if (status !== undefined) { if (x.status === 'cut') x.was = status; else x.status = status; }
    save(work, now);
    return true;
  };
  const cached = [];
  for (const c of inLibrary) {
    mkdirSync(p.files, { recursive: true });
    const file = join(p.files, `${c.id}.mp3`);
    cacheCopy(root, keyOf(c), file);
    commit(c, { file, status: 'ready', made_sec: probeSeconds(file), from_library: true }, ['failed']);
    log(work, { cue: c.id, ok: true, cache: 'hit', credits: 0, seconds: c.dur_sec, prompt: c.prompt });
    cached.push(c.id);
  }
  mkdirSync(p.files, { recursive: true });
  const made = [];
  let stopped = null;
  const silentKeys = new Map(); // a sound that came back silent is not made again for its repeats in this run
  for (const c of todo) {
    if (stopAsked.has(work)) { stopped = { cancelled: true, cue: c.id, status: null, billing: false, error: 'stopped by you: the rest were not made' }; break; }
    if (silentKeys.has(soundKey(c))) { commit(c, { failed: silentKeys.get(soundKey(c)) }); continue; }
    if (cacheHas(root, keyOf(c)) && made.some((id) => plan.cues.find((x) => x.id === id && soundKey(x) === soundKey(c)))) { // the same sound was made earlier in this very run
      const file = join(p.files, `${c.id}.mp3`); cacheCopy(root, keyOf(c), file);
      commit(c, { file, status: 'ready', made_sec: probeSeconds(file), from_library: true });
      log(work, { cue: c.id, ok: true, cache: 'hit', credits: 0, seconds: c.dur_sec, prompt: c.prompt }); made.push(c.id); continue;
    }
    const body = { text: c.prompt, model_id: SFX_MODEL, prompt_influence: PROMPT_INFLUENCE, loop: false, duration_seconds: Math.max(0.5, c.dur_sec) };
    let res = null, err = null, bytes = null;
    for (let attempt = 0; attempt < 2; attempt++) { // at most 1 retry, and only after ElevenLabs answered with a server error
      try {
        res = await fetchImpl('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: timeoutSignal(TIMEOUT_MS.sound) });
      } catch (e) { err = lostWhy(e); res = null; break; } // no answer: never sent again, it may have been charged
      if (res.ok || res.status < 500) break; // billing, rate and request errors are never retried
    }
    if (res?.ok) { try { bytes = Buffer.from(await res.arrayBuffer()); } catch (e) { err = lostWhy(e); } }
    if (bytes) {
      const file = join(p.files, `${c.id}.mp3`);
      writeFileSync(file, bytes);
      const real = Number(res.headers?.get?.('character-cost')) || 0; // what ElevenLabs charged, when it says
      const pk = peakOf(file);
      if (pk !== null && pk < SILENT_PEAK) {
        // paid for, but not a sound: kept aside, not cached, the cue stays to make
        renameSync(file, join(p.files, `${c.id}.silent.mp3`));
        commit(c, { status: 'planned', failed: silentWhy(pk) }, ['file']); silentKeys.set(soundKey(c), c.failed);
        log(work, { cue: c.id, ok: true, status: res.status, seconds: c.dur_sec, credits: real || creditsFor(c), ...(real ? {} : { credits_estimated: true }), prompt: c.prompt, silent: true, peak_db: pk });
        continue;
      }
      cachePut(root, keyOf(c), bytes);
      commit(c, { file, status: 'ready', made_sec: probeSeconds(file) }, ['failed']);
      log(work, { cue: c.id, ok: true, status: res.status, seconds: c.dur_sec, credits: real || creditsFor(c), ...(real ? {} : { credits_estimated: true }), prompt: c.prompt, peak_db: pk });
      made.push(c.id);
    } else {
      const status = res && !res.ok ? res.status : null;
      const text = status ? elevenWhy(status, await res.text().catch(() => '')) : err;
      log(work, { cue: c.id, ok: false, status, error: text, prompt: c.prompt, ...(res?.ok ? { maybe_charged: true } : {}) });
      stopped = { cue: c.id, status, billing: BILLING.includes(status), error: text };
      break; // stop the batch on any failure
    }
  }
  const silent = todo.filter((c) => c.failed && !c.file).map((c) => ({ id: c.id, why: c.failed }));
  return { made, from_library: cached, stopped, silent, summary: summary(readJson(p.plan) || plan) };
  } finally { running.delete(work); stopAsked.delete(work); }
}

// ---- edits ----
function edit(work, id, fn) {
  const plan = readJson(soundPaths(work).plan);
  const c = plan?.cues.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error(`no cue ${id}`), { code: 'bad_request' });
  fn(c);
  save(work, plan);
  return { cue: c, summary: summary(plan) };
}
// a number the owner typed, or a plain refusal (Number('abc') is NaN, and NaN reached the mix as adelay=NaN)
const numberOf = (v, name) => { const n = Number(v); if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n)) throw Object.assign(new Error(`${name} must be a number`), { code: 'bad_request' }); return n; };
export function setCue(work, { cue, prompt, at_sec, dur_sec, gain_db, source }) {
  const at = at_sec !== undefined ? numberOf(at_sec, 'at_sec') : undefined;
  const gain = gain_db !== undefined ? numberOf(gain_db, 'gain_db') : undefined;
  const dur = dur_sec !== undefined ? numberOf(dur_sec, 'dur_sec') : undefined;
  return edit(work, cue, (c) => {
    if (at !== undefined) c.at_sec = Math.max(0, at);
    if (gain !== undefined) c.gain_db = Math.max(-40, Math.min(12, gain));
    const newDur = dur !== undefined ? Math.max(0.5, Math.min(30, dur)) : c.dur_sec;
    const remake = (prompt !== undefined && String(prompt) !== c.prompt) || newDur !== c.dur_sec || (source && source !== c.source);
    if (prompt !== undefined) c.prompt = String(prompt).slice(0, 400);
    c.dur_sec = newDur;
    if (source === 'generate' || source === 'library') c.source = source;
    if (remake && c.source === 'generate') { if (c.file) rmSync(c.file, { force: true }); delete c.file; delete c.made_sec; delete c.from_library; delete c.failed; c.status = 'planned'; }
    if (c.source === 'library' && !c.library_file) c.source = 'generate';
    if (c.source === 'library') c.status = c.status === 'ok' ? 'ok' : 'ready';
  });
}
export const okCue = (work, cue) => edit(work, cue, (c) => { if (!fileOf(c)) throw Object.assign(new Error('make this sound first'), { code: 'not_ready' }); c.status = 'ok'; });
export const cutCue = (work, cue, on = true) => edit(work, cue, (c) => { if (on) { c.was = c.status; c.status = 'cut'; } else c.status = c.was && c.was !== 'cut' ? c.was : (fileOf(c) ? 'ready' : 'planned'); });

// ---- mix ----
export function baseAudio(work) {
  for (const f of ['out/voice/mix.wav', 'out/mix.wav', 'out/audio/mix.wav', 'out/music/mix.wav', 'music/mix.wav', 'voice/mix.wav', 'out/narration.wav', 'out/voice/narration.wav', 'voice/narration.wav', 'voice/voice.wav']) if (existsSync(join(work, f))) return join(work, f);
  return null;
}
// levels: { [cue id]: gain dB } from svc/finalaudio.mjs levelSounds (each sound set under the voice); without it, the cue's own gain_db
export function mixSounds(work, { levels = null } = {}) {
  const plan = readJson(soundPaths(work).plan);
  if (!plan) throw Object.assign(new Error('no cue list yet'), { code: 'not_ready' });
  const base = baseAudio(work);
  if (!base) throw Object.assign(new Error('no voice/music mix to put the sounds on'), { code: 'not_ready' });
  const used = plan.cues.filter((c) => c.status !== 'cut' && fileOf(c));
  const p = soundPaths(work);
  mkdirSync(join(work, 'out', 'sound'), { recursive: true });
  const args = ['-y', '-v', 'error', '-i', base];
  const chains = ['[0:a]aresample=48000,aformat=channel_layouts=stereo[b]'];
  used.forEach((c, i) => {
    args.push('-i', fileOf(c));
    const ms = Math.round(c.at_sec * 1000);
    chains.push(`[${i + 1}:a]atrim=0:${c.dur_sec},asetpts=PTS-STARTPTS,afade=t=out:st=${Math.max(0, c.dur_sec - 0.05)}:d=0.05,aresample=48000,aformat=channel_layouts=stereo,volume=${levels?.[c.id] ?? (c.gain_db || 0)}dB,adelay=${ms}|${ms}[s${i}]`);
  });
  const inputs = ['[b]', ...used.map((_, i) => `[s${i}]`)].join('');
  chains.push(`${inputs}amix=inputs=${used.length + 1}:duration=first:normalize=0:dropout_transition=0[o]`);
  args.push('-filter_complex', chains.join(';'), '-map', '[o]', '-ar', '48000', p.mixOut);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 10 * 60_000 }); // a hung ffmpeg never holds the service for hours
  if (r.status !== 0) throw Object.assign(new Error(`ffmpeg: ${String(r.stderr).split('\n').filter(Boolean).at(-1) || 'failed'}`), { code: 'failed' });
  return { file: p.mixOut, base, sounds: used.length, seconds: probeSeconds(p.mixOut) };
}

// Why there is no sound to list: always a reason (2026-11-02, bdb9: "The service gave no reason").
export function emptyWhy(work, v = null) {
  let can = false; try { can = Boolean(actionsOf(work).length); } catch { /* the motion code can't be read */ }
  const src = join(work, 'video', 'src');
  const scenes = (readJson(join(work, 'out', 'scenes.json'))?.scenes || []).length;
  const plan = readJson(soundPaths(work).plan);
  const why = plan?.why
    || (scenes ? `the plan found no sound moments in the ${scenes} approved scenes: press Make it again, with a note naming the actions to mark`
      : !existsSync(join(src, 'timing.ts')) && !existsSync(join(src, 'actions.json'))
        ? 'the motion project is not built yet (no video/src/timing.ts or actions.json): the Motion step writes it'
        : 'the motion has no timed moments to put a sound on yet (video/src/actions.json, or the cues in timing.ts with the voice timing)');
  return { ...(v || {}), cues: [], shots: v?.shots || [], summary: v?.summary || null, ready: false, can_plan: can || scenes > 0, why };
}

// ---- protocol ----
export function sfxHandlers({ root, needProject, ProtocolError, poke = () => {}, fetchImpl }) {
  const wrap = (fn) => async (p) => {
    const work = projectPaths(root, needProject(p)).work;
    try { const r = await fn(work, p || {}); poke(); return r; } catch (e) {
      if (e instanceof ProtocolError) throw e;
      throw new ProtocolError(e.code || 'failed', e.message);
    }
  };
  return {
    // no plan and nothing to plan from: `why` says what is missing (Dir1 bdb9: "can't list the sounds yet", no reason)
    'sfx.plan': wrap((work) => { const v = view(work); if (v && v.cues.length) return v; return emptyWhy(work, v); }),
    'sfx.plan.make': wrap((work, p) => makePlan(work, { library: p.library })),
    'sfx.make': wrap((work, p) => makeSounds(root, work, { cue: p.cue === 'all' ? undefined : p.cue, shot: p.shot, all: p.all === true || p.cue === 'all', confirm: p.confirm === true }, { fetchImpl: fetchImpl || globalThis.fetch })),
    'sfx.set': wrap((work, p) => setCue(work, p)),
    'sfx.ok': wrap((work, p) => okCue(work, String(p.cue))),
    'sfx.cut': wrap((work, p) => cutCue(work, String(p.cue), p.cut !== false)),
    'sfx.mix': wrap((work) => mixSounds(work)),
    // stop a paid batch after the current sound; the sfx.make answer then lists what was made (stopped.cancelled)
    'sfx.cancel': wrap((work) => cancelSounds(work)),
  };
}
