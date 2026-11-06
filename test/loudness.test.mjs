// The reference loudness meter (doc 15 A2) against EBU Tech 3341 V4 Table 1 (cases 1–6, 9–23; 7–8 need EBU's
// programme files), EBU Tech 3342 (loudness range cases 1–4), and ffmpeg's ebur128 on 10 generated programmes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { measure, kCoefficients } from '../src/audio/loudness.mjs';
import { sine, silence, concat, writeWav, fromDb, RATE } from './quality/kit.mjs';

const within = (got, want, lo, hi, what) => assert.ok(got >= want - lo && got <= want + hi, `${what}: ${got.toFixed(3)} not in ${want} −${lo}/+${hi}`);
const tone = (db, seconds, rate = RATE) => sine({ freq: 1000, db, seconds, rate });
const tones = (...pairs) => concat(...pairs.map(([s, db]) => (db === null ? silence({ seconds: s }) : tone(db, s))));

// Fades a signal in and out over `ms` (Tech 3341 15–19 ask for 10 ms).
function taper(sig, ms = 10) {
  const n = Math.round(ms / 1000 * sig.rate);
  for (const c of sig.channels) for (let i = 0; i < n; i++) { const g = i / n; c[i] *= g; c[c.length - 1 - i] *= g; }
  return sig;
}

test('K-weighting at 48 kHz is the table in BS.1770-5', () => {
  const { shelf, hp } = kCoefficients(48000);
  const eq = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${v} vs ${b[i]}`));
  eq(shelf.b, [1.53512485958697, -2.69169618940638, 1.19839281085285]);
  eq(shelf.a, [-1.69065929318241, 0.73248077421585]);
  eq(hp.b, [1, -2, 1]);
  eq(hp.a, [-1.99004745483398, 0.99007225036621]);
});

test('Tech 3341 cases 1–5: integrated, momentary, short-term', () => {
  for (const [db, want] of [[-23, -23], [-33, -33]]) {
    const m = measure(tone(db, 20), { truePeak: false });
    within(m.integrated, want, 0.1, 0.1, `case ${db === -23 ? 1 : 2} I`);
    within(m.momentary.at(-1).lufs, want, 0.1, 0.1, 'M');
    within(m.shortTerm.at(-1).lufs, want, 0.1, 0.1, 'S');
  }
  within(measure(tones([10, -36], [60, -23], [10, -36]), { truePeak: false }).integrated, -23, 0.1, 0.1, 'case 3');
  within(measure(tones([10, -72], [10, -36], [60, -23], [10, -36], [10, -72]), { truePeak: false }).integrated, -23, 0.1, 0.1, 'case 4');
  within(measure(tones([20, -26], [20.1, -20], [20, -26]), { truePeak: false }).integrated, -23, 0.1, 0.1, 'case 5');
});

test('Tech 3341 case 6: 5.0 with surrounds weighted 1.41', () => {
  const ch = (db) => sine({ freq: 1000, db, seconds: 20, channels: 1 }).channels[0];
  const sig = { rate: RATE, channels: [ch(-28), ch(-28), ch(-24), ch(-30), ch(-30)] };
  within(measure(sig, { truePeak: false }).integrated, -23, 0.1, 0.1, 'case 6');
});

test('Tech 3341 cases 9–14: short-term and momentary', () => {
  // 9: (1.34 s at −20, 1.66 s at −30) × 5 → S = −23 constant after 3 s
  const nine = measure(tones(...Array.from({ length: 5 }, () => [[1.34, -20], [1.66, -30]]).flat()), { truePeak: false });
  for (const s of nine.shortTerm.filter((x) => x.t >= 3)) within(s.lufs, -23, 0.1, 0.1, `case 9 S at ${s.t.toFixed(1)} s`);
  // 10 (file-based): each file has max S = −23
  for (let i = 0; i < 20; i++) within(measure(tones([i * 0.15, null], [3, -23], [1, null]), { truePeak: false }).maxShortTerm, -23, 0.1, 0.1, `case 10 file ${i}`);
  // 11 (live): one file, max S per segment = −38 … −19
  const eleven = [];
  for (let i = 0; i < 20; i++) eleven.push([i * 0.15, null], [3, -38 + i], [3 - i * 0.15, null]);
  const m11 = measure(tones(...eleven), { truePeak: false, step: 0.01 });
  for (let i = 0; i < 20; i++) {
    const seg = m11.shortTerm.filter((x) => x.t > i * 6 && x.t <= (i + 1) * 6 + 0.001);
    within(Math.max(...seg.map((x) => x.lufs)), -38 + i, 0.1, 0.1, `case 11 segment ${i}`);
  }
  // 12: (0.18 s at −20, 0.22 s at −30) × 25 → M = −23 constant after 1 s
  const twelve = measure(tones(...Array.from({ length: 25 }, () => [[0.18, -20], [0.22, -30]]).flat()), { truePeak: false, step: 0.02 });
  for (const s of twelve.momentary.filter((x) => x.t >= 1)) within(s.lufs, -23, 0.1, 0.1, `case 12 M at ${s.t.toFixed(2)} s`);
  // 13 (file-based): max M = −23 per file
  for (let i = 0; i < 20; i++) within(measure(tones([i * 0.02, null], [0.4, -23], [1, null]), { truePeak: false }).maxMomentary, -23, 0.1, 0.1, `case 13 file ${i}`);
  // 14 (live): max M per segment = −38 … −19
  const fourteen = [];
  for (let i = 0; i < 20; i++) fourteen.push([i * 0.02, null], [0.4, -38 + i], [0.4 - i * 0.02, null]);
  const m14 = measure(tones(...fourteen), { truePeak: false, step: 0.001 });
  for (let i = 0; i < 20; i++) {
    const seg = m14.momentary.filter((x) => x.t > i * 0.8 && x.t <= (i + 1) * 0.8 + 0.0005);
    within(Math.max(...seg.map((x) => x.lufs)), -38 + i, 0.1, 0.1, `case 14 segment ${i}`);
  }
});

test('Tech 3341 cases 15–19: true peak of sines between samples', () => {
  const tp = (freq, amp, deg) => measure(taper(sine({ freq, db: 20 * Math.log10(amp), seconds: 1, phase: deg * Math.PI / 180 })), { truePeak: true }).truePeak;
  within(tp(RATE / 4, 0.5, 0), -6.02, 0.4, 0.2, 'case 15');
  within(tp(RATE / 4, 0.5, 45), -6.02, 0.4, 0.2, 'case 16');
  within(tp(RATE / 6, 0.5, 60), -6.02, 0.4, 0.2, 'case 17');
  within(tp(RATE / 8, 0.5, 67.5), -6.02, 0.4, 0.2, 'case 18');
  within(tp(RATE / 4, 1.41, 45), 2.98, 0.4, 0.2, 'case 19');
});

test('Tech 3341 cases 20–23: one period at fs/4 inside fs/6, made at 4·fs and downsampled at offsets 0–3', () => {
  const up = 4 * RATE;
  const n = up;                         // 1 s at 192 kHz
  const x = new Float64Array(n);
  const start = up / 2;                 // a zero crossing of the fs/6 tone (period 24 samples at 4·fs)
  const len = 16;                       // one period of fs/4 at 4·fs
  for (let i = 0; i < n; i++) {
    if (i >= start && i < start + len) x[i] = Math.sin(2 * Math.PI * (i - start) / len);
    else { const k = i < start ? i : i - len; x[i] = 0.5 * Math.sin(2 * Math.PI * k / 24); }
  }
  for (let i = 0; i < 960; i++) { const g = i / 960; x[i] *= g; x[n - 1 - i] *= g; }
  // anti-alias low-pass at 20 kHz (Kaiser windowed sinc, 511 taps) before taking every 4th sample
  const taps = 511; const mid = (taps - 1) / 2; const fc = 20000 / up; const h = new Float64Array(taps);
  const I0 = (v) => { let s = 1; let t = 1; for (let k = 1; k < 60; k++) { t *= (v / (2 * k)) ** 2; s += t; } return s; };
  for (let k = 0; k < taps; k++) { const t = k - mid; const r = t / mid; h[k] = (t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)) * I0(10 * Math.sqrt(1 - r * r)) / I0(10); }
  for (let off = 0; off < 4; off++) {
    const out = new Float32Array(RATE);
    for (let m = 0; m < RATE; m++) {
      const c = m * 4 + off; let s = 0;
      for (let k = 0; k < taps; k++) { const j = c - mid + k; if (j >= 0 && j < n) s += h[k] * x[j]; }
      out[m] = s;
    }
    const tp = measure({ rate: RATE, channels: [out, out] }).truePeak;
    within(tp, 0, 0.4, 0.2, `case ${20 + off}`);
  }
});

test('Tech 3342 cases 1–4: loudness range', () => {
  const lra = (...dbs) => measure(tones(...dbs.map((d) => [20, d])), { truePeak: false }).range;
  within(lra(-20, -30), 10, 1, 1, 'case 1');
  within(lra(-20, -15), 5, 1, 1, 'case 2');
  within(lra(-40, -20), 20, 1, 1, 'case 3');
  within(lra(-50, -35, -20, -35, -50), 15, 1, 1, 'case 4');
});

// ---------- against ffmpeg ----------

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }

function ffmpegSummary(file) {
  return spawnSync('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.split('Summary:').pop();
}

// Ten programmes that move like music: a minute long, the level wandering a few dB every 2 s (with the odd drop to
// quiet), tones and rolled-off noise, mono, stereo and 5.1. Short jumpy signals make loudness range depend on how
// each meter rounds its percentiles, which real programmes don't.
function programme(seed) {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const seconds = 60;
  const chs = [1, 2, 2, 2, 6][Math.floor(r() * 5)];
  const out = Array.from({ length: chs }, () => new Float32Array(seconds * RATE));
  const freqs = [55, 110, 220, 330, 440, 660, 880, 1760, 3520, 7040].map((f) => f * (0.9 + r() * 0.2));
  const seg = 2 * RATE;
  let levelDb = -20 + r() * 10;
  const prev = new Float64Array(chs);
  for (let a = 0; a < out[0].length; a += seg) {
    levelDb = Math.max(-34, Math.min(-6, levelDb + (r() * 2 - 1) * 4));
    const level = fromDb(r() < 0.08 ? levelDb - 20 : levelDb);
    const f = freqs[Math.floor(r() * freqs.length)];
    const noise = r() < 0.3;
    for (let i = 0; i < seg; i++) {
      const env = Math.min(1, i / 2400, (seg - i) / 2400);
      for (let c = 0; c < chs; c++) {
        // noise as in real recordings: rolled off towards the top (two-sample average), not flat to 24 kHz
        let w = 0; if (noise) { const z = r() * 2 - 1; w = (z + prev[c]) / 2; prev[c] = z; }
        const v = noise ? w * level : level * (Math.sin(2 * Math.PI * f * (a + i) / RATE + c) + 0.3 * Math.sin(2 * Math.PI * f * 2.01 * (a + i) / RATE));
        out[c][a + i] = v * env;
      }
    }
  }
  return { rate: RATE, channels: out };
}

test('agrees with ffmpeg ebur128 on 10 programmes', { skip: ffmpeg ? false : 'ffmpeg is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-lufs-'));
  try {
    for (let k = 0; k < 10; k++) {
      const sig = programme(100 + k);
      const file = join(dir, `p${k}.wav`);
      writeWav(file, sig);
      const text = ffmpegSummary(file);
      const I = Number(text.match(/I:\s+(-?[\d.]+) LUFS/)[1]);
      const LRA = Number(text.match(/LRA:\s+(-?[\d.]+) LU/)[1]);
      const TP = Number(text.match(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/)[1]);
      const m = measure(sig);
      within(m.integrated, I, 0.1, 0.1, `p${k} (${sig.channels.length} ch) integrated vs ffmpeg ${I}`);
      within(m.range, LRA, 0.3, 0.3, `p${k} LRA vs ffmpeg ${LRA}`);
      within(m.truePeak, TP, 0.15, 0.15, `p${k} true peak vs ffmpeg ${TP}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
