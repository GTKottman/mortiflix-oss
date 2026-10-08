// The last stage of the music: a finished master. Either Strudel's render, brought to the delivery loudness here, or a
// master the owner made from the MIDI pack in their own DAW and imported (`mortiflix music <project> --import <file>`).
// Both are measured the same way (ffmpeg's EBU R128 meter), and an owner's master is checked against the score it was
// made from: its length, and whether it starts where bar 1 starts.
import { spawnSync } from 'node:child_process';
import { readWav, firstSound } from './wav.mjs';

export const TARGET = { lufs: -14, tp: -1, lra: 11 };

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`ffmpeg isn't available: ${r.error.message}`);
  return r;
}

// Integrated loudness (LUFS), true peak (dBTP), loudness range (LU), length (s).
export function loudness(file) {
  const r = ffmpeg(['-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const s = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const num = (re) => { const m = s.match(re); return m ? Number(m[1]) : null; };
  const d = r.stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), true_peak: num(/Peak:\s+(-?[\d.]+) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/),
    seconds: d ? +(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])).toFixed(3) : null };
}

// Two-pass loudnorm to the target, 48 kHz 24-bit WAV, plus a 320 kbps MP3 beside it.
export function masterTo(input, outWav, { lufs = TARGET.lufs, tp = TARGET.tp, lra = TARGET.lra } = {}) {
  const want = `I=${lufs}:TP=${tp}:LRA=${lra}`;
  const p1 = ffmpeg(['-i', input, '-af', `loudnorm=${want}:print_format=json`, '-f', 'null', '-']);
  const j = p1.stderr.slice(p1.stderr.lastIndexOf('{'), p1.stderr.lastIndexOf('}') + 1);
  let m; try { m = JSON.parse(j); } catch { throw new Error('ffmpeg loudnorm gave no measurement (is the render silent?)'); }
  const second = `loudnorm=${want}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const p2 = ffmpeg(['-i', input, '-af', second, '-ar', '48000', '-c:a', 'pcm_s24le', outWav]);
  if (p2.status !== 0) throw new Error(`ffmpeg couldn't master: ${p2.stderr.split('\n').slice(-3).join(' ')}`);
  const mp3 = outWav.replace(/\.wav$/, '.mp3');
  ffmpeg(['-i', outWav, '-c:a', 'libmp3lame', '-b:a', '320k', mp3]);
  return { wav: outWav, mp3, before: { lufs: Number(m.input_i), true_peak: Number(m.input_tp) }, after: loudness(outWav) };
}

// Any audio file the owner brings → a 48 kHz stereo WAV the studio works with.
export function toStudioWav(input, outWav) {
  const r = ffmpeg(['-i', input, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', outWav]);
  if (r.status !== 0) throw new Error(`that file couldn't be read as audio: ${r.stderr.split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg failed'}`);
  return outWav;
}

// The owner's master against the score it was made from.
//   expect: { seconds: the cue's length (bars at the tempo), first_note_sec: when the first note of the MIDI starts }
// Returns { errors, warnings, measured }: errors mean it can't be used as is (wrong file, much too short); warnings are
// shown to the owner and the session (it may start late, it's quieter than the delivery level, …).
export function checkOwnMaster(wavFile, expect) {
  const errors = []; const warnings = [];
  const lu = loudness(wavFile);
  const wav = readWav(wavFile);
  const starts = firstSound(wav, -45);
  const measured = { ...lu, first_sound_sec: starts };
  if (starts === null) errors.push('the file is silent');
  if (expect?.seconds && lu.seconds !== null) {
    if (lu.seconds < expect.seconds - 0.5) errors.push(`it's ${lu.seconds.toFixed(2)} s long but the score runs ${expect.seconds.toFixed(2)} s: export the whole song, from bar 1 to the last bar (a tail after it is fine)`);
    if (lu.seconds > expect.seconds + 30) warnings.push(`it runs ${(lu.seconds - expect.seconds).toFixed(1)} s past the end of the score: the studio will fade it after the last bar`);
  }
  if (starts !== null && expect?.first_note_sec !== undefined && expect.first_note_sec !== null) {
    const off = +(starts - expect.first_note_sec).toFixed(3);
    measured.offset_sec = off;
    if (Math.abs(off) > 0.08) warnings.push(`the first sound arrives at ${starts.toFixed(2)} s, but the first note of the MIDI is at ${expect.first_note_sec.toFixed(2)} s (${off > 0 ? '+' : ''}${off} s). If you exported from bar 1, a slow attack can explain it; if not, export again starting exactly at bar 1 so the hits land on the picture`);
  }
  if (lu.true_peak !== null && lu.true_peak > -0.1) warnings.push(`the true peak is ${lu.true_peak} dBTP: it may clip; the studio's final mix brings it down`);
  return { errors, warnings, measured };
}
