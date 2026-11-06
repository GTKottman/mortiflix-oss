// The final film's sound, built by Finish from what was approved, never a stale file (2026-11-02, d4fd: final.mp4's
// audio was the bare voice+music mix, none of the 28 approved sounds, the music ducked the whole film, +0.6 dBTP):
//   1. voice + the Voice step's music (svc/elmusic.mjs ensureMusicMix: ducked per line), out/voice/mix.wav
//   2. + every Sound cue not cut that has its file, at its time (svc/sfx.mjs mixSounds), out/sound/final-mix.wav
//   3. mastered to -14 LUFS, true peak <= -1 dBTP (two-pass loudnorm, linear when it can), out/sound/final-master.wav
// and out/sound/final-audio.json says what is in it, measured. checkFinalAudio fails when planned music or sounds
// are missing from it.
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureMusicMix } from './elmusic.mjs';
import { mixSounds, soundPaths } from './sfx.mjs';
import { speechRegions } from './elmusic.mjs';
import { writeJson } from '../studio.mjs';

export const TARGET_LUFS = -14, MAX_TP = -1;
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function measureLoudness(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
  const m = String(r.stderr || '').match(/\{[^{}]*"input_i"[^{}]*\}/s);
  try { const j = JSON.parse(m[0]); return { i: Number(j.input_i), tp: Number(j.input_tp), lra: Number(j.input_lra), thresh: Number(j.input_thresh), offset: Number(j.target_offset) }; } catch { return null; }
}

export function masterTo(src, dst, { lufs = TARGET_LUFS, tp = MAX_TP } = {}) {
  const m = measureLoudness(src);
  if (!m) return { ok: false, error: 'could not measure the loudness' };
  // a little under the ceiling: the AAC encode adds up to about half a dB of true peak
  const ceiling = tp - 0.5;
  const f = `loudnorm=I=${lufs}:TP=${ceiling}:LRA=11:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', src, '-af', `${f},aresample=48000`, '-ar', '48000', '-c:a', 'pcm_s24le', dst], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
  if (r.status !== 0) return { ok: false, error: String(r.stderr).split('\n').filter(Boolean).slice(-2).join(' ') };
  return { ok: true, before: m, after: measureLoudness(dst) };
}

// Sound levels under the voice (2026-11-02, d4fd: the stamp thuds peaked about 6 dB over the voice, one inside the
// Letitia James quote). Each sound's loudest 400 ms sits SFX_UNDER dB under the voice's speech level, a sound over a
// spoken word a further IN_WORDS dB down, and no sound peaks closer than PEAK_ROOM dB to the voice's peak. A sound
// inside a quoted line moves to the nearest pause when one is within MOVE_MAX s, else leaves the plan, with a note.
export const SFX_UNDER = 9, IN_WORDS = 6, PEAK_ROOM = 3, MOVE_MAX = 1.5;

function ebur(file, dur = null) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', ...(dur ? ['-t', String(dur)] : []), '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 });
  const e = String(r.stderr || '');
  const ms = [...e.matchAll(/ M:\s*(-?[\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  const sum = e.slice(e.lastIndexOf('Summary:'));
  const i = Number(sum.match(/I:\s*(-?[\d.]+) LUFS/)?.[1]);
  const peak = Number(sum.match(/Peak:\s*(-?[\d.]+) dBFS/)?.[1]);
  return { i: Number.isFinite(i) ? i : null, m: ms.length ? Math.max(...ms) : null, peak: Number.isFinite(peak) ? peak : null };
}

// a quoted line: quotation marks, or "Name Title: words" (the voice reads a quote after its credit). The credit is a
// name: at least two words before the colon, nearly all capitalised ("New York Attorney General Letitia James:"); an
// explaining colon is not a quote (2026-11-02, 61dc: "The verdict: neither…", "It's dipoles: water…" dropped 7 sounds
// the owner had OK'd).
export function isQuote(text) {
  const t = String(text);
  if (/["“”]/.test(t)) return true;
  const m = /^([^.?!:]{3,80}):\s+\S/.exec(t);
  if (!m) return false;
  const ws = m[1].trim().split(/\s+/).filter((w) => !/^(of|the|and|for|de|von|van|la|le)$/i.test(w));
  return ws.length >= 2 && ws.filter((w) => /^\p{Lu}/u.test(w)).length / ws.length >= 0.8;
}

// where each sound goes and how loud, against the bed it is mixed on (voice + music); moves/drops are written to the plan
export function levelSounds(work, base) {
  const paths = soundPaths(work);
  const plan = readJson(paths.plan, null);
  const timing = readJson(join(work, 'voice', 'timing.json'), { lines: [] });
  const lines = (timing.lines || []).filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end));
  const words = speechRegions(timing, { gap: 0.15, pad: 0.03 });
  const voice = ebur(base);
  const notes = [];
  let changed = false;
  const fileOf = (c) => (c.file && existsSync(c.file) ? c.file : c.library_file && existsSync(c.library_file) ? c.library_file : null);
  for (const c of plan?.cues || []) {
    if (c.status === 'cut' || !fileOf(c)) continue;
    const q = lines.find((l) => isQuote(l.text) && c.at_sec >= l.start && c.at_sec < l.end);
    if (!q) continue;
    const i = lines.indexOf(q);
    const before = i > 0 ? { at: Math.max(lines[i - 1].end, q.start - c.dur_sec), d: c.at_sec - q.start } : { at: Math.max(0, q.start - c.dur_sec), d: c.at_sec - q.start };
    const after = { at: q.end + 0.02, d: q.end - c.at_sec };
    const best = before.d <= after.d ? before : after;
    if (best.d <= MOVE_MAX) {
      notes.push(`${c.id} moved from ${c.at_sec}s to ${+best.at.toFixed(3)}s, out of the quoted line ${q.id}`);
      Object.assign(c, { moved_from: c.at_sec, at_sec: +best.at.toFixed(3), note: `moved out of the quoted line ${q.id} (${q.text.slice(0, 40)}…)` });
    } else {
      notes.push(`${c.id} dropped: it fell ${c.at_sec}s inside the quoted line ${q.id} and no pause is within ${MOVE_MAX}s`);
      Object.assign(c, { status: 'cut', cut_by: 'finish', note: `dropped by Finish: inside the quoted line ${q.id} (${q.text.slice(0, 40)}…), no pause within ${MOVE_MAX} s` });
    }
    changed = true;
  }
  if (changed) writeJson(paths.plan, plan);
  const levels = {}; const report = [];
  for (const c of plan?.cues || []) {
    const f = fileOf(c);
    if (c.status === 'cut' || !f) continue;
    const m = ebur(f, c.dur_sec);
    const inWords = words.some(([a, b]) => c.at_sec < b && c.at_sec + Math.min(c.dur_sec, 0.3) > a);
    let g = (voice.i ?? -16) - SFX_UNDER - (m.m ?? m.i ?? -20) + (inWords ? -IN_WORDS : 0);
    if (m.peak !== null && voice.peak !== null) g = Math.min(g, voice.peak - PEAK_ROOM - m.peak);
    // up to +24 dB: a quiet ElevenLabs sound (61dc fx32, peak -27 dBFS) reaches its level; the voice-peak rule above still holds
    g = +Math.max(-40, Math.min(24, g)).toFixed(1);
    levels[c.id] = g;
    report.push({ id: c.id, at_sec: c.at_sec, gain_db: g, peak_db: m.peak === null ? null : +(m.peak + g).toFixed(1), in_words: inWords });
  }
  return { levels, report, notes, voice: { lufs: voice.i, peak_db: voice.peak } };
}

const planned = (work) => {
  const plan = readJson(soundPaths(work).plan, null);
  const sfx = (plan?.cues || []).filter((c) => c.status !== 'cut');
  const made = sfx.filter((c) => (c.file && existsSync(c.file)) || (c.library_file && existsSync(c.library_file)));
  const music = (readJson(join(work, 'music', 'cues.json'), { cues: [] }).cues || []).filter((c) => c.file && c.state !== 'stale' && existsSync(join(work, c.file)));
  return { sfx, made, music };
};

// the sounds Finish left out of the film, each with its reason (the Finish summary and the Sound screen list them)
export function leftOut(work) {
  const plan = readJson(soundPaths(work).plan, null);
  return (plan?.cues || []).filter((c) => c.cut_by === 'finish' && c.status === 'cut').map((c) => ({ id: c.id, at_sec: c.moved_from ?? c.at_sec, what: c.what, why: c.note || 'left out by Finish' }));
}

export function buildFinalAudio(work) {
  const mm = ensureMusicMix(work);
  if (mm && !mm.ok) return { ok: false, error: `the voice and music mix failed: ${mm.error}` };
  let mix; let lv = null;
  const bed = mm?.path || [join(work, 'out', 'voice', 'mix.wav'), join(work, 'out', 'voice', 'narration.wav')].find((f) => existsSync(f));
  try {
    if (bed && readJson(soundPaths(work).plan, null)) lv = levelSounds(work, bed);
    mix = mixSounds(work, { levels: lv?.levels });
  } catch (e) {
    if (e.code !== 'not_ready' || planned(work).sfx.length) return { ok: false, error: `the sound mix failed: ${e.message}` };
    mix = null; // no Sound plan at all: the voice (and music) as they are
  }
  const p = planned(work); // after levelSounds: a sound dropped from a quoted line is no longer planned
  const old = join(work, 'out', 'sound', 'final-mix.wav');
  const src = mix?.file || mm?.path || (existsSync(old) ? old : null);
  if (!src || !existsSync(src)) {
    if (p.sfx.length || p.music.length) return { ok: false, error: 'no voice mix to finish' };
    return { ok: true, file: null }; // nothing planned: the animatic keeps its own sound
  }
  const out = join(work, 'out', 'sound', 'final-master.wav');
  const m = masterTo(src, out);
  if (!m.ok) return { ok: false, error: `mastering failed: ${m.error}` };
  const manifest = { made: new Date().toISOString(), file: out, from: src, music: p.music.map((c) => c.id), sfx: p.made.map((c) => c.id), sfx_planned: p.sfx.length, voice: lv?.voice ?? null, sfx_levels: lv?.report ?? [], notes: lv?.notes ?? [], left_out: leftOut(work), lufs: +m.after.i.toFixed(1), true_peak: +m.after.tp.toFixed(1), target: { lufs: TARGET_LUFS, true_peak: MAX_TP } };
  writeJson(join(work, 'out', 'sound', 'final-audio.json'), manifest);
  return { ok: true, ...manifest };
}

// The final-pass check: what the plan says the film's sound has, against what went into it.
export function checkFinalAudio(work, { final = join(work, 'out', 'final', 'final.mp4') } = {}) {
  const p = planned(work);
  const man = readJson(join(work, 'out', 'sound', 'final-audio.json'), null);
  const problems = [];
  if (!man) problems.push('the final sound was not built from the approved voice, music and sounds');
  else {
    // a manifest edited by hand or from an older build may lack a list: read as empty, never a TypeError
    const inSfx = Array.isArray(man.sfx) ? man.sfx : []; const inMusic = Array.isArray(man.music) ? man.music : [];
    const missSfx = p.made.filter((c) => !inSfx.includes(c.id));
    const missMusic = p.music.filter((c) => !inMusic.includes(c.id));
    if (missSfx.length) problems.push(`${missSfx.length} approved sound${missSfx.length === 1 ? ' is' : 's are'} missing from the final mix`);
    if (missMusic.length) problems.push(`${missMusic.length} music cue${missMusic.length === 1 ? ' is' : 's are'} missing from the final mix`);
    if (p.sfx.length > p.made.length) problems.push(`${p.sfx.length - p.made.length} planned sound${p.sfx.length - p.made.length === 1 ? ' is' : 's are'} not made yet`);
    const loud = (man.sfx_levels || []).filter((x) => x.peak_db !== null && man.voice?.peak_db != null && x.peak_db > man.voice.peak_db);
    if (loud.length) problems.push(`${loud.length} sound${loud.length === 1 ? ' peaks' : 's peak'} above the voice (${loud.slice(0, 4).map((x) => `${x.id} ${x.peak_db} dB`).join(', ')}; voice ${man.voice.peak_db} dB)`);
    if (Math.abs(man.lufs - TARGET_LUFS) > 1) problems.push(`loudness ${man.lufs} LUFS, not ${TARGET_LUFS} ±1`);
    if (man.true_peak > MAX_TP) problems.push(`true peak ${man.true_peak} dBTP, over ${MAX_TP}`);
    if (existsSync(final) && statSync(final).mtimeMs < statSync(join(work, 'out', 'sound', 'final-audio.json')).mtimeMs - 1000) problems.push('final.mp4 is older than its sound: make the video again');
  }
  return { pass: !problems.length, problems, manifest: man };
}
