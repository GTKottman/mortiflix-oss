// Strudel events → notes (doc 28 §2.2, §2.4). The evaluator returns raw events (begin / end in cycles = bars, the
// value as plain data); this turns them into notes in ticks, by one rule for the MIDI screen, the song and the edits:
//   t    whole.begin × ticks per bar (rounded, with a warning, when off the 960 grid)
//   len  (whole.end − whole.begin) × ticks per bar × clip  (.legato(x) is stored as clip), at least 1 tick
//   key  the note: a name, a number (a decimal one carries fine pitch in cents), n() + .scale(), voiced chords, freq;
//        drums: drum, then note, then the sample name as General MIDI
//   vel  velocity, default 0.8, 3 decimals, 0–1 (gain is the mix level, never velocity)
import { noteToMidi, freqToMidi, drumNote } from '../../pipelines/_shared/skills/music/lib/score.mjs';

const SOUND = ['s', 'lpf', 'cutoff', 'hpf', 'room', 'size', 'gain', 'orbit', 'delay', 'pan', 'shape', 'crush', 'vowel', 'bank'];
const r3 = (v) => Math.round(v * 1000) / 1000;

function where(begin, beatsPerBar) {
  const bar = Math.floor(begin + 1e-9);
  return `bar ${bar + 1}, beat ${Math.round(((begin - bar) * beatsPerBar + 1) * 100) / 100}`;
}

// The pitch of an event's value, or null. Returns { key, fine } with fine in cents when the note is a decimal number.
export function pitchOf(v, { drums = false } = {}) {
  if (v === null || typeof v !== 'object') v = { note: v };
  let k = null;
  if (drums) k = v.drum ?? (v.note !== undefined ? noteToMidi(v.note) : drumNote(v.s));
  else if (v.note !== undefined) k = noteToMidi(v.note);
  else if (v.freq !== undefined) k = freqToMidi(v.freq);
  else if (typeof v.n === 'number' && v.s === undefined) k = v.n;
  if (k === null || k === undefined || !Number.isFinite(Number(k))) return null;
  const key = Math.round(Number(k));
  const fine = Math.round((Number(k) - key) * 100);
  return fine ? { key, fine } : { key };
}

// haps: [{ begin, end, value, block?, locations? }] → { notes: [{ t, len, key, vel, fine?, block, loc }], problems, hints }
export function notesFromHaps(haps, { ticksPerBar = 3840, beatsPerBar = 4, drums = false, bars = Infinity } = {}) {
  const notes = [];
  const problems = [];
  const hints = new Set();
  let offGrid = 0;
  for (const h of haps) {
    if (h.begin >= bars || h.begin < 0) continue;
    const v = h.value !== null && typeof h.value === 'object' ? h.value : { note: h.value };
    const p = pitchOf(v, { drums });
    if (!p) { problems.push(drums ? `a drum hit at ${where(h.begin, beatsPerBar)} has no General MIDI number (give it note(36) or .drum(36), or use a named drum sample)` : `a ${v.s || 'sound'} at ${where(h.begin, beatsPerBar)} has no pitch, so it isn't MIDI (use note() or n() with a scale)`); continue; }
    if (p.key < 0 || p.key > 127) { problems.push(`pitch ${p.key} at ${where(h.begin, beatsPerBar)} is outside MIDI's 0-127`); continue; }
    const exact = h.begin * ticksPerBar;
    const t = Math.round(exact);
    if (Math.abs(exact - t) > 1e-6) { if (!offGrid) problems.push(`off the 960 grid at ${where(h.begin, beatsPerBar)} (rounded to the nearest tick)`); offGrid++; }
    const clip = Number(v.clip ?? v.legato ?? 1) || 1;
    const len = Math.max(1, Math.round((h.end - h.begin) * ticksPerBar * clip));
    const vel = r3(Math.min(1, Math.max(0, Number(v.velocity ?? 0.8))));
    if (v.nudge !== undefined) hints.add('nudge moves the sound, not the note: the MIDI ignores it (use .late / .early to move notes)');
    if (SOUND.some((k) => v[k] !== undefined) && !drums) hints.add('sound settings (.s, .lpf, .room, .gain …) are kept in the text but are not part of the notes');
    notes.push({ t, len, key: p.key, vel, ...(p.fine ? { fine: p.fine } : {}), block: h.block ?? 0, loc: (h.locations || []).map((l) => (Array.isArray(l) ? l : [l.start, l.end])) });
  }
  if (offGrid > 1) problems.push(`${offGrid} notes in all are off the 960 grid`);
  if (!notes.length && !problems.length) problems.push('it makes no notes (a signal used as notes needs .segment(n))');
  notes.sort((a, b) => a.t - b.t || a.key - b.key || a.len - b.len);
  return { notes, problems, hints: [...hints] };
}
