// The roughness check: how harsh two parts sound together, heard from the instruments' own overtones. The harmony lock
// (harmony.mjs) judges notes against the chord chart by the rules; it can't hear that a major third low on a piano is
// mud while the same third two octaves up rings clear, or that a bell's out-of-tune partials beat against a pad's.
// This check can: every note is a stack of partials measured from the part's audition (its real sound through the
// engine, filters and all), and every pair of partials from two different parts adds the roughness a listener hears
// (Plomp-Levelt, in Sethares' form). A pair rougher than a major third at the classic low interval limit (B♭2-D3, plain
// harmonic tones) is reported, with its place and how to clear it.
//
// The model and the partial measuring are ported from Visual-Harmonics (js/core/harmony.js, js/core/analyze.js),
// MIT © 2026 Elias Berntsen, https://github.com/elias1328/Visual-Harmonics.
import { noteName } from './harmony.mjs';

const hzOf = (m) => 440 * 2 ** ((m - 69) / 12);
const MAXP = 16;

// Sethares / Plomp-Levelt roughness of two pure tones.
export function pairRough(f1, a1, f2, a2) {
  const s = 0.24 / (0.0207 * Math.min(f1, f2) + 18.96);
  const x = s * Math.abs(f2 - f1);
  return Math.min(a1, a2) * (Math.exp(-3.5 * x) - Math.exp(-5.75 * x));
}

// Plain harmonic tone: 6 partials, each 0.88 of the one below (the stand-in when a part has no audition).
export const HARMONIC = Array.from({ length: 6 }, (_, k) => [k + 1, 0.88 ** k]);

// Roughness of two notes (midi pitches) with their spectra ([[ratio, amp], ...]) and levels (0..1).
export function notesRough(m1, s1, v1, m2, s2, v2) {
  const f1 = hzOf(m1), f2 = hzOf(m2);
  let d = 0;
  for (const [r1, a1] of s1) for (const [r2, a2] of s2) d += pairRough(f1 * r1, a1 * v1, f2 * r2, a2 * v2);
  return d;
}

// The line a pair must stay under: a major third B♭2-D3 of plain harmonic tones at full level.
export const LIMIT = notesRough(46, HARMONIC, 1, 50, HARMONIC, 1);

// In-place radix-2 FFT. re/im: Float64Array of length 2^k.
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

// The partials of one played note (mono samples at `sr`, the note's pitch known): a frame after the attack, its peaks,
// the strongest within ±3 % of each harmonic slot, then strong peaks no slot claimed (bells, glass), the 16 strongest
// → [[ratio to the pitch, amp 0..1], ...] by ratio. Silence → null.
export function spectrumOf(x, sr, hz) {
  const pow2 = 2 ** Math.floor(Math.log2(Math.max(2, Math.min(32768, x.length))));
  if (x.length < 1024 || !(hz > 0)) return null;
  const start = Math.max(0, Math.min(x.length - pow2, Math.floor(x.length * 0.08)));
  const N = pow2, M = N * 2, re = new Float64Array(M), im = new Float64Array(M);
  for (let i = 0; i < N; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  fft(re, im);
  const mag = new Float64Array(M / 2);
  let max = 0;
  for (let i = 1; i < M / 2; i++) { mag[i] = Math.hypot(re[i], im[i]); if (mag[i] > max) max = mag[i]; }
  if (max < 1e-6) return null;
  const binHz = sr / M, pk = [];
  for (let i = 2; i < mag.length - 1; i++) {
    const b = mag[i];
    if (b < max * 0.003 || b < mag[i - 1] || b < mag[i + 1]) continue;
    const la = Math.log(mag[i - 1] + 1e-12), lb = Math.log(b + 1e-12), lc = Math.log(mag[i + 1] + 1e-12), den = la - 2 * lb + lc, off = den ? 0.5 * (la - lc) / den : 0;
    pk.push({ hz: (i + off) * binHz, a: Math.exp(lb - 0.25 * (la - lc) * off) });
  }
  // the played pitch, refined by a strong peak next to it (a filter or a detuned voice can move it a little)
  const near = pk.filter((p) => Math.abs(p.hz / hz - 1) < 0.03 && p.a > max * 0.05);
  const root = near.length ? near.reduce((a, b) => (b.a > a.a ? b : a)).hz : hz;
  const used = new Set(), parts = [];
  for (let k = 1; k <= 32 && k * root < sr / 2; k++) {
    let best = null;
    for (const p of pk) if (!used.has(p) && Math.abs(p.hz / (k * root) - 1) < 0.03 && (!best || p.a > best.a)) best = p;
    if (best && best.a > max * 0.01) { used.add(best); parts.push([best.hz / root, best.a]); }
  }
  for (const p of pk) if (!used.has(p) && p.a > max * 0.08 && p.hz / root >= 0.5) parts.push([p.hz / root, p.a]);
  if (!parts.length) return null;
  parts.sort((a, b) => b[1] - a[1]);
  const top = parts.slice(0, MAXP), amax = top[0][1];
  return top.map(([r, a]) => [Math.round(r * 10000) / 10000, Math.round(a / amax * 10000) / 10000]).sort((a, b) => a[0] - b[0]);
}

// spectra: { [channel]: [{ pitch, spectrum }] } measured at a few pitches; a note takes the nearest one's.
const spectrumFor = (list, pitch) => (list?.length ? list.reduce((a, b) => (Math.abs(b.pitch - pitch) < Math.abs(a.pitch - pitch) ? b : a)).spectrum : HARMONIC);

// Every moment a note starts: each pair of sounding notes from different pitched parts, rough over the LIMIT, is
// reported once per pair of parts and pitches. Semitone rubs are the harmony lock's to report, and unisons and octaves
// have nothing to spread (both skipped).
// manifest: the engine's notes.json shape. → { ok, rough: [{ a, b, at, x }], warnings: [line] }
export function checkRoughness(manifest, spectra = {}, { maxExamples = 6 } = {}) {
  const bpb = manifest.beats_per_bar || 4;
  const where = (t) => { const bar = Math.floor(t / bpb + 1e-9); return `bar ${bar + 1} beat ${+((t - bar * bpb) + 1).toFixed(2)}`; };
  const ev = [];
  for (const t of manifest.tracks) {
    if (t.channel === 10 || t.kind === 'drums') continue;
    for (const n of t.notes) ev.push({ ch: t.channel, part: t.name, pitch: n.pitch, start: n.start, end: n.start + n.dur, v: Math.min(1, (n.velocity ?? 100) / 127) });
  }
  ev.sort((a, b) => a.start - b.start);
  const rough = [], seen = new Set();
  const onsets = [...new Set(ev.map((e) => +e.start.toFixed(6)))];
  for (const t of onsets) {
    const sounding = ev.filter((e) => e.start <= t + 1e-6 && e.end > t + 1e-6);
    for (const a of sounding) {
      if (Math.abs(a.start - t) > 1e-6) continue;   // judge each pair when its newer note starts
      for (const b of sounding) {
        if (a === b || a.ch === b.ch) continue;
        const d = Math.abs(a.pitch - b.pitch) % 12;
        if (d === 0 || d === 1 || d === 11) continue;   // octaves can't be spread wider
        const [lo, hi] = a.pitch <= b.pitch ? [a, b] : [b, a];
        const key = `${lo.ch}:${lo.pitch}/${hi.ch}:${hi.pitch}`;
        if (seen.has(key)) continue;
        const x = notesRough(lo.pitch, spectrumFor(spectra[lo.ch], lo.pitch), lo.v, hi.pitch, spectrumFor(spectra[hi.ch], hi.pitch), hi.v) / LIMIT;
        if (x <= 1) continue;
        seen.add(key);
        rough.push({ a: `${lo.part} ${noteName(lo.pitch)}`, b: `${hi.part} ${noteName(hi.pitch)}`, at: where(t), x: Math.round(x * 100) / 100 });
      }
    }
  }
  rough.sort((p, q) => q.x - p.x);
  const warnings = rough.length ? [`Sounds rough in ${rough.length} place${rough.length === 1 ? '' : 's'} (two parts' overtones beat against each other; ×1 = a major third at B♭2-D3): ${rough.slice(0, maxExamples).map((r) => `${r.a} with ${r.b} at ${r.at} (×${r.x})`).join('; ')}${rough.length > maxExamples ? '; …' : ''}. Spread them wider, move the upper note up an octave, or thin the lower part there.`] : [];
  return { ok: !rough.length, rough, warnings };
}
