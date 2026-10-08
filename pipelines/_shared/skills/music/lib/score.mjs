// A Strudel score read as music: its notes per channel, the checks a finished cue must pass, the intensity curve
// (how busy each bar is, against what the blueprint asked of each section) and the hit points against the picture.
//
// Score conventions (see SKILL.md): one cycle = one bar, every part a labelled block with .midichan(n) = its role's
// channel, drums on channel 10 with General MIDI note numbers (or a drum sample name: bd, sd, hh…). Velocity
// (.velocity) is the playing dynamic; gain is the mix level and never reaches the MIDI.

const CHROMA = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// Strudel's noteToMidi: octave defaults to 3, c4 = 60.
export function noteToMidi(note, defaultOctave = 3) {
  if (typeof note === 'number') return note;
  const m = String(note).trim().match(/^([a-gA-G])([#bsf]*)(-?\d+)?$/);
  if (!m) return null;
  const acc = [...m[2]].reduce((sum, ch) => sum + (ch === '#' || ch === 's' ? 1 : ch === 'b' || ch === 'f' ? -1 : 0), 0);
  const oct = m[3] === undefined ? defaultOctave : Number(m[3]);
  return (oct + 1) * 12 + CHROMA[m[1].toLowerCase()] + acc;
}
export const freqToMidi = (f) => Math.round(69 + 12 * Math.log2(f / 440));

export const GM_DRUMS = {
  bd: 36, kick: 36, sd: 38, snare: 38, rim: 37, rs: 37, cp: 39, clap: 39, hh: 42, ch: 42, hihat: 42, oh: 46, ho: 46,
  lt: 41, mt: 45, ht: 48, tom: 45, cr: 49, crash: 49, rd: 51, ride: 51, cb: 56, cowbell: 56, sh: 70, shaker: 70, tb: 54, perc: 67,
};
export function drumNote(sound) {
  const base = String(sound || '').toLowerCase().split(':')[0];
  return GM_DRUMS[base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base] ?? null;
}

// "4/4" → 4 quarter-note beats per bar; "6/8" → 3; "7/8" → 3.5.
export function beatsPerBar(meter = '4/4') {
  const m = String(meter).match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) throw new Error(`meter "${meter}" must look like 4/4`);
  const [n, d] = [Number(m[1]), Number(m[2])];
  if (n < 1 || n > 32 || ![1, 2, 4, 8, 16, 32].includes(d)) throw new Error(`meter "${meter}" isn't a usable time signature`);
  return (n * 4) / d;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// haps (times in cycles) → { bpm, tracks: [{ channel, name, kind, notes: [{ pitch, start, dur, velocity }] }] } in beats.
export function hapsToChannels({ haps, cps, beatsPerCycle = 4, names = {} }) {
  const tracks = new Map();
  const problems = [];
  for (const h of haps) {
    const v = h.value && typeof h.value === 'object' ? h.value : { note: h.value };
    const channel = v.midichan ?? null;
    const at = `at bar ${Math.floor(h.begin) + 1} beat ${+((h.begin % 1) * beatsPerCycle + 1).toFixed(2)}`;
    if (channel === null) { problems.push(`a ${v.s || 'note'} ${at} has no .midichan(n): every part needs its role's channel`); continue; }
    if (!Number.isInteger(channel) || channel < 1 || channel > 16) { problems.push(`channel ${channel} ${at} (must be 1-16)`); continue; }
    let pitch;
    if (channel === 10) pitch = v.drum ?? (v.note !== undefined ? noteToMidi(v.note) : drumNote(v.s));
    else pitch = v.note !== undefined ? noteToMidi(v.note) : v.freq !== undefined ? freqToMidi(v.freq) : null;
    if (pitch === null || !Number.isFinite(pitch)) {
      problems.push(channel === 10 ? `a drum hit ${at} has no General MIDI number (give it note(36) or .drum(36), or use a named drum sample)` : `a ${v.s || 'note'} on channel ${channel} ${at} has no pitch (use note() or n() with a scale)`);
      continue;
    }
    if (pitch < 0 || pitch > 127) { problems.push(`pitch ${pitch} on channel ${channel} ${at} (MIDI pitch must be 0-127)`); continue; }
    const dur = (h.end - h.begin) * beatsPerCycle * clamp(Number(v.legato ?? 1) || 1, 0.05, 8);
    if (!(dur > 0)) continue;
    if (!tracks.has(channel)) tracks.set(channel, { channel, name: names[channel] || `CH${String(channel).padStart(2, '0')}`, kind: channel === 10 ? 'drums' : 'pitched', notes: [], sounds: new Set() });
    if (v.s) tracks.get(channel).sounds.add(String(v.s));
    tracks.get(channel).notes.push({ pitch: Math.round(pitch), start: +(h.begin * beatsPerCycle).toFixed(6), dur: +dur.toFixed(6), velocity: +clamp(Number(v.velocity ?? 0.8), 0.05, 1).toFixed(3) });
  }
  const list = [...tracks.values()].sort((a, b) => a.channel - b.channel);
  for (const t of list) { t.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch); t.sounds = [...t.sounds]; }
  return { bpm: +(cps * 60 * beatsPerCycle).toFixed(3), tracks: list, problems };
}

// The blueprint's own shape. Returns errors (blocking) in plain words.
export function checkBlueprint(bp) {
  const errors = [];
  const need = (c, msg) => { if (!c) errors.push(`blueprint.json: ${msg}`); };
  need(bp && typeof bp === 'object', 'not a JSON object');
  if (errors.length) return errors;
  need(Number.isInteger(bp.bars) && bp.bars >= 2, '"bars" must be a whole number ≥ 2');
  need(bp.bpm >= 40 && bp.bpm <= 220, '"bpm" must be between 40 and 220');
  try { beatsPerBar(bp.meter || '4/4'); } catch (e) { errors.push(`blueprint.json: ${e.message}`); }
  need(Array.isArray(bp.sections) && bp.sections.length, '"sections": the story, each { name, start_bar, end_bar, function, intensity 0-10 }');
  let next = 1;
  for (const s of bp.sections || []) {
    need(s.start_bar === next, `section "${s.name}" starts at bar ${s.start_bar}; it should start at ${next} (sections are contiguous)`);
    need(Number.isFinite(s.intensity) && s.intensity >= 0 && s.intensity <= 10, `section "${s.name}" needs "intensity" 0-10 (how busy and loud it should feel)`);
    need(String(s.function || '').trim().length > 10, `section "${s.name}" needs a "function": what it does in the story`);
    next = (s.end_bar ?? 0) + 1;
  }
  if (bp.sections?.length) need(next - 1 === bp.bars, `the sections end at bar ${next - 1} but the cue has ${bp.bars} bars`);
  need(Array.isArray(bp.roles) && bp.roles.length, '"roles": each { channel, harmony, name, job }');
  for (const h of bp.hits || []) need(Number.isFinite(h.t_sec) && Number.isFinite(h.bar), `hit "${h.what}" needs "t_sec" (in the video) and "bar"/"beat" (in the music)`);
  return errors;
}

// Seconds into the video for a bar/beat of the cue (bars and beats count from 1).
export const timeOf = (bp, bar, beat = 1) => (bp.offset_sec || 0) + (((bar - 1) * beatsPerBar(bp.meter || '4/4')) + (beat - 1)) * 60 / bp.bpm;

// The cue's own checks: tempo, length, nothing after the ending, every role plays, hits land on the picture.
export function checkScore(channels, bp, { video_sec = null, fps = 30 } = {}) {
  const errors = [...channels.problems];
  const warnings = [];
  const bpb = beatsPerBar(bp.meter || '4/4');
  const endBeat = bp.bars * bpb;
  if (Math.abs(channels.bpm - bp.bpm) > 0.01) errors.push(`The score runs at ${channels.bpm} BPM but the blueprint says ${bp.bpm}: start the score with setcpm(${bp.bpm} / ${bpb}).`);
  for (const t of channels.tracks) {
    const late = t.notes.filter((n) => n.start >= endBeat - 1e-9);
    if (late.length) errors.push(`${t.name} keeps playing after the last bar (${late.length} note${late.length === 1 ? '' : 's'} from bar ${Math.floor(late[0].start / bpb) + 1}). Strudel loops: end every part with the cue (arrange, or a mask that ends).`);
  }
  for (const r of bp.roles || []) {
    if (!channels.tracks.some((t) => t.channel === r.channel)) errors.push(`Role "${r.name}" (channel ${r.channel}) never plays.`);
  }
  for (const t of channels.tracks) if (!(bp.roles || []).some((r) => r.channel === t.channel)) errors.push(`Channel ${t.channel} plays but has no role in the blueprint.`);
  const frame = 1 / fps;
  const hits = (bp.hits || []).map((h) => {
    const at = timeOf(bp, h.bar, h.beat ?? 1);
    const off = +(at - h.t_sec).toFixed(3);
    const ok = h.kind === 'none' || Math.abs(off) <= frame + 1e-6;
    if (!ok) errors.push(`Hit "${h.what}" at ${h.t_sec}s: bar ${h.bar} beat ${h.beat ?? 1} falls at ${at.toFixed(3)}s (${off > 0 ? '+' : ''}${off}s, more than a frame off). Change the tempo, the bar, or offset_sec.`);
    return { ...h, music_sec: +at.toFixed(3), off_sec: off, ok };
  });
  const seconds = +(endBeat * 60 / bp.bpm).toFixed(3);
  if (video_sec) {
    const cueEnd = (bp.offset_sec || 0) + seconds;
    if (cueEnd < video_sec - 60 / bp.bpm * bpb && !bp.ends_early) warnings.push(`The cue ends at ${cueEnd.toFixed(2)}s, more than a bar before the video (${video_sec}s). If that's the plan, set "ends_early": true.`);
    if (cueEnd > video_sec + 0.5) errors.push(`The cue runs to ${cueEnd.toFixed(2)}s, past the end of the video (${video_sec}s).`);
  }
  return { ok: errors.length === 0, errors, warnings, seconds, hits };
}

// How busy each bar is: notes per beat, parts playing, mean velocity, pitch span. Then each section's measured level
// against the intensity the blueprint asked for: rank order must agree (a section asked to be more intense than another
// must measure busier), so builds and breakdowns really happen where the picture needs them.
export function intensity(channels, bp) {
  const bpb = beatsPerBar(bp.meter || '4/4');
  const bars = [];
  for (let b = 0; b < bp.bars; b++) bars.push({ bar: b + 1, notes: 0, parts: new Set(), vel: 0, lo: 127, hi: 0 });
  for (const t of channels.tracks) {
    for (const n of t.notes) {
      const b = Math.floor(n.start / bpb + 1e-9);
      if (b < 0 || b >= bp.bars) continue;
      const x = bars[b];
      x.notes += 1; x.parts.add(t.channel); x.vel += n.velocity;
      if (t.kind !== 'drums') { x.lo = Math.min(x.lo, n.pitch); x.hi = Math.max(x.hi, n.pitch); }
    }
  }
  const perBar = bars.map((x) => {
    const density = x.notes / bpb;
    const level = density * 0.5 + x.parts.size * 1.2 + (x.notes ? x.vel / x.notes : 0) * 3 + (x.hi > x.lo ? (x.hi - x.lo) / 12 : 0) * 0.6;
    return { bar: x.bar, density: +density.toFixed(2), parts: x.parts.size, velocity: x.notes ? +(x.vel / x.notes).toFixed(2) : 0, level: +level.toFixed(2) };
  });
  const sections = (bp.sections || []).map((s) => {
    const span = perBar.slice(s.start_bar - 1, s.end_bar);
    const level = span.reduce((a, b) => a + b.level, 0) / Math.max(1, span.length);
    return { name: s.name, bars: [s.start_bar, s.end_bar], asked: s.intensity, measured: +level.toFixed(2) };
  });
  const problems = [];
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const a = sections[i]; const b = sections[j];
      if (Math.abs(a.asked - b.asked) < 2) continue;   // close asks: no order to keep
      const hiAsk = a.asked > b.asked ? a : b; const loAsk = hiAsk === a ? b : a;
      if (hiAsk.measured <= loAsk.measured) problems.push(`"${hiAsk.name}" was asked to be more intense (${hiAsk.asked}) than "${loAsk.name}" (${loAsk.asked}) but measures ${hiAsk.measured} vs ${loAsk.measured}: add parts, notes, velocity or range there, or thin the other.`);
    }
  }
  return { perBar, sections, problems };
}

// One line per section: a bar-by-bar sparkline of the measured level.
export function intensityChart(report) {
  const max = Math.max(1, ...report.perBar.map((b) => b.level));
  const ramp = ' ▁▂▃▄▅▆▇█';
  return report.sections.map((s) => {
    const spark = report.perBar.slice(s.bars[0] - 1, s.bars[1]).map((b) => ramp[Math.round((b.level / max) * 8)]).join('');
    return `${s.name.slice(0, 28).padEnd(28)} bars ${String(s.bars[0]).padStart(3)}-${String(s.bars[1]).padEnd(3)} asked ${String(s.asked).padStart(2)}  measured ${String(s.measured).padStart(5)}  ${spark}`;
  }).join('\n');
}
