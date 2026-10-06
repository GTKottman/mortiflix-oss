// The harmony lock: every pitched note is judged against the blueprint's chord chart, by the harmony role of its channel.
//
// blueprint.json:
//   "scale": "F:major"                                   tonic:mode (major minor dorian phrygian lydian mixolydian …)
//   "chart": [ { "bars": [1, 8], "chords": ["Fmaj7"] },  one chord per bar, cycling through the list inside the range;
//              { "bars": [9, 40], "chords": ["Fmaj7", "Bbmaj7", "Am7", ["Gm7", "C7sus4"]] } ]   a bar split in halves
//   "roles": [ { "channel": 1, "harmony": "bass", … } ]  bass | chords | melody | pedal | noise | drums
//
// Rules (per role; times in beats = quarter notes):
//   bass    on every chord change the root (or the slash bass); elsewhere chord tones, or a passing/approach note of a
//           beat or less that moves by step (≤ 2 semitones) into the next note, never on the bar's downbeat.
//   chords  chord tones of the symbol only (spell extensions in the chart: Fmaj9 if the pad plays the 9th).
//   melody  chord tones or available tensions (9, 11 on minor/sus, 13/6); anything else must be short (≤ ½ beat),
//           off the beat (or a ¼-beat grace) and resolve by step: a passing, neighbour or approach note.
//   pedal   in key (a held tonic or dominant under anything).
//   noise / drums  not judged.
// Also: a chords/bass note held across a chord change must fit the new chord (¼ beat of release overlap is fine), and
// two parts sounding a semitone apart (or a minor 9th) clash unless both are chord tones spread wider than a semitone.

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteName = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const parseRoot = (s) => {
  const m = String(s).match(/^([A-G])([#b♯♭]?)/);
  if (!m) return null;
  return { pc: (PC[m[1]] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0) + 12) % 12, len: m[0].length };
};
export const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11], ionian: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], locrian: [0, 1, 3, 5, 6, 8, 10], 'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic minor': [0, 2, 3, 5, 7, 9, 11], blues: [0, 3, 5, 6, 7, 10], 'major pentatonic': [0, 2, 4, 7, 9], 'minor pentatonic': [0, 3, 5, 7, 10],
};
// quality → intervals above the root
const Q = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7], 5: [0, 7], dim: [0, 3, 6], '°': [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9], '6/9': [0, 4, 7, 9, 2], 69: [0, 4, 7, 9, 2], 'm6/9': [0, 3, 7, 9, 2], m69: [0, 3, 7, 9, 2],
  7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], '^7': [0, 4, 7, 11], 'Δ7': [0, 4, 7, 11], m7: [0, 3, 7, 10], '-7': [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10], 'ø': [0, 3, 6, 10], 'ø7': [0, 3, 6, 10], 'm7(b5)': [0, 3, 6, 10], dim7: [0, 3, 6, 9], '°7': [0, 3, 6, 9],
  mmaj7: [0, 3, 7, 11], mMaj7: [0, 3, 7, 11], 'm(maj7)': [0, 3, 7, 11],
  9: [0, 4, 7, 10, 2], maj9: [0, 4, 7, 11, 2], M9: [0, 4, 7, 11, 2], m9: [0, 3, 7, 10, 2], add9: [0, 4, 7, 2], add2: [0, 4, 7, 2], madd9: [0, 3, 7, 2], 'm(add9)': [0, 3, 7, 2],
  11: [0, 7, 10, 2, 5], m11: [0, 3, 7, 10, 2, 5], 13: [0, 4, 7, 10, 2, 9], m13: [0, 3, 7, 10, 2, 9], maj13: [0, 4, 7, 11, 2, 9],
  '7b9': [0, 4, 7, 10, 1], '7#9': [0, 4, 7, 10, 3], '7#11': [0, 4, 7, 10, 6], '9#11': [0, 4, 7, 10, 2, 6], '7b13': [0, 4, 7, 10, 8], '7#5': [0, 4, 8, 10],
  '7sus4': [0, 5, 7, 10], '7sus': [0, 5, 7, 10], sus4: [0, 5, 7], sus: [0, 5, 7], sus2: [0, 2, 7], '9sus4': [0, 5, 7, 10, 2], '9sus': [0, 5, 7, 10, 2],
  '13sus4': [0, 5, 7, 10, 2, 9], '13sus': [0, 5, 7, 10, 2, 9],
  'maj7#11': [0, 4, 7, 11, 6], 'maj9#11': [0, 4, 7, 11, 2, 6], 'maj7#5': [0, 4, 8, 11], 'm(add6)': [0, 3, 7, 9], madd6: [0, 3, 7, 9], 'm7add11': [0, 3, 7, 10, 5],
  m7add9: [0, 3, 7, 10, 2], '7add13': [0, 4, 7, 10, 9],
};
export const CHORD_QUALITIES = Object.keys(Q);
const chordCache = new Map();
export function parseChord(sym) {
  if (chordCache.has(sym)) return chordCache.get(sym);
  const s = String(sym).trim();
  const slashAt = s.lastIndexOf('/');
  const slashed = slashAt > 0 && /^[A-G][#b♯♭]?$/.test(s.slice(slashAt + 1));
  const main = slashed ? s.slice(0, slashAt) : s;
  const r = parseRoot(main);
  if (!r) throw new Error(`"${sym}" isn't a chord symbol (root A–G, then a quality)`);
  const qual = main.slice(r.len);
  if (!(qual in Q)) throw new Error(`unknown chord quality "${qual}" in "${sym}" (known: ${CHORD_QUALITIES.filter(Boolean).join(' ')})`);
  const iv = Q[qual];
  const tones = new Set(iv.map((i) => (r.pc + i) % 12));
  const bass = slashed ? parseRoot(s.slice(slashAt + 1)).pc : r.pc;
  tones.add(bass);
  const minor = iv.includes(3) && !iv.includes(4);
  const sus = iv.includes(5) && !iv.includes(3) && !iv.includes(4);
  const hasFlat9 = iv.includes(1) || (iv.includes(3) && iv.includes(4));
  const dom = iv.includes(4) && iv.includes(10);
  const dim = iv.includes(6) && iv.includes(3);
  const tens = new Set();
  if (!hasFlat9 && !dim) tens.add((r.pc + 2) % 12);
  if (minor || sus) tens.add((r.pc + 5) % 12);
  if (!minor || iv.includes(9)) tens.add((r.pc + 9) % 12);
  if (dom && !iv.includes(9)) tens.add((r.pc + 9) % 12);
  const c = { sym: s, root: r.pc, bass, tones, tens };
  chordCache.set(sym, c);
  return c;
}

export function parseScale(scale) {
  const m = String(scale ?? '').match(/^\s*([A-G][#b♯♭]?)\s*[: ]\s*([a-z ]+?)\s*$/i);
  if (!m) throw new Error(`"scale" must look like "F:major" or "G:dorian" (got ${JSON.stringify(scale)})`);
  const mode = MODES[m[2].toLowerCase()];
  if (!mode) throw new Error(`unknown mode "${m[2]}" (known: ${Object.keys(MODES).join(', ')})`);
  const tonic = parseRoot(m[1]).pc;
  return new Set(mode.map((i) => (tonic + i) % 12));
}

// chart → [{begin, end, chord, bar}] in beats, covering bars 1..bars. Errors for gaps, overlaps, bad symbols.
export function chartTimeline(chart, { bars, beatsPerBar }) {
  const errors = []; const timeline = [];
  if (!Array.isArray(chart) || !chart.length) return { errors: ['"chart" is missing: one chord per bar, e.g. [{"bars": [1, 8], "chords": ["Fmaj7", "Bbmaj7"]}].'], timeline };
  const covered = new Array(bars + 1).fill(false);
  for (const [i, row] of chart.entries()) {
    const [a, b] = Array.isArray(row?.bars) ? row.bars : [];
    if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a && b <= bars)) { errors.push(`chart row ${i + 1}: "bars" must be [first, last] inside 1–${bars}.`); continue; }
    if (!Array.isArray(row.chords) || !row.chords.length) { errors.push(`chart row ${i + 1} (bars ${a}–${b}): no chords.`); continue; }
    for (let bar = a; bar <= b; bar += 1) {
      if (covered[bar]) { errors.push(`chart: bar ${bar} has two chords rows.`); continue; }
      covered[bar] = true;
      const cell = row.chords[(bar - a) % row.chords.length];
      const parts = Array.isArray(cell) ? cell : [cell];
      for (const [k, sym] of parts.entries()) {
        let chord;
        try { chord = parseChord(sym); } catch (e) { errors.push(`chart bar ${bar}: ${e.message}`); continue; }
        const begin = (bar - 1) * beatsPerBar + (k * beatsPerBar) / parts.length;
        timeline.push({ begin, end: begin + beatsPerBar / parts.length, chord, bar });
      }
    }
  }
  const missing = []; for (let bar = 1; bar <= bars; bar += 1) if (!covered[bar]) missing.push(bar);
  if (missing.length) errors.push(`chart: no chord for bar${missing.length > 1 ? 's' : ''} ${compactBars(missing)}.`);
  timeline.sort((x, y) => x.begin - y.begin);
  return { errors, timeline };
}
const compactBars = (list) => {
  const out = []; let s = list[0]; let p = list[0];
  for (const n of [...list.slice(1), null]) { if (n === p + 1) { p = n; continue; } out.push(s === p ? `${s}` : `${s}–${p}`); s = n; p = n; }
  return out.join(', ');
};

// manifest: { tracks: [{channel, name, kind, notes: [{pitch, start, dur, velocity}]}], beats_per_bar, bars }
// blueprint: { scale, chart, roles: [{channel, harmony}] }
export function checkHarmony(manifest, blueprint, { maxExamples = 6 } = {}) {
  const bpb = manifest.beats_per_bar; const bars = manifest.bars;
  const errors = []; const problems = {};
  const add = (type, msg) => { (problems[type] ||= []).push(msg); };
  let keyPcs;
  try { keyPcs = parseScale(blueprint.scale); } catch (e) { errors.push(`blueprint.json: ${e.message}`); }
  const { errors: chartErrors, timeline } = chartTimeline(blueprint.chart, { bars, beatsPerBar: bpb });
  errors.push(...chartErrors.map((e) => `blueprint.json ${e}`));
  const roleOf = new Map();
  const ROLES = ['bass', 'chords', 'melody', 'pedal', 'noise', 'drums'];
  for (const r of blueprint.roles ?? []) if (r && Number.isInteger(r.channel)) roleOf.set(r.channel, r.harmony);
  for (const t of manifest.tracks) {
    if (t.channel === 10 || t.kind === 'drums') continue;
    const role = roleOf.get(t.channel);
    if (!ROLES.includes(role)) errors.push(`blueprint.json: channel ${t.channel} (${t.name}) needs "harmony": one of ${ROLES.join(', ')} in its roles entry.`);
  }
  if (errors.length || !keyPcs) return { ok: false, errors, problems: {}, counts: {} };

  const chordAt = (t) => { let lo = 0; let hi = timeline.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; const c = timeline[m]; if (t < c.begin - 1e-9) hi = m - 1; else if (t >= c.end - 1e-9) lo = m + 1; else return c; } return null; };
  const where = (t) => { const bar = Math.floor(t / bpb + 1e-9); return `bar ${bar + 1} beat ${+((t - bar * bpb) + 1).toFixed(2)}`; };
  const ev = [];
  for (const t of manifest.tracks) {
    const role = t.channel === 10 || t.kind === 'drums' ? 'drums' : roleOf.get(t.channel);
    if (role === 'drums' || role === 'noise') continue;
    const list = [...t.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch).map((n) => ({ ...n, end: n.start + n.dur, ch: t.channel, part: t.name, role }));
    ev.push(...list);
    list.forEach((e, i) => {
      const c = chordAt(e.start);
      if (!c) return;
      const pc = ((e.pitch % 12) + 12) % 12;
      const at = `${e.part} ${noteName(e.pitch)} at ${where(e.start)} over ${c.chord.sym}`;
      const ct = c.chord.tones.has(pc);
      const onBeat = Math.abs(e.start - Math.round(e.start)) < 1e-6;
      const downbeat = Math.abs(e.start / bpb - Math.round(e.start / bpb)) < 1e-6;
      const short = e.dur <= 0.5 + 1e-9;
      const grace = e.dur <= 0.25 + 1e-9;
      const next = list.slice(i + 1).find((x) => x.start > e.start + 1e-9);
      const resolves = Boolean(next) && Math.abs(next.pitch - e.pitch) <= 2 && next.pitch !== e.pitch && next.start - e.end < 1 + 1e-9;
      const passing = short && resolves && (!onBeat || grace);
      if (role === 'pedal') { if (!keyPcs.has(pc) && !ct) add('pedal out of key', at); return; }
      if (!ct && !keyPcs.has(pc) && !(role === 'melody' && passing) && !(role === 'bass' && resolves && e.dur <= 1 + 1e-9 && !downbeat && Math.abs(e.start - c.begin) > 1e-6)) {
        add('out of key and not in the chord', at); return;
      }
      if (role === 'chords' && !ct) add('chords part plays a note that is not in the chord', at);
      if (role === 'bass') {
        if (Math.abs(e.start - c.begin) < 1e-6 && pc !== c.chord.bass && pc !== c.chord.root) add('bass misses the root on a chord change', at);
        else if (!ct && !(resolves && e.dur <= 1 + 1e-9 && !downbeat)) add('bass non-chord tone that does not pass by step', at);
      }
      if (role === 'melody' && !ct && !c.chord.tens.has(pc) && !passing) add('melody non-chord tone that is not a short passing/neighbour note', at);
      if (role === 'chords' || role === 'bass') {
        for (const c2 of timeline) {
          if (c2.begin <= e.start + 1e-6) continue;
          if (c2.begin >= e.end - 0.25 - 1e-6) break;
          if (!c2.chord.tones.has(pc)) { add('note held into a chord it does not fit', `${e.part} ${noteName(e.pitch)} held from ${where(e.start)} into ${c2.chord.sym} at ${where(c2.begin)}`); break; }
        }
      }
    });
  }
  // vertical: semitone clashes between different parts
  const onsets = [...new Set(ev.map((e) => +e.start.toFixed(6)))].sort((a, b) => a - b);
  const seen = new Set();
  for (const t of onsets) {
    const c = chordAt(t);
    if (!c) continue;
    const sounding = ev.filter((e) => e.start <= t + 1e-6 && e.end > t + 1e-6);
    const fresh = sounding.filter((e) => Math.abs(e.start - t) < 1e-6);
    for (const a of fresh) {
      for (const b of sounding) {
        if (a === b || a.ch === b.ch) continue;
        const d = Math.abs(a.pitch - b.pitch);
        if ((a.role === 'pedal' || b.role === 'pedal') && d > 12) continue;
        if (d % 12 !== 1 && d % 12 !== 11) continue;
        if (d % 12 === 11 && d > 11) continue;
        const aCT = c.chord.tones.has(a.pitch % 12); const bCT = c.chord.tones.has(b.pitch % 12);
        const passingNote = (x, xCT) => x.role === 'melody' && !xCT && x.dur <= 0.5 + 1e-9;
        if (aCT && bCT && d > 1) continue;
        if (passingNote(a, aCT) || passingNote(b, bCT)) continue;
        const key = `${[a.ch, b.ch].sort().join('/')} ${t.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(aCT && bCT ? 'two parts rub a semitone apart' : 'two parts clash a semitone apart', `${a.part} ${noteName(a.pitch)} vs ${b.part} ${noteName(b.pitch)} at ${where(t)} over ${c.chord.sym}`);
      }
    }
  }
  const counts = Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v.length]));
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const lines = Object.entries(problems).map(([k, v]) => `${k} (${v.length}): ${v.slice(0, maxExamples).join('; ')}${v.length > maxExamples ? '; …' : ''}`);
  return { ok: total === 0, errors: total ? [`Harmony: ${total} problem${total === 1 ? '' : 's'} against the chord chart (every part must fit the chord of the moment; fix the notes, not the chart, unless the chart is wrong).`, ...lines] : [], problems, counts };
}
