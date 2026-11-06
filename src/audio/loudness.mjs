// Loudness and true peak, written from the standards (doc 15 A2): ITU-R BS.1770-5 (K-weighting, gating, true peak),
// EBU Tech 3341 V4 ("EBU Mode": momentary 0.4 s, short-term 3 s) and EBU Tech 3342 (loudness range). It is the
// reference the engine's meters are checked against, and is itself checked against EBU's test cases and ffmpeg.
// Input: { rate, channels: [Float32Array, …] }. Channel weights: 1 for L, R, C; 1.41 for surrounds; 0 for LFE.

const ABS_GATE = -70;
const REL_GATE = -10;     // integrated (BS.1770-5)
const LRA_REL_GATE = -20; // loudness range (Tech 3342)

// The default weights by channel count: mono, stereo, 5.0 (L R C Ls Rs), 5.1 (L R C LFE Ls Rs).
export function defaultWeights(n) {
  if (n === 5) return [1, 1, 1, 1.41, 1.41];
  if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
  return Array(n).fill(1);
}

// K-weighting: a high shelf then a high-pass. BS.1770 gives the coefficients at 48 kHz only; these are the analogue
// prototypes they come from (as in libebur128), so every rate gets its own and 48 kHz matches the standard's table.
export function kCoefficients(rate) {
  let K = Math.tan(Math.PI * 1681.974450955533 / rate);
  const Q1 = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q1 + K * K;
  const shelf = { b: [(Vh + Vb * K / Q1 + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q1 + K * K) / a0], a: [2 * (K * K - 1) / a0, (1 - K / Q1 + K * K) / a0] };
  K = Math.tan(Math.PI * 38.13547087602444 / rate);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const hp = { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q2 + K * K) / a0] };
  return { shelf, hp };
}

function biquad(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// Running sums of the weighted, K-filtered power over all channels: power of any window in O(1).
function powerSums(sig, weights) {
  const { shelf, hp } = kCoefficients(sig.rate);
  const n = sig.channels[0].length;
  const sums = new Float64Array(n + 1);
  sig.channels.forEach((ch, c) => {
    const w = weights[c] ?? 1;
    if (!w) return;
    const y = biquad(biquad(ch, shelf), hp);
    for (let i = 0; i < n; i++) sums[i + 1] += w * y[i] * y[i];
  });
  for (let i = 0; i < n; i++) sums[i + 1] += sums[i];
  return sums;
}

const lufs = (meanPower) => (meanPower > 0 ? -0.691 + 10 * Math.log10(meanPower) : -Infinity);
const windowLoudness = (sums, a, z) => lufs((sums[z] - sums[a]) / (z - a));

// Loudness of windows of `seconds`, ending every `step` seconds (only whole windows).
function series(sums, rate, seconds, step) {
  const len = Math.round(seconds * rate);
  const hop = Math.max(1, Math.round(step * rate));
  const out = [];
  for (let z = len; z < sums.length; z += hop) out.push({ t: z / rate, lufs: windowLoudness(sums, z - len, z) });
  return out;
}

// Integrated loudness, BS.1770-5: 400 ms blocks with 75 % overlap, absolute gate −70 LUFS, relative gate −10 LU.
function integrated(sums, rate) {
  const blocks = series(sums, rate, 0.4, 0.1).map((b) => b.lufs).filter((l) => l > ABS_GATE);
  if (!blocks.length) return -Infinity;
  const mean = (ls) => ls.reduce((s, l) => s + 10 ** ((l + 0.691) / 10), 0) / ls.length;
  const rel = lufs(mean(blocks)) + REL_GATE;
  const gated = blocks.filter((l) => l > rel);
  return gated.length ? lufs(mean(gated)) : -Infinity;
}

// Loudness range, EBU Tech 3342: short-term values at 10 Hz, gates −70 LUFS and −20 LU, 95th − 10th percentile.
function loudnessRange(shortTerm) {
  const abs = shortTerm.filter((l) => l >= ABS_GATE);
  if (!abs.length) return 0;
  const power = abs.reduce((s, l) => s + 10 ** (l / 10), 0) / abs.length;
  const rel = abs.filter((l) => l >= 10 * Math.log10(power) + LRA_REL_GATE).sort((a, b) => a - b);
  const n = rel.length;
  if (!n) return 0;
  return rel[Math.round((n - 1) * 0.95)] - rel[Math.round((n - 1) * 0.10)];
}

// ---------- true peak (BS.1770-5 Annex 2): oversample to at least 192 kHz, take the largest magnitude ----------

const besselI0 = (x) => { let s = 1; let t = 1; for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; } return s; };

// The value between samples i and i+1 at fraction f is Σ x[i + o] · g(f − o) over offsets o = −(taps/2 − 1) … taps/2,
// with g a windowed sinc (Kaiser, β = 8): a low-pass at the original Nyquist. One set of taps per fraction p/factor,
// scaled to unity gain at DC.
const filters = new Map();
function interpolator(factor, taps = 48) {
  const key = `${factor}:${taps}`;
  if (filters.has(key)) return filters.get(key);
  const half = taps / 2;
  const beta = 8;
  const phases = [];
  for (let p = 1; p < factor; p++) {
    const f = p / factor;
    const ph = new Float64Array(taps);
    for (let j = 0; j < taps; j++) {
      const x = f - (j - half + 1);
      const r = x / half;
      ph[j] = (Math.sin(Math.PI * x) / (Math.PI * x)) * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(beta);
    }
    const g = ph.reduce((s, v) => s + v, 0);
    for (let j = 0; j < taps; j++) ph[j] /= g;
    phases.push(ph);
  }
  filters.set(key, phases);
  return phases;
}

// The largest magnitude of one channel between and on its samples.
export function truePeakLinear(x, rate) {
  const factor = Math.max(1, Math.ceil(192000 / rate));
  let peak = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak) peak = Math.abs(x[i]);
  if (factor === 1) return peak;
  const phases = interpolator(factor);
  const taps = phases[0].length;
  const lo = taps / 2 - 1;
  const n = x.length;
  // the edges read zeros beyond the ends; the middle needs no bounds checks
  const padded = new Float64Array(n + taps);
  padded.set(x, lo);
  const P = phases.length;
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < P; p++) {
      const ph = phases[p];
      let s = 0;
      for (let j = 0; j < taps; j++) s += ph[j] * padded[i + j];
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
  }
  return peak;
}

const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

// Everything at once. `step` is how often the momentary and short-term series are sampled (EBU: ≥ 10 Hz);
// maxMomentary / maxShortTerm are found at 1 ms resolution, so a burst is never missed between steps.
export function measure(sig, { weights = defaultWeights(sig.channels.length), step = 0.1, truePeak = true } = {}) {
  const sums = powerSums(sig, weights);
  const momentary = series(sums, sig.rate, 0.4, step);
  const shortTerm = series(sums, sig.rate, 3, step);
  const max = (s) => s.reduce((m, x) => Math.max(m, x.lufs), -Infinity);
  const fine = 0.001;
  const out = {
    integrated: integrated(sums, sig.rate),
    momentary,
    shortTerm,
    maxMomentary: max(series(sums, sig.rate, 0.4, fine)),
    maxShortTerm: max(series(sums, sig.rate, 3, fine)),
    range: loudnessRange(series(sums, sig.rate, 3, 0.1).map((x) => x.lufs)),
    samplePeak: dB(Math.max(...sig.channels.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)))),
  };
  if (truePeak) {
    const per = sig.channels.map((c) => truePeakLinear(c, sig.rate));
    out.truePeak = dB(Math.max(...per));
    out.truePeakChannels = per.map(dB);
  }
  return out;
}
