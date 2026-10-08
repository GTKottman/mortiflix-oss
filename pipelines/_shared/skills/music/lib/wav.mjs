// Reading the WAV files Strudel renders (PCM 16/24/32-bit or 32-bit float) and measuring them: level over a stretch of
// time, and the mix balance a listener hears (how much energy sits in the low end and in the "mud" band, stereo width).
// No dependencies; the numbers are reported as measurements, never as listening.
import { readFileSync } from 'node:fs';

export function readWav(fileOrBuf) {
  const b = Buffer.isBuffer(fileOrBuf) ? fileOrBuf : readFileSync(fileOrBuf);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null; let data = null;
  for (let o = 12; o + 8 <= b.length;) {
    const id = b.toString('latin1', o, o + 4); const size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') { data = b.subarray(o + 8, Math.min(b.length, o + 8 + size)); break; }
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV without fmt or data');
  const { channels, bits } = fmt; const float = fmt.format === 3;
  const step = bits / 8; const frames = Math.floor(data.length / (step * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * step;
      out[c][i] = float ? data.readFloatLE(o) : bits === 16 ? data.readInt16LE(o) / 32768 : bits === 24 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648;
    }
  }
  return { rate: fmt.rate, channels: out, seconds: frames / fmt.rate };
}

export const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);

// RMS and peak (dBFS, both channels) over [from, to) seconds.
export function levelOf(wav, from = 0, to = wav.seconds) {
  const a = Math.max(0, Math.floor(from * wav.rate)); const z = Math.min(wav.channels[0].length, Math.ceil(to * wav.rate));
  let ss = 0; let peak = 0; let n = 0;
  for (const ch of wav.channels) for (let i = a; i < z; i++) { const v = ch[i]; ss += v * v; n++; if (Math.abs(v) > peak) peak = Math.abs(v); }
  return { rms_db: +db(Math.sqrt(ss / Math.max(1, n))).toFixed(1), peak_db: +db(peak).toFixed(1) };
}

// The first moment the audio rises above `threshold_db` (seconds), or null if it never does.
export function firstSound(wav, threshold_db = -45) {
  const lim = 10 ** (threshold_db / 20);
  for (let i = 0; i < wav.channels[0].length; i++) for (const ch of wav.channels) if (Math.abs(ch[i]) > lim) return +(i / wav.rate).toFixed(3);
  return null;
}

// A biquad (RBJ cookbook) run over a whole channel: enough to split the mix into bands.
function biquad(x, rate, type, f, q = 0.707) {
  const w = 2 * Math.PI * f / rate; const cs = Math.cos(w); const al = Math.sin(w) / (2 * q);
  const [b0, b1, b2] = type === 'lp' ? [(1 - cs) / 2, 1 - cs, (1 - cs) / 2] : [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2];
  const a0 = 1 + al; const a1 = -2 * cs; const a2 = 1 - al;
  const y = new Float32Array(x.length); let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
const energy = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return s; };

// The mix as a listener hears it: % of the energy below 150 Hz (low end), in 150-400 Hz (mud), and the stereo width
// (side level relative to mid, dB). Targets come from Mini Music's mix check: low end >= 20%, mud <= 40%, width >= -12 dB.
export const MIX_TARGETS = { lowPct: 20, mudPct: 40, widthDb: -12 };
export function mixBalance(wav) {
  const [L, R = L] = wav.channels;
  const mid = new Float32Array(L.length); const side = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) { mid[i] = (L[i] + R[i]) / 2; side[i] = (L[i] - R[i]) / 2; }
  const total = energy(mid) || 1e-12;
  const low = energy(biquad(mid, wav.rate, 'lp', 150));
  const upTo400 = energy(biquad(mid, wav.rate, 'lp', 400));
  const lowPct = +(100 * low / total).toFixed(1);
  const mudPct = +(100 * Math.max(0, upTo400 - low) / total).toFixed(1);
  const widthDb = +(db(Math.sqrt(energy(side) / L.length)) - db(Math.sqrt(total / L.length))).toFixed(1);
  const notes = [];
  if (lowPct < MIX_TARGETS.lowPct) notes.push(`thin low end: ${lowPct}% of the energy is below 150 Hz (aim for ${MIX_TARGETS.lowPct}% or more): raise the bass or kick, or give them more body`);
  if (mudPct > MIX_TARGETS.mudPct) notes.push(`muddy: ${mudPct}% of the energy sits in 150-400 Hz (aim for under ${MIX_TARGETS.mudPct}%): high-pass or thin the pads and chords there`);
  if (widthDb < MIX_TARGETS.widthDb) notes.push(`narrow: the sides are ${widthDb} dB under the middle (aim for ${MIX_TARGETS.widthDb} dB or wider): pan the body parts apart, keep bass and kick centred`);
  return { lowPct, mudPct, widthDb, notes };
}
