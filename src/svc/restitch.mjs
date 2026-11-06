// A free timing edit (a line's pause in Voice & music, owner 2026-11-02: 15 pauses tightened, the Length still read
// 1:11.2) joins the voice again from the takes it already has: never ElevenLabs. The join is the voice step's own
// (soundtrack/voice.mjs makeVoice with confirm:false: it records nothing, a line without a take stops it), so the
// words keep their place inside each line and only the gaps between lines move. It rewrites voice/voice.wav,
// voice/timing.json, out/voice/narration.wav and the scene cuts beside it, moves the music plan's cue edges with
// their scenes, and says so (node.changed, music.changed) so the timeline, the line times and the Length follow.
//
//   restitchVoice({root, id})            -> {ok, seconds, before, music}  | {ok:false, why}
//   restitchSoon(root, id, {emit})       debounced (rapid edits make one join), one join at a time per project
//   voiceStale(work)                     voice/lines.json is newer than voice/voice.wav (an edit the voice missed), or
//                                        the voice's speed is not the one picked
//   voiceSpeed / setVoiceSpeed / voiceLength   the free Speed control (voice/speed.json) and the Length against the
//                                        length chosen on New project ("20 s over the 1:00 asked")
//
// Speed (coordinator, 2026-11-02: all three real voices ran 5-20 s long): the whole joined voice time-stretched with
// ffmpeg atempo (pitch kept), 0.9x to 1.15x in 0.05 steps; the word and line times are scaled by the length the
// stretch really made. 1x (the default) leaves the voice exactly as ElevenLabs made it.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projectPaths, event } from '../projects.mjs';
import { voiceConfig } from '../voice/index.mjs';
import { makeVoice } from '../soundtrack/voice.mjs';
import { voiceQueueIdle } from '../voiceonok.mjs';

export const RESTITCH_WAIT_MS = 600;
const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const r3 = (x) => Math.round(x * 1000) / 1000;
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

export const SPEEDS = [0.9, 0.95, 1, 1.05, 1.1, 1.15];
export function voiceSpeed(work) {
  const s = Number(readOr(join(work, 'voice', 'speed.json'), {})?.speed);
  return SPEEDS.includes(s) ? s : 1;
}
export function setVoiceSpeed(work, speed) {
  const n = Number(speed);
  const s = SPEEDS.find((x) => Math.abs(x - n) < 0.001);
  if (s === undefined) throw new Error(`speed is one of ${SPEEDS.join(', ')}`);
  mkdirSync(join(work, 'voice'), { recursive: true });
  writeFileSync(join(work, 'voice', 'speed.json'), JSON.stringify({ speed: s }, null, 2));
  return s;
}

export function voiceStale(work) {
  const wav = join(work, 'voice', 'voice.wav');
  if (!existsSync(wav)) return false;
  if (mtime(join(work, 'voice', 'lines.json')) > mtime(wav) + 1) return true;
  return (Number(readOr(join(work, 'voice', 'timing.json'), {})?.speed) || 1) !== voiceSpeed(work);
}

// The Length against the length chosen on New project: over_sec > 0 is "20 s over the 1:00 asked".
export function voiceLength(work, chosen) {
  const seconds = Number(readOr(join(work, 'voice', 'timing.json'), {})?.seconds) || null;
  const over = seconds && chosen ? r3(seconds - chosen) : null;
  return { seconds, chosen_sec: chosen ?? null, over_sec: over, speed: voiceSpeed(work), speeds: SPEEDS };
}

const wavSec = (f) => {
  const b = readFileSync(f); let o = 12;
  while (o + 8 <= b.length && b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  return Math.min(b.readUInt32LE(o + 4), b.length - o - 8) / (b.readUInt16LE(22) * (b.readUInt16LE(34) / 8)) / b.readUInt32LE(24);
};

// The joined voice at `speed` (atempo keeps the pitch), its timing scaled by the length the stretch made.
export function stretch(src, dst, timing, speed) {
  const tmp = `${dst}.tmp.wav`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', src, '-af', `atempo=${speed}`, '-c:a', 'pcm_f32le', tmp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg atempo: ${(r.stderr || '').slice(-200)}`);
  const seconds = wavSec(tmp);
  const k = seconds / timing.seconds;
  const at = (x) => r3(x * k);
  renameSync(tmp, dst);
  return { ...timing, seconds: r3(seconds), speed, made_by: `${timing.made_by}; whole voice at ${speed}x (ffmpeg atempo, pitch kept)`,
    lines: timing.lines.map((l) => ({ ...l, start: at(l.start), end: at(l.end), words: (l.words || []).map((w) => ({ ...w, start: at(w.start), end: at(w.end) })) })) };
}

// Scene spans on a voice timing: [{id, from, to}] (line ids b01-1 -> beat b01), the way elmusic.sceneSpans reads them.
function spansOf(timing) {
  const spans = [];
  for (const l of timing?.lines || []) {
    const beat = String(l.id).match(/^(b\d{2,3})/)?.[1];
    if (!beat || !Number.isFinite(l.start) || !Number.isFinite(l.end)) continue;
    const last = spans.at(-1);
    if (last && last.id === beat) { last.from = Math.min(last.from, l.start); last.to = Math.max(last.to, l.end); } else spans.push({ id: beat, from: l.start, to: l.end });
  }
  return spans;
}

// The music plan's cues (music/cues.json) moved with their scenes: each edge keeps its place in the scene it sits in,
// the last cue ends where the voice now ends. A made cue whose length changed is 'stale' (elmusic's own rule).
export function moveCues(plan, before, after) {
  const old = spansOf(before); const now = Object.fromEntries(spansOf(after).map((s) => [s.id, s]));
  const total = Number(after.seconds) || 0;
  const place = (t) => {
    if (!(t > 0)) return 0;
    const s = old.filter((x) => x.from <= t + 0.001).at(-1);
    return s && now[s.id] ? r3(Math.max(0, now[s.id].from + (t - s.from))) : t;
  };
  let changed = false;
  const cues = plan.cues.map((c) => ({ ...c }));
  cues.forEach((c, i) => {
    const from = i === 0 ? c.from_sec : place(c.from_sec);
    const to = i === cues.length - 1 ? r3(total) : place(cues[i + 1].from_sec);
    if (from !== c.from_sec || to !== c.to_sec) {
      changed = true;
      c.from_sec = from; c.to_sec = to;
      if (c.file) c.state = 'stale';
    }
  });
  return { plan: { ...plan, cues, total_sec: r3(total) }, changed: changed || plan.total_sec !== r3(total) };
}

// The scene cuts the voice step made (out/voice/<beat>.wav), cut again from out/voice/narration.wav at the scene
// times in `timing`: the same samples. Only cuts that exist are remade.
export function recutScenes(work, timing) {
  const out = join(work, 'out', 'voice');
  for (const s of spansOf(timing)) {
    const f = join(out, `${s.id}.wav`);
    if (!existsSync(f)) continue;
    const from = Math.max(0, s.from - 0.05); const to = s.to + 0.15;
    spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(from), '-t', String(r3(to - from)), '-i', join(out, 'narration.wav'), '-c:a', 'pcm_f32le', f], { encoding: 'utf8' });
  }
}

export async function restitchVoice({ root, id }) {
  const work = projectPaths(root, id).work;
  const lines = readOr(join(work, 'voice', 'lines.json'), null);
  if (!Array.isArray(lines) || !lines.length) return { ok: false, why: 'no voice lines' };
  const takes = join(work, 'sound', 'voice', 'lines');
  const missing = lines.filter((l) => !existsSync(join(takes, `${l.id}.pcm`)) || !existsSync(join(takes, `${l.id}.json`))).map((l) => l.id);
  if (missing.length) return { ok: false, why: `no take yet for ${missing.join(', ')}` };
  await voiceQueueIdle(id); // a scene's voice still recording on its OK finishes first
  const before = readOr(join(work, 'voice', 'timing.json'), { seconds: null, lines: [] });
  const el = (() => { try { return voiceConfig(root).elevenlabs || {}; } catch { return {}; } })();
  // key null + confirm false: makeVoice never reaches ElevenLabs (a missing take returns needs_confirm instead)
  const v = await makeVoice({ work, key: null, confirm: false, voice: el.voice_name || 'the studio voice', model: el.model_id || 'eleven_v4' });
  if (v.needs_confirm) return { ok: false, why: `no take yet for ${(v.lines || []).join(', ')}` };
  const speed = voiceSpeed(work);
  if (speed !== 1) {
    // the soundtrack reads sound/voice/: it gets the stretched voice too
    v.timing = stretch(v.file, v.file, v.timing, speed);
    writeFileSync(join(work, 'sound', 'voice', 'timing.json'), JSON.stringify(v.timing, null, 1));
  } else v.timing = { ...v.timing, speed: 1 };
  writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify(v.timing, null, 2));
  copyFileSync(v.file, join(work, 'voice', 'voice.wav'));
  const out = join(work, 'out', 'voice');
  mkdirSync(out, { recursive: true });
  copyFileSync(v.file, join(out, 'narration.wav'));
  recutScenes(work, v.timing);
  let music = false;
  const cuesFile = join(work, 'music', 'cues.json');
  const plan = readOr(cuesFile, null);
  if (plan && Array.isArray(plan.cues) && plan.cues.length) {
    const m = moveCues(plan, before, v.timing);
    if (m.changed) { writeFileSync(cuesFile, JSON.stringify(m.plan, null, 2)); music = true; }
  }
  const seconds = v.timing.seconds;
  try { event(root, id, { event: 'VOICE_RESTITCHED', actor: 'studio', details: `the voice joined again from its takes after a timing edit: ${before.seconds ?? '?'} s -> ${seconds} s${speed !== 1 ? ` at ${speed}x` : ''} (no ElevenLabs call)` }); } catch { /* no state */ }
  return { ok: true, seconds, speed, before: before.seconds ?? null, music, lines: lines.map((l) => l.id) };
}

// Rapid edits (a pause stepped 15 times) make one join, RESTITCH_WAIT_MS after the last; a join already running
// finishes first and the next one starts after it.
// `reset: false` (the stale check on every read) never pushes back a join already waiting or running, and waits a
// minute after a join that could not be made.
const timers = new Map(); const running = new Map(); const failed = new Map();
// what was last said about a project's join that could not be made: a line with no take yet waits for its re-read, and
// the stale check asks again every minute (Dir3: "no take yet for b08-2" over and over); said once, until it changes
const told = new Map();
const tell = (id, why, log) => { if (told.get(id) !== why) { told.set(id, why); log(`voice restitch ${id}: ${why}`); } };
export function restitchSoon(root, id, { emit = () => {}, wait = RESTITCH_WAIT_MS, reset = true, log = (m) => console.error(m) } = {}) {
  if (!reset && (timers.has(id) || running.has(id) || Date.now() - (failed.get(id) || 0) < 60_000)) return Promise.resolve(null);
  clearTimeout(timers.get(id));
  return new Promise((resolve) => {
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      const prev = running.get(id) || Promise.resolve();
      const job = prev.then(() => restitchVoice({ root, id })).then((r) => {
        if (r.ok) {
          failed.delete(id); told.delete(id);
          emit('node.changed', { project: id, rev: null, nodes: r.lines.map((l) => ({ id: l, kind: 'line' })) });
          if (r.music) emit('music.changed', { project: id });
        } else { failed.set(id, Date.now()); tell(id, r.why, log); }
        return r;
      }, (e) => { failed.set(id, Date.now()); tell(id, e.message, log); return { ok: false, why: e.message }; });
      running.set(id, job);
      job.finally(() => { if (running.get(id) === job) running.delete(id); });
      resolve(job);
    }, wait));
  });
}
