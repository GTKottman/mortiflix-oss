// Hearing a song: its tempo, beats, key and chords, read from the audio itself (no AI). A "Like this song" reference
// the owner hands over is heard once it's copied in, so the music step knows the song's tempo, key and chords
// instead of guessing them from its name.
//
// The analysis is ported from Visual-Harmonics (js/core/analyze.js, the Melody tab's backing-track import),
// MIT © 2026 Elias Berntsen, https://github.com/elias1328/Visual-Harmonics: onset flux → tempo by autocorrelation and
// a comb search; harmonic/percussive split by median filtering → chroma per beat → chords (Viterbi over chord templates)
// → key (Krumhansl-Kessler). Ported as plain functions; the maths is unchanged.
//
// Run as its own process (hearSong spawns `node listen.mjs <file>`): a 4-minute song takes a few seconds of CPU and the
// service must not stall meanwhile.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SR = 22050;
const TRACK_SR = 11025;
const MAX_SEC = 600;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// In-place iterative radix-2 FFT. re/im: Float64Array of length 2^k.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Two cascaded biquad low-passes (Butterworth, 4th order), then decimation to ~TRACK_SR.
function downsample(x, sr, target = TRACK_SR) {
  const f = Math.max(1, Math.round(sr / target));
  if (f === 1) return { y: Float32Array.from(x), sr };
  const fc = 0.42 * sr / f, w = 2 * Math.PI * fc / sr, cw = Math.cos(w), sw = Math.sin(w);
  let y = x;
  for (const Q of [0.5412, 1.3066]) {
    const al = sw / (2 * Q), a0 = 1 + al, b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    const o = new Float32Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = y[i], r = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = r; o[i] = r; }
    y = o;
  }
  const n = Math.floor(y.length / f), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = y[i * f];
  return { y: out, sr: sr / f };
}

const hannOf = (N) => Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));

// Onset strength: positive spectral flux of log magnitudes (N 512, hop 64 at ~11 kHz). Frame i is at
// (i * hop + N / 2) / sr + ONSET_BIAS (the flux peaks a little before the attack reaches the centre).
const ONSET_BIAS = 0.015;
function onsetEnv(y, sr, N = 512, hop = 64) {
  const nf = Math.max(0, Math.floor((y.length - N) / hop) + 1), w = hannOf(N), K = N / 2;
  const env = new Float32Array(nf), re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(K), cur = new Float64Array(K);
  for (let i = 0; i < nf; i++) {
    const a = i * hop;
    for (let k = 0; k < N; k++) { re[k] = y[a + k] * w[k]; im[k] = 0; }
    fft(re, im);
    let s = 0;
    for (let k = 1; k < K; k++) { const m = Math.log(1 + 20 * Math.hypot(re[k], im[k])); cur[k] = m; const d = m - prev[k]; if (d > 0) s += d; }
    env[i] = i ? s : 0;
    const t = prev; prev = cur; cur = t;
  }
  return { env, fps: sr / hop, t0: N / 2 / sr + ONSET_BIAS };
}

// Subtract a ~0.25 s moving mean, half-wave rectify, scale to max 1.
function onsetNorm(env, fps) {
  const n = env.length, h = Math.max(1, Math.round(0.125 * fps)), out = new Float32Array(n), pre = new Float64Array(n + 1);
  let mx = 0;
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - h), b = Math.min(n, i + h + 1); const v = env[i] - (pre[b] - pre[a]) / (b - a); out[i] = v > 0 ? v : 0; if (out[i] > mx) mx = out[i]; }
  if (mx > 0) for (let i = 0; i < n; i++) out[i] /= mx;
  return out;
}

const lerpAt = (a, x) => { const i = Math.floor(x); if (i < 0 || i >= a.length - 1) return 0; const u = x - i; return a[i] * (1 - u) + a[i + 1] * u; };

// Tempo (60..180 BPM) + beat phase from an onset envelope: autocorrelation with a weak log-tempo prior picks the
// period, then a comb search (period ±4 %, every phase) refines period and phase together.
// → { bpm, period (s), phase (s, first beat ≥ 0), conf 0..1 }
export function tempoOf(envRaw, fps, t0, { lo = 60, hi = 180 } = {}) {
  const env = onsetNorm(envRaw, fps), n = env.length;
  const lMin = Math.floor(60 * fps / hi) - 1, lMax = Math.ceil(60 * fps / lo) + 1;
  if (n < lMax * 2) return { bpm: 0, period: 0, phase: 0, conf: 0 };
  const acf = new Float64Array(lMax + 2);
  let mean = 0; for (let i = 0; i < n; i++) mean += env[i]; mean /= n;
  for (let l = Math.max(1, lMin - 1); l <= lMax + 1; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += (env[i] - mean) * (env[i + l] - mean); acf[l] = s / (n - l); }
  const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);
  const cands = [];
  for (let l = Math.max(2, lMin); l <= lMax; l++) {
    if (acf[l] <= 0 || acf[l] < acf[l - 1] || acf[l] < acf[l + 1]) continue;
    const a = acf[l - 1], b = acf[l], c = acf[l + 1], den = a - 2 * b + c, off = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
    const bpm = 60 * fps / (l + off);
    if (bpm < lo - 1 || bpm > hi + 1) continue;
    cands.push({ bpm, s: b * prior(bpm) });
  }
  cands.sort((p, q) => q.s - p.s);
  if (!cands.length) return { bpm: 0, period: 0, phase: 0, conf: 0 };
  const sc = (P, p) => { let s = 0, k = 0; for (let x = p; x < n - 1; x += P) { if (x >= 0) { s += lerpAt(env, x); k++; } } return s / (k || 1); };
  const comb = (P) => {   // P in frames → best phase (frames) and its mean onset value
    let best = -1, bp = 0;
    for (let p = 0; p < Math.ceil(P); p++) { const s = sc(P, p); if (s > best) { best = s; bp = p; } }
    const a = sc(P, bp - 0.5), b = sc(P, bp), c = sc(P, bp + 0.5), den = a - 2 * b + c, off = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) * 0.5 : 0;
    return { s: best, p: bp + off };
  };
  // a few strong candidates (and their ×2 / ÷2 when in range), each refined by the comb
  const tries = [];
  cands.slice(0, 3).forEach((c) => [c.bpm, c.bpm * 2, c.bpm / 2].forEach((b) => { if (b >= lo - 1 && b <= hi + 1 && !tries.some((t) => Math.abs(t / b - 1) < 0.03)) tries.push(b); }));
  let best = null;
  for (const b0 of tries) {
    let bb = null;
    for (let r = -0.04; r <= 0.04 + 1e-9; r += 0.002) {
      const bpm = b0 * (1 + r), P = 60 * fps / bpm, cb = comb(P);
      if (!bb || cb.s > bb.s) bb = { bpm, s: cb.s, p: cb.p };
    }
    for (let r = -0.002; r <= 0.002 + 1e-9; r += 0.0002) {
      const bpm = bb.bpm * (1 + r), P = 60 * fps / bpm, cb = comb(P);
      if (cb.s > bb.s) bb = { bpm, s: cb.s, p: cb.p };
    }
    const score = bb.s * prior(bb.bpm);
    if (!best || score > best.score) best = { ...bb, score };
  }
  const period = 60 / best.bpm;
  let phase = best.p / fps + t0;
  phase = ((phase % period) + period) % period;
  return { bpm: best.bpm, period, phase, conf: Math.min(1, best.s / (mean * 3 + 1e-9) / 3) };
}

// Sliding median of `len` values (len is small: insertion sort into a scratch buffer).
const MB = new Float64Array(64);
function median(a, len) {
  for (let i = 0; i < len; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && MB[j] > v) { MB[j + 1] = MB[j]; j--; } MB[j + 1] = v; }
  return MB[len >> 1];
}

// Chroma per frame of the harmonic part: STFT (N 4096, hop 512 at ~11 kHz) up to 4 kHz, harmonic / percussive split
// by median filtering (soft mask H² / (H² + P²)), then the harmonic peaks folded onto the 12 pitch classes.
const FR_N = 4096, FR_HOP = 512, MED = 9;
function chromaFrames(y, sr) {
  const N = FR_N, hop = FR_HOP, nf = Math.max(0, Math.floor((y.length - N) / hop) + 1), binHz = sr / N;
  const K = Math.min(N / 2 - 1, Math.floor(4000 / binHz)), w = hannOf(N), half = MED >> 1;
  const mags = new Map(), chroma = new Float32Array(nf * 12);
  const re = new Float64Array(N), im = new Float64Array(N), tmp = new Float64Array(MED);
  const magAt = (i) => {
    i = Math.max(0, Math.min(nf - 1, i));
    let m = mags.get(i);
    if (m) return m;
    const a = i * hop; m = new Float32Array(K);
    for (let k = 0; k < N; k++) { re[k] = (y[a + k] || 0) * w[k]; im[k] = 0; }
    fft(re, im);
    for (let k = 0; k < K; k++) m[k] = Math.hypot(re[k], im[k]) / (N / 4);
    mags.set(i, m);
    return m;
  };
  for (let t = 0; t < nf; t++) {
    const R = []; for (let j = -half; j <= half; j++) R.push(magAt(t + j));
    const X = R[half], H = new Float32Array(K), L = R.length;
    for (let k = 0; k < K; k++) {   // harmonic: median over time; percussive: median over frequency
      for (let j = 0; j < L; j++) tmp[j] = R[j][k];
      const h = median(tmp, L);
      const a = Math.max(0, k - half), b = Math.min(K, k + half + 1), m = b - a;
      for (let j = 0; j < m; j++) tmp[j] = X[a + j];
      const pp = median(tmp, m), h2 = h * h, p2 = pp * pp;
      H[k] = X[k] * (h2 + p2 > 0 ? h2 / (h2 + p2) : 0);
    }
    let mx = 0;
    for (let k = 0; k < K; k++) if (H[k] > mx) mx = H[k];
    if (mx > 1e-6) {
      const floor = mx * 0.004, k0 = Math.max(2, Math.floor(35 / binHz));
      const pks = [];
      for (let k = k0; k < K - 1; k++) {
        const b = H[k];
        if (b < floor || b < H[k - 1] || b < H[k + 1]) continue;
        const la = Math.log(H[k - 1] + 1e-12), lb = Math.log(b + 1e-12), lc = Math.log(H[k + 1] + 1e-12), den = la - 2 * lb + lc, off = den ? 0.5 * (la - lc) / den : 0;
        pks.push([(k + off) * binHz, Math.exp(lb - 0.25 * (la - lc) * off)]);
      }
      pks.sort((p, q) => q[1] - p[1]);
      for (const [f, a] of pks.slice(0, 32)) if (f >= 40 && f <= 2100) { const pc = ((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12; chroma[t * 12 + pc] += Math.sqrt(a); }
    }
    mags.delete(t - half);
  }
  return { fps: sr / hop, t0: N / 2 / sr, nf, chroma };
}

// ---- chords + key ----
const CHORD_IV = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10] };
const CHORD_PRIOR = { maj: 1, min: 1, 7: 0.93, m7: 0.93, maj7: 0.9, sus2: 0.86, sus4: 0.86, dim: 0.86, aug: 0.8 };
// the names harmony.mjs's parseChord reads
const SUFFIX = { maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4', 7: '7', maj7: 'maj7', m7: 'm7' };
export const chordName = (c) => (c ? `${NAMES[c[0]]}${SUFFIX[c[1]]}` : null);
const TEMPL = [];
for (const q of Object.keys(CHORD_IV)) for (let r = 0; r < 12; r++) {
  const t = new Float64Array(12);
  CHORD_IV[q].forEach((iv, j) => { t[(r + iv) % 12] = j ? 1 : 1.15; });
  let n = 0; for (const v of t) n += v * v;
  TEMPL.push({ r, q, t, n: Math.sqrt(n), pr: CHORD_PRIOR[q] });
}
function chordScores(c) {
  let cn = 0; for (let i = 0; i < 12; i++) cn += c[i] * c[i]; cn = Math.sqrt(cn) || 1;
  return TEMPL.map((T) => { let d = 0; for (let i = 0; i < 12; i++) d += c[i] * T.t[i]; return d / cn / T.n * T.pr; });
}
// Smoothed chord sequence over beat chromas (Viterbi: score − change penalty) → [[root, q] | null per beat].
function chordSeq(chromas, pen = 0.12) {
  const n = chromas.length, S = TEMPL.length;
  if (!n) return [];
  const sc = chromas.map(chordScores), back = [];
  let v = sc[0].slice();
  for (let t = 1; t < n; t++) {
    let bi = 0; for (let j = 1; j < S; j++) if (v[j] > v[bi]) bi = j;
    const nv = new Array(S), bk = new Int16Array(S);
    for (let j = 0; j < S; j++) { const stay = v[j], sw = v[bi] - pen; if (stay >= sw) { nv[j] = stay + sc[t][j]; bk[j] = j; } else { nv[j] = sw + sc[t][j]; bk[j] = bi; } }
    v = nv; back.push(bk);
  }
  let j = 0; for (let k = 1; k < S; k++) if (v[k] > v[j]) j = k;
  const out = new Array(n);
  for (let t = n - 1; t >= 0; t--) {
    const e = chromas[t].reduce((s, x) => s + x, 0);
    out[t] = e > 1e-9 ? [TEMPL[j].r, TEMPL[j].q] : null;
    if (t) j = back[t - 1][j];
  }
  return out;
}
// Krumhansl-Kessler key profiles; the key is the best Pearson correlation with the song's chroma. A song usually
// starts on its tonic: the first chord's key gets +0.15 (settles relative major / minor).
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function pearson(a, b) {
  let ma = 0, mb = 0; for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; } ma /= 12; mb /= 12;
  let s = 0, sa = 0, sb = 0; for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; }
  return sa && sb ? s / Math.sqrt(sa * sb) : 0;
}
function keyOf(chroma, tonic) {
  let best = null;
  for (let r = 0; r < 12; r++) for (const [mode, P] of [['major', KK_MAJ], ['minor', KK_MIN]]) {
    let s = pearson(chroma, Array.from({ length: 12 }, (_, i) => P[(i - r + 12) % 12]));
    if (tonic && tonic[0] === r && ((mode === 'major') === ['maj', '7', 'maj7'].includes(tonic[1]))) s += 0.15;
    if (!best || s > best.r) best = { root: r, mode, r: s };
  }
  return best;
}

// The grid: beats from the tempo, chroma per beat, chords per beat, the downbeat (where the harmony changes most),
// chords per bar (a bar whose halves differ is split), trailing fade-out bars dropped, the key.
function grid(fr, bpm, phase, dur, bpb = 4) {
  const T = 60 / bpm, nb = Math.max(1, Math.ceil((dur - phase) / T)), chromas = [];
  for (let b = 0; b < nb; b++) {
    const t0 = phase + b * T, t1 = t0 + T, c = new Float64Array(12);
    const a = Math.max(0, Math.ceil((t0 - fr.t0) * fr.fps)), z = Math.min(fr.nf - 1, Math.floor((t1 - fr.t0) * fr.fps - 1e-9));
    for (let i = a; i <= z; i++) for (let k = 0; k < 12; k++) c[k] += fr.chroma[i * 12 + k];
    chromas.push(c);
  }
  const seq = chordSeq(chromas);
  const same = (p, q) => (p && q ? p[0] === q[0] && p[1] === q[1] : p === q);
  const sc = new Float64Array(bpb);
  const cos = (p, q) => { let d = 0, a = 0, b = 0; for (let k = 0; k < 12; k++) { d += p[k] * q[k]; a += p[k] * p[k]; b += q[k] * q[k]; } return a && b ? d / Math.sqrt(a * b) : 1; };
  for (let b = 1; b < nb; b++) sc[b % bpb] += (1 - cos(chromas[b], chromas[b - 1])) + (seq[b] && seq[b - 1] && !same(seq[b], seq[b - 1]) ? 0.5 : 0);
  let db = 0; for (let k = 1; k < bpb; k++) if (sc[k] > sc[db] + 1e-9) db = k;
  const first = phase + db * T, barSec = bpb * T;
  let nBars = Math.max(1, Math.ceil((dur - first - 0.5 * T) / barSec));
  {   // drop trailing bars that only hold a fade-out (harmonic energy < 12 % of the median bar)
    const en = []; for (let k = 0; k < nBars; k++) { let s = 0; for (let j = 0; j < bpb; j++) { const c = chromas[db + k * bpb + j]; if (c) for (let q = 0; q < 12; q++) s += c[q]; } en.push(s); }
    const med = en.slice().sort((p, q) => p - q)[en.length >> 1] || 0;
    while (nBars > 1 && en[nBars - 1] < 0.12 * med) nBars--;
  }
  const count = (arr) => { const m = new Map(); for (const c of arr) if (c) { const k = chordName(c); m.set(k, { c, n: (m.get(k)?.n || 0) + 1 }); } return [...m.values()].sort((p, q) => q.n - p.n); };
  const bars = [];
  for (let k = 0; k < nBars; k++) {
    const bs = []; for (let j = 0; j < bpb; j++) { const b = db + k * bpb + j; bs.push(b < nb ? seq[b] : null); }
    const all = count(bs), h = bpb >> 1, A = count(bs.slice(0, h)), B = count(bs.slice(h));
    if (h >= 2 && A.length && B.length && A[0].n === h && B[0].n === bpb - h && !same(A[0].c, B[0].c)) bars.push([A[0].c, B[0].c]);
    else bars.push([all.length ? all[0].c : null]);
  }
  const tot = new Float64Array(12);
  for (const c of chromas) { let s = 0; for (let k = 0; k < 12; k++) s += c[k]; if (s > 0) for (let k = 0; k < 12; k++) tot[k] += c[k] / s; }
  const key = keyOf(tot, bars[0]?.[0] || null);
  return { first, barSec, bars, key };
}

// Mono samples (Float32Array at `sr`) → what the song is: { seconds, bpm, confidence, first_downbeat_sec, bar_sec,
// key: "A minor", chords: ["Am", "F", "C", "G", ...] one per bar ("Am|F" for a bar split in halves), progression:
// the bars' chords with repeats folded, e.g. "Am F C G ×12" }.
export function hearSamples(x, sr) {
  const seconds = x.length / sr;
  const { y, sr: r2 } = downsample(x, sr);
  const on = onsetEnv(y, r2);
  const tempo = tempoOf(on.env, on.fps, on.t0);
  if (!tempo.bpm) return { seconds: r3(seconds), bpm: null, confidence: 0, key: null, chords: [], progression: '' };
  const fr = chromaFrames(y, r2);
  const g = grid(fr, tempo.bpm, tempo.phase, seconds);
  const chords = g.bars.map((b) => b.map(chordName).map((n) => n || '-').join('|'));
  return {
    seconds: r3(seconds), bpm: Math.round(tempo.bpm * 10) / 10, confidence: Math.round(tempo.conf * 100) / 100,
    first_downbeat_sec: r3(g.first), bar_sec: r3(g.barSec),
    key: `${NAMES[g.key.root]} ${g.key.mode}`, chords, progression: progressionOf(chords),
  };
}
const r3 = (v) => Math.round(v * 1000) / 1000;

// The loop the song keeps playing: the shortest run of 1-8 bars that repeats most at the start, then its count.
export function progressionOf(chords) {
  if (!chords.length) return '';
  let best = null;
  for (let len = 1; len <= Math.min(8, chords.length); len++) {
    let reps = 0;
    for (let i = 0; i + len <= chords.length; i += len) { if (chords.slice(i, i + len).join() === chords.slice(0, len).join()) reps++; else break; }
    if (reps >= 2 && (!best || reps * len > best.reps * best.len)) best = { len, reps };
  }
  if (!best) return chords.join(' ');
  const rest = chords.length - best.reps * best.len;
  return `${chords.slice(0, best.len).join(' ')} ×${best.reps}${rest ? `, then ${rest} more bar${rest === 1 ? '' : 's'}` : ''}`;
}

// Decode any audio file to mono float samples with ffmpeg (first 10 minutes).
function decode(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-t', String(MAX_SEC), '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code) return reject(new Error(`ffmpeg couldn't read the song: ${err.trim().split('\n').pop() || `exit ${code}`}`));
      const b = Buffer.concat(out);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

// Hear a song file in its own process → the hearSamples result.
export function hearSong(file, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code) return reject(new Error(err.trim().split('\n').pop() || `listening stopped (exit ${code})`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('listening gave no result')); }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  decode(process.argv[2]).then((x) => process.stdout.write(JSON.stringify(hearSamples(x, SR))))
    .catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
