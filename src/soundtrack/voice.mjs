// Soundtrack v1, the voice (owner, 2026-10-19: "a finished voice should be perfect if it's coming from 11 labs"). The
// narration comes from ElevenLabs as lossless 48 kHz PCM with its word timings and is never processed: no speed-up, no
// compressor, no limiter, no EQ, no loudness gain (the mix sets one plain gain for the whole soundtrack). The only edit
// is cutting each line's silent edges (below -50 dBFS, keeping a 60 ms lead and a 100 ms tail) and joining the lines
// with the script's gaps. The picture is cut to this voice, never the voice to the picture.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, utimesSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeWav } from './wav.mjs';
import { logVoiceUse } from '../voiceusage.mjs';
import { TIMEOUT_MS, timeoutSignal, lostWhy, elevenWhy } from '../voice/elevenlabs.mjs';

const RATE = 48000;
const FORMAT = 'pcm_48000'; // lossless; the best ElevenLabs gives on the Creator plan (44.1 kHz PCM needs Pro)
const SILENT = 10 ** (-50 / 20);
const LEAD = 0.06;
const TAIL = 0.1;

async function findVoice(key, name) {
  const r = await fetch(`https://api.elevenlabs.io/v2/voices?search=${encodeURIComponent(name)}&page_size=20`, { headers: { 'xi-api-key': key }, signal: timeoutSignal(TIMEOUT_MS.read) });
  // a refused key or a rate limit is said as such, never as "no voice named ..."
  if (!r.ok) throw new Error(`looking up the voice "${name}": ${elevenWhy(r.status, await r.text().catch(() => ''))}`);
  const v = (await r.json()).voices?.find((x) => x.name === name) || null;
  if (!v) throw new Error(`no ElevenLabs voice named "${name}"`);
  return v.voice_id;
}

// Words and their times from ElevenLabs' character alignment; performance tags ([warm, unhurried]) are not words.
export function wordsFrom(alignment) {
  const ch = alignment?.characters || []; const st = alignment?.character_start_times_seconds || []; const en = alignment?.character_end_times_seconds || [];
  const words = []; let cur = null; let tag = 0;
  ch.forEach((c, i) => {
    if (c === '[') tag++;
    if (tag) { if (c === ']') tag--; return; }
    if (/\s/.test(c)) { if (cur) words.push(cur); cur = null; return; }
    if (!cur) cur = { text: '', start: st[i], end: en[i] };
    cur.text += c; cur.end = en[i];
  });
  if (cur) words.push(cur);
  return words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));
}

// What a take depends on. Anything here changing makes the line's old take wrong; nothing else does (opt C1).
export function takeKey(l, { voiceId = null, model = 'eleven_v4', stability = 0.5, similarity = 0.75, style = null, speed = null, speakerBoost = true, format = FORMAT } = {}) {
  const text = String(l.text ?? '');
  const tags = [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim());
  return createHash('sha256').update(JSON.stringify({
    text, voice_id: voiceId, model, stability: l.stability ?? stability, similarity, style: l.style ?? style, speed: l.speed ?? speed,
    speaker_boost: speakerBoost, tags, role: l.role || 'narrator', output_format: format,
  })).digest('hex');
}

// Which lines need ElevenLabs (stale), which of those an archived take already covers (free), and what the rest costs.
// A take recorded before keys existed (no `key` in its json) counts as current while text, voice and model match.
// `force` (ids): a New take the owner OK'd: recorded fresh by ElevenLabs even when the cache or an archived take matches.
export function planLines({ work, lines, voiceId = null, model = 'eleven_v4', force = [], ...settings }) {
  const dir = join(work, 'sound', 'voice');
  const need = []; const restore = [];
  const fresh = new Set(force);
  for (const l of lines) {
    if (fresh.has(l.id)) { need.push({ line: l, key: takeKey(l, { voiceId, model, ...settings }) }); continue; }
    const pcm = join(dir, 'lines', `${l.id}.pcm`); const meta = join(dir, 'lines', `${l.id}.json`);
    const had = existsSync(pcm) && existsSync(meta) ? JSON.parse(readFileSync(meta, 'utf8')) : null;
    const id = voiceId || had?.voice_id || null;
    const key = takeKey(l, { voiceId: id, model, ...settings });
    const current = had && (had.key ? had.key === key : had.text === l.text && had.model === model && (!voiceId || had.voice_id === voiceId));
    if (current) continue;
    const arch = join(dir, 'takes', `${l.id}-${key.slice(0, 8)}`);
    if (existsSync(`${arch}.pcm`) && existsSync(`${arch}.json`)) restore.push({ line: l, arch, key }); else need.push({ line: l, key });
  }
  return { need, restore, characters: need.reduce((n, x) => n + String(x.line.text).length, 0) };
}

// Record the lines whose take key changed (sound/voice/lines/<id>.pcm + .json); a line already recorded is kept (owner,
// 2026-10-19: the voice starts when a scene is OK'd, lines recorded before stay). Every take is also kept in
// voice/takes/<id>-<key8>.pcm so switching a setting back costs nothing. `confirm: false` records nothing and makes no
// request: it returns the estimate ({needs_confirm, lines, characters}). Returns the ids recorded now.
export async function recordLines({ work, key, lines, voice = 'Tracy K', voiceId = null, model = 'eleven_v4', stability = 0.5, similarity = 0.75, style = null, speed = null, speakerBoost = true, confirm = true, maxCredits = null, rate = 1, force = [], log = () => {} }) {
  const dir = join(work, 'sound', 'voice');
  mkdirSync(join(dir, 'lines'), { recursive: true });
  mkdirSync(join(dir, 'takes'), { recursive: true });
  const settings = { stability, similarity, style, speed, speakerBoost };
  const plan = planLines({ work, lines, voiceId, model, force, ...settings });
  const restored = [];
  if (confirm !== false) {
    for (const r of plan.restore) {
      copyFileSync(`${r.arch}.pcm`, join(dir, 'lines', `${r.line.id}.pcm`)); copyFileSync(`${r.arch}.json`, join(dir, 'lines', `${r.line.id}.json`));
      restored.push(r.line.id);
    }
  }
  if (!plan.need.length) return { id: voiceId, recorded: [], restored };
  if (confirm === false) return { id: voiceId, recorded: [], restored: [], needs_confirm: true, lines: plan.need.map((x) => x.line.id), characters: plan.characters, credits_estimate: Math.ceil(plan.characters * rate) };
  // the owner's OK is a budget (src/svc/paidgate.mjs): a plan bigger than the credits OK'd records nothing and asks again
  // `rate`: credits per character (svc/voicecost.mjs creditRate), the same price the OK was given at
  const need = Math.ceil(plan.characters * rate);
  if (maxCredits != null && need > maxCredits) throw Object.assign(new Error(`the voice now needs about ${need} credits, more than the ${maxCredits} you OK'd: OK the new cost first`), { code: 'over_budget', credits: need });
  const id = voiceId || await findVoice(key, voice);
  const recorded = [];
  for (const [n, { line: l }] of plan.need.entries()) {
    const k = takeKey(l, { voiceId: id, model, ...settings });
    log(`ElevenLabs: ${l.id}`, { line: l.id, n: n + 1, of: plan.need.length, voice, model });
    const vs = { stability: l.stability ?? stability, similarity_boost: similarity, use_speaker_boost: speakerBoost };
    if ((l.style ?? style) != null) vs.style = l.style ?? style;
    if ((l.speed ?? speed) != null) vs.speed = l.speed ?? speed;
    // one request per line, never sent again on its own: with no answer (timeout, network) it may have been charged
    let r, j;
    try {
      r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}/with-timestamps?output_format=${FORMAT}`, {
        method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: l.text, model_id: model, voice_settings: vs }), signal: timeoutSignal(TIMEOUT_MS.speech),
      });
      if (r.ok) j = await r.json();
    } catch (e) { throw Object.assign(new Error(`${lostWhy(e, 'ElevenLabs')} (line ${l.id})`), { code: 'no_answer' }); }
    if (!r.ok) throw Object.assign(new Error(`${elevenWhy(r.status, await r.text().catch(() => ''))} (line ${l.id})`), { status: r.status });
    const meta = JSON.stringify({ id: l.id, text: l.text, voice, voice_id: id, model, format: FORMAT, key: k, alignment: j.alignment }, null, 1);
    const pcm = Buffer.from(j.audio_base64, 'base64');
    // the archived take first, its .json last (planLines needs both): a crash between writes leaves a take planLines
    // restores for free, never a half take that is paid for again
    writeFileSync(join(dir, 'takes', `${l.id}-${k.slice(0, 8)}.pcm`), pcm); writeFileSync(join(dir, 'takes', `${l.id}-${k.slice(0, 8)}.json`), meta);
    writeFileSync(join(dir, 'lines', `${l.id}.pcm`), pcm); writeFileSync(join(dir, 'lines', `${l.id}.json`), meta);
    logVoiceUse(work, { engine: 'elevenlabs', voice, model, line: l.id, characters: l.text.length, credits: Number(r.headers?.get?.('character-cost')) || undefined });
    recorded.push(l.id);
  }
  return { id, recorded, restored };
}

// A take made outside this cache (New take / Remake line write voice/clips/<id>.wav + .json) becomes the line's cached
// take, so the voice is joined from the take the owner has, never from an older recording (and never paid for again).
// The cache records the words the clip SAYS: its report's words when it has one, else the words the cache had, else
// none (null). Never the line's current words: a New take that deleted the cache made makeVoice adopt the line's OLD
// clip as a take of the NEW words, the "words changed" flag vanished and nothing was recorded (2026-11-02, 5 lines).
function adoptClip(work, dir, l, { voice, model }) {
  const wav = join(work, 'voice', 'clips', `${l.id}.wav`);
  const meta = join(dir, 'lines', `${l.id}.json`);
  if (!existsSync(wav)) return false;
  if (existsSync(meta) && statSync(wav).mtimeMs <= statSync(meta).mtimeMs + 1000) return false;
  const b = readFileSync(wav);
  const fmt = b.readUInt16LE(20); const bits = b.readUInt16LE(34);
  const pcm16 = fmt === 1 && bits === 16; const float32 = fmt === 3 && bits === 32;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.readUInt32LE(24) !== RATE || b.readUInt16LE(22) !== 1 || !(pcm16 || float32)) return false;
  let o = 12;
  while (o + 8 <= b.length && b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  if (o + 8 > b.length) return false;
  const raw = b.subarray(o + 8, Math.min(b.length, o + 8 + b.readUInt32LE(o + 4)));
  let data = raw;
  if (float32) {
    data = Buffer.alloc((raw.length >> 2) * 2);
    for (let i = 0; i < raw.length >> 2; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, raw.readFloatLE(i * 4))) * 32767), i * 2);
  }
  let words = []; let report = null;
  try { report = JSON.parse(readFileSync(join(work, 'voice', 'clips', `${l.id}.json`), 'utf8')); words = report.words || []; } catch { /* no word timings */ }
  let said = null;
  if (report && typeof report.text === 'string') said = report.text;
  else if (report && typeof report.script === 'string') said = report.script === (l.script ?? l.text) ? l.text : report.script;
  else { try { said = JSON.parse(readFileSync(meta, 'utf8')).text ?? null; } catch { /* no cache: words unknown */ } }
  writeFileSync(join(dir, 'lines', `${l.id}.pcm`), data);
  writeFileSync(meta, JSON.stringify({ id: l.id, text: said, voice, model, format: FORMAT, from: 'voice/clips', words }, null, 1));
  return true;
}

// The joined voice from every line's take. Lines with no take yet are recorded (every scene is OK'd before the Script
// gate opens); a line that has a take keeps it even when its words changed since: it's remade only by the owner's
// Remake line / New take (owner, 2026-10-23: "the lines shouldn't ever be made until someone okays the line").
// `retakeChanged: true` also records lines whose take key changed (an explicit remake); `confirm: false` only estimates.
// `retake` (ids): New take of these lines: each recorded fresh (one ElevenLabs call per line), its clip never adopted;
// the cached take is replaced only when the new one arrives. `recorded` in the result lists the lines really recorded.
export async function makeVoice({ work, key, voice = 'Tracy K', voiceId = null, model = 'eleven_v4', stability = 0.5, similarity = 0.75, style = null, speed = null, speakerBoost = true, retakeChanged = false, retake = [], confirm = true, maxCredits = null, rate = 1, log = () => {} }) {
  const dir = join(work, 'sound', 'voice');
  mkdirSync(join(dir, 'lines'), { recursive: true });
  const lines = JSON.parse(readFileSync(join(work, 'voice', 'lines.json'), 'utf8'));
  const fresh = new Set(retake);
  for (const l of lines) if (!fresh.has(l.id)) adoptClip(work, dir, l, { voice, model });
  const missing = lines.filter((l) => !existsSync(join(dir, 'lines', `${l.id}.pcm`)) || !existsSync(join(dir, 'lines', `${l.id}.json`)));
  // A New take records ONLY its own lines: another line with no take yet is not paid for here (Dir3: b08-2, queued as
  // its own re-read, was recorded first inside b03-1's take and then again for its own: 8 calls for 7 lines).
  const todo = retakeChanged ? lines : fresh.size ? lines.filter((l) => fresh.has(l.id)) : missing;
  const rec = await recordLines({ work, key, voice, model, stability, similarity, style, speed, speakerBoost, confirm, maxCredits, rate, log, lines: todo, voiceId, force: [...fresh] });
  if (rec.needs_confirm) return { needs_confirm: true, lines: rec.lines, characters: rec.characters, credits_estimate: rec.credits_estimate };
  // ... and the voice is joined only once every line has its take (the rule): until then the take is kept, nothing joined
  const has = (l) => existsSync(join(dir, 'lines', `${l.id}.pcm`)) && existsSync(join(dir, 'lines', `${l.id}.json`));
  const still = lines.filter((l) => !has(l)).map((l) => l.id);
  const clips = [];
  for (const l of lines.filter(has)) {
    const pcm = join(dir, 'lines', `${l.id}.pcm`); const meta = join(dir, 'lines', `${l.id}.json`);
    const buf = readFileSync(pcm);
    const x = new Float32Array(buf.length / 2);
    for (let i = 0; i < x.length; i++) x[i] = buf.readInt16LE(i * 2) / 32768;
    const m = JSON.parse(readFileSync(meta, 'utf8'));
    const words = m.words || wordsFrom(m.alignment);
    // cut only silence: from LEAD before the first sound to TAIL after the last
    let a = 0; while (a < x.length && Math.abs(x[a]) < SILENT) a++;
    let z = x.length - 1; while (z > a && Math.abs(x[z]) < SILENT) z--;
    const from = Math.max(0, a - Math.round(LEAD * RATE)); const to = Math.min(x.length, z + 1 + Math.round(TAIL * RATE));
    clips.push({ line: l, samples: x.subarray(from, to), words: words.map((w) => ({ text: w.text, start: w.start - from / RATE, end: w.end - from / RATE })) });
  }
  // each line on its own too, the same samples: the Voice lane plays and checks lines one by one (voice/clips/<id>.wav,
  // where the canvas looks; without them every line showed "making" though the voice was done, owner 2026-10-19)
  mkdirSync(join(work, 'voice', 'clips'), { recursive: true });
  const now = new Date();
  for (const c of clips) {
    writeWav(join(work, 'voice', 'clips', `${c.line.id}.wav`), [c.samples], RATE);
    // the cache stays the newer one: these clips are its own samples, not a take to adopt next time
    utimesSync(join(dir, 'lines', `${c.line.id}.json`), now, new Date(now.getTime() + 2000));
  }
  if (still.length) return { joined: false, waiting: still, recorded: rec.recorded || [], restored: rec.restored || [] };
  // join with the script's gaps
  const total = clips.reduce((s, c) => s + c.samples.length + Math.round((c.line.gap_after ?? 0.3) * RATE), 0);
  const out = new Float32Array(total);
  const timing = { seconds: 0, made_by: 'soundtrack v1: ElevenLabs pcm_48000, unprocessed', lines: [] };
  let at = 0;
  for (const c of clips) {
    out.set(c.samples, at);
    const t0 = at / RATE;
    timing.lines.push({ id: c.line.id, text: c.line.script || c.line.text, start: +(t0).toFixed(3), end: +(t0 + c.samples.length / RATE).toFixed(3),
      timing: 'words', words: c.words.map((w) => ({ text: w.text, start: +(t0 + w.start).toFixed(3), end: +(t0 + w.end).toFixed(3) })) });
    at += c.samples.length + Math.round((c.line.gap_after ?? 0.3) * RATE);
  }
  timing.seconds = +(total / RATE).toFixed(3);
  writeWav(join(dir, 'voice.wav'), [out], RATE);
  writeFileSync(join(dir, 'timing.json'), JSON.stringify(timing, null, 1));
  return { file: join(dir, 'voice.wav'), timing, voice, model, format: FORMAT, recorded: rec.recorded || [], restored: rec.restored || [] };
}

// One plain gain for listening to the voice alone (the animatic): toward -14 LUFS, stopping where the voice's own peaks
// reach the ceiling. Never a limiter: the gain is the same for every sample.
export function plainGain(i, tp, target = -14, ceiling = -1) {
  return Math.min(target - i, ceiling - tp);
}
