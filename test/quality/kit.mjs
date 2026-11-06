// The audio analysis kit (doc 15 A1): test signals made in code and the measurements every sound test uses. Plain
// Float32Array channels at a stated rate, so a WAV from any renderer (readWav) and a generated signal compare directly.
// No dependencies. Levels are dBFS; a full-scale sine peaks at 0 dBFS and has an RMS of −3.01 dBFS.
import { writeFileSync } from 'node:fs';
import { readWav } from '../../pipelines/_shared/skills/music/lib/wav.mjs';

export { readWav };
export const RATE = 48000;
export const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
export const fromDb = (d) => 10 ** (d / 20);

// ---------- signals: { rate, channels: [Float32Array, …] } ----------

const frames = (seconds, rate) => Math.round(seconds * rate);
const mono = (x, rate, n = 1) => ({ rate, channels: Array.from({ length: n }, (_, i) => (i ? Float32Array.from(x) : x)) });

// A sine at `db` dBFS peak. `phase` in radians; at rate/4 with phase π/4 every sample misses the peak by 3 dB.
export function sine({ freq = 1000, db = -20, seconds = 1, rate = RATE, phase = 0, channels = 2 } = {}) {
  const a = fromDb(db);
  const x = new Float32Array(frames(seconds, rate));
  for (let i = 0; i < x.length; i++) x[i] = a * Math.sin(2 * Math.PI * freq * i / rate + phase);
  return mono(x, rate, channels);
}

// A logarithmic sweep from f0 to f1 (Farina), `db` dBFS peak.
export function sweep({ f0 = 20, f1 = 20000, db = -6, seconds = 2, rate = RATE, channels = 2 } = {}) {
  const a = fromDb(db);
  const x = new Float32Array(frames(seconds, rate));
  const k = Math.log(f1 / f0);
  for (let i = 0; i < x.length; i++) { const t = i / rate; x[i] = a * Math.sin(2 * Math.PI * f0 * seconds / k * (Math.exp(t * k / seconds) - 1)); }
  return mono(x, rate, channels);
}

// One sample at `db` dBFS at `at` seconds, silence elsewhere.
export function impulse({ at = 0, db = 0, seconds = 1, rate = RATE, channels = 2 } = {}) {
  const x = new Float32Array(frames(seconds, rate));
  x[Math.round(at * rate)] = fromDb(db);
  return mono(x, rate, channels);
}

export function silence({ seconds = 1, rate = RATE, channels = 2 } = {}) {
  return mono(new Float32Array(frames(seconds, rate)), rate, channels);
}

// Short tone bursts starting at the given times (seconds): what the onset finder and timing tests listen for.
export function bursts({ at = [0.25, 0.5], freq = 1000, db = -12, length = 0.05, seconds = 1, rate = RATE, channels = 2 } = {}) {
  const x = new Float32Array(frames(seconds, rate));
  const a = fromDb(db);
  for (const s of at) { const b = Math.round(s * rate); for (let i = 0; i < frames(length, rate) && b + i < x.length; i++) x[b + i] = a * Math.sin(2 * Math.PI * freq * i / rate); }
  return mono(x, rate, channels);
}

// Signals placed one after another (same rate and channel count).
export function concat(...sigs) {
  const n = sigs.reduce((s, x) => s + x.channels[0].length, 0);
  const out = sigs[0].channels.map(() => new Float32Array(n));
  let at = 0;
  for (const s of sigs) { s.channels.forEach((c, i) => out[i].set(c, at)); at += s.channels[0].length; }
  return { rate: sigs[0].rate, channels: out };
}

// ---------- WAV writing ----------

// 32-bit float (default) or 24 / 16-bit PCM (plain rounding: tests that need dither add it themselves).
export function writeWav(path, sig, { bits = 32 } = {}) {
  const n = sig.channels[0].length;
  const ch = sig.channels.length;
  const step = bits / 8;
  const data = Buffer.alloc(n * ch * step);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = sig.channels[c][i];
    const o = (i * ch + c) * step;
    if (bits === 32) data.writeFloatLE(v, o);
    else if (bits === 24) data.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(v * 8388608))), o, 3);
    else data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), o);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(bits === 32 ? 3 : 1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(sig.rate, 24); h.writeUInt32LE(sig.rate * ch * step, 28); h.writeUInt16LE(ch * step, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

// ---------- measurements ----------

const span = (sig, from = 0, to) => {
  const n = sig.channels[0].length;
  return [Math.max(0, Math.floor(from * sig.rate)), Math.min(n, to === undefined ? n : Math.ceil(to * sig.rate))];
};

// Sample peak over all channels (dBFS) and where it is (seconds).
export function peak(sig, from, to) {
  const [a, z] = span(sig, from, to);
  let p = 0; let at = 0;
  for (const c of sig.channels) for (let i = a; i < z; i++) if (Math.abs(c[i]) > p) { p = Math.abs(c[i]); at = i; }
  return { db: dB(p), linear: p, at: at / sig.rate };
}

// RMS per channel and over all (dBFS).
export function rms(sig, from, to) {
  const [a, z] = span(sig, from, to);
  const per = sig.channels.map((c) => { let s = 0; for (let i = a; i < z; i++) s += c[i] * c[i]; return s / Math.max(1, z - a); });
  return { db: dB(Math.sqrt(per.reduce((s, x) => s + x, 0) / per.length)), channels: per.map((x) => dB(Math.sqrt(x))) };
}

// Null test: the difference a − b (after optional gain on b and a sample offset). Returns the residual's peak and
// RMS in dBFS; a bit-identical pair reads −Infinity.
export function nullTest(a, b, { offset = 0, gainDb = 0 } = {}) {
  if (a.channels.length !== b.channels.length) throw new Error(`channel counts differ: ${a.channels.length} vs ${b.channels.length}`);
  const g = fromDb(gainDb);
  const n = Math.min(a.channels[0].length, b.channels[0].length - offset);
  let p = 0; let s = 0; let identical = true;
  for (let c = 0; c < a.channels.length; c++) for (let i = 0; i < n; i++) {
    const d = a.channels[c][i] - g * (b.channels[c][i + offset] ?? 0);
    if (d !== 0) identical = false;
    if (Math.abs(d) > p) p = Math.abs(d);
    s += d * d;
  }
  return { identical, peakDb: dB(p), rmsDb: dB(Math.sqrt(s / Math.max(1, n * a.channels.length))), frames: n };
}

// Magnitude spectrum of one channel (Hann window, radix-2 FFT of the first `size` samples from `from` seconds).
// Returns bins with frequency and dB re a full-scale sine (a 0 dBFS sine reads ≈ 0 dB at its bin).
export function spectrum(sig, { channel = 0, from = 0, size = 16384 } = {}) {
  if (size & (size - 1)) throw new Error('size must be a power of two');
  const re = new Float64Array(size); const im = new Float64Array(size);
  const x = sig.channels[channel];
  const a = Math.floor(from * sig.rate);
  let wsum = 0;
  for (let i = 0; i < size; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)); wsum += w; re[i] = (x[a + i] ?? 0) * w; }
  fft(re, im);
  const out = [];
  for (let k = 0; k <= size / 2; k++) out.push({ freq: k * sig.rate / size, db: dB(2 * Math.hypot(re[k], im[k]) / wsum) });
  return out;
}

// The strongest bins, with neighbours folded in (one per peak).
export function strongest(bins, count = 1) {
  const peaks = [];
  for (let k = 1; k < bins.length - 1; k++) if (bins[k].db >= bins[k - 1].db && bins[k].db > bins[k + 1].db) peaks.push(bins[k]);
  return peaks.sort((p, q) => q.db - p.db).slice(0, count);
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar; im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar; im[i + j] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Onsets: times (seconds) where the level jumps up out of quiet. The signal is cut into `hop`-sample frames; an onset
// is the first sample above `thresholdDb` after at least `gap` seconds below it. Sample-accurate within the frame.
export function onsets(sig, { thresholdDb = -40, gap = 0.02 } = {}) {
  const lim = fromDb(thresholdDb);
  const n = sig.channels[0].length;
  const quietNeed = Math.round(gap * sig.rate);
  const out = [];
  let quiet = quietNeed;
  for (let i = 0; i < n; i++) {
    let loud = false;
    for (const c of sig.channels) if (Math.abs(c[i]) > lim) { loud = true; break; }
    if (loud) { if (quiet >= quietNeed) out.push(i / sig.rate); quiet = 0; } else quiet++;
  }
  return out;
}

// A Butterworth high-pass of even `order` (order / 2 RBJ biquads, Q from the Butterworth pole angles), run forward over
// each channel in double. For residual tests: what's left above `hz` (doc 15 Q9: zipper noise above 5 kHz).
export function highpass(sig, { hz, order = 8 } = {}) {
  const w = (2 * Math.PI * hz) / sig.rate;
  const cos = Math.cos(w);
  const stages = Array.from({ length: order / 2 }, (_, k) => {
    const q = 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order)));
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
  });
  const channels = sig.channels.map((c) => {
    let x = Float64Array.from(c);
    for (const s of stages) {
      const y = new Float64Array(x.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const v = s.b0 * x[i] + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
      }
      x = y;
    }
    return Float32Array.from(x);
  });
  return { rate: sig.rate, channels };
}
