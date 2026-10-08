// Instruments: what each MIDI channel sounds like. The score (music/score.strudel.js) holds only the music: notes,
// velocities and structure, every part on its channel. Its MIDI is captured first (music/notes.json, out/music/midi/);
// then music/instruments.json chooses a sound for every channel, from that channel's real notes. The renderer adds
// the instruments as one layer on top of the score, so a sound can never change a note, and the same MIDI can be
// played by Strudel or taken to any DAW.
//
//   {
//     "concept": "the sound of the whole piece in two sentences",
//     "parts": [
//       { "channel": 1, "role": "Sub", "sound": "sine", "set": ".lpf(300).release(.3)", "gain": 0.7, "pan": 0,
//         "character": "dark", "why": "a pure low floor under everything" },
//       { "channel": 10, "role": "Drums", "gain": 0.8, "why": "...",
//         "kit": { "36": { "sound": "sine", "set": ".penv(24).decay(.2).sustain(0)" }, "38": { "sound": "pink", "set": ".decay(.12).sustain(0)", "gain": 0.6 } } }
//     ]
//   }
//
// "sound" is a Strudel sound; "set" is a chain of Strudel methods (filters, envelopes, FM, effects); "gain" is the part's
// mix level (velocity from the score still shapes every note); "pan" runs -1 (left) to 1 (right); "character" is
// dark | warm | neutral | bright | lofi. Drums (channel 10) map each General MIDI number the score uses to a sound.
import { noteName } from './harmony.mjs';
import { GM_DRUMS } from './score.mjs';

// Strudel's built-in synths (superdough): nothing to download, no licence questions.
export const SYNTHS = {
  sine: { family: 'sine', what: 'pure tone: sub bass, soft keys, bells with FM' },
  triangle: { family: 'triangle', what: 'soft and hollow: flutes, mellow leads, pads' },
  square: { family: 'square', what: 'hollow and woody: clarinet-like leads, chiptune, plucks when low-passed' },
  sawtooth: { family: 'saw', what: 'bright and full: strings, brass, bass, pads under a filter' },
  supersaw: { family: 'supersaw', what: 'wide detuned saws: big pads and chords' },
  pulse: { family: 'square', what: 'variable-width pulse: nasal leads, reedy keys' },
  white: { family: 'noise', what: 'white noise: hats, shakers, risers' },
  pink: { family: 'noise', what: 'pink noise: snares, claps, wind' },
  brown: { family: 'noise', what: 'brown noise: rumble, soft swells' },
  crackle: { family: 'noise', what: 'sparse crackle: vinyl, texture' },
};
export const CHARACTERS = ['dark', 'warm', 'neutral', 'bright', 'lofi'];
export const isDrums = (part) => Number(part.channel) === 10 || Boolean(part.kit);

// Methods a part's "set" may not use: the score owns the notes and the channel, the renderer owns the sound and the bus.
const PITCHED_FORBIDDEN = /\.(note|n|freq|midichan|s|sound|orbit|struct|fast|slow|mask|euclid\w*|degrade\w*|sometimes\w*|every|chunk|rev|ply|off|late|early)\s*\(/;
const KIT_FORBIDDEN = /\.(midichan|s|sound|orbit|struct|fast|slow|mask|euclid\w*|degrade\w*|sometimes\w*|every|chunk|rev|ply|off|late|early)\s*\(/;
const UNSAFE = /[;\n`]|=>|\bfunction\b|\bimport\b|\brequire\b|\bfetch\b|\beval\b|\bwindow\b|\bglobalThis\b/;

const familyOf = (sound, set = '') => {
  const base = SYNTHS[sound]?.family || `sample:${sound}`;
  return /\.fm\s*\(/.test(set) ? `fm-${base}` : base;
};

// Where each channel plays, from the captured MIDI: what the instrument has to cover.
export function registers(manifest) {
  return manifest.tracks.map((t) => {
    const ps = t.notes.map((n) => n.pitch).sort((a, b) => a - b);
    const q = (f) => ps[Math.min(ps.length - 1, Math.floor(f * ps.length))];
    const drums = t.channel === 10 || t.kind === 'drums';
    return { channel: t.channel, name: t.name, kind: drums ? 'drums' : 'pitched', notes: ps.length,
      lowest: ps[0] ?? null, middle: q(0.5) ?? null, highest: ps.at(-1) ?? null, q1: q(0.25) ?? null, q3: q(0.75) ?? null,
      drums: drums ? [...new Set(ps)] : null };
  });
}
export const registerLine = (r) => (r.kind === 'drums'
  ? `ch ${String(r.channel).padStart(2)} ${r.name}: drums, ${r.notes} hits, General MIDI ${r.drums.join(' ')}`
  : `ch ${String(r.channel).padStart(2)} ${r.name}: ${noteName(r.lowest)} to ${noteName(r.highest)}, centred on ${noteName(r.middle)} (${r.notes} notes)`);

// Which bars each channel plays in (for "too many bright parts at once").
function barsPlaying(manifest) {
  const bpb = manifest.beats_per_bar || 4; const out = new Map();
  for (const t of manifest.tracks) out.set(t.channel, new Set(t.notes.map((n) => Math.floor(n.start / bpb + 1e-9))));
  return out;
}

// The instruments file against the captured MIDI. errors block; warnings are things to look at.
// known: the set of sound names this Strudel can play (null = don't check names beyond the built-in synths and declared sources).
export function checkInstruments(inst, manifest, { known = null } = {}) {
  const errors = []; const warnings = [];
  const err = (m) => errors.push(`instruments.json: ${m}`);
  if (!inst || typeof inst !== 'object' || !Array.isArray(inst.parts)) return { errors: ['instruments.json: needs { "concept": "...", "parts": [ … one per channel … ] }'], warnings, registers: [] };
  if (!String(inst.concept || '').trim()) err('"concept": say the sound of the whole piece in a sentence or two');
  const regs = registers(manifest);
  const byCh = new Map();
  for (const [i, p] of inst.parts.entries()) {
    const at = `parts[${i}]${p?.role ? ` (${p.role})` : ''}`;
    if (!Number.isInteger(p?.channel) || p.channel < 1 || p.channel > 16) { err(`${at}: "channel" must be 1-16`); continue; }
    if (byCh.has(p.channel)) err(`${at}: channel ${p.channel} has two instruments`);
    byCh.set(p.channel, p);
    if (!String(p.why || '').trim()) err(`${at}: "why": what this sound does for the part`);
    if (p.gain !== undefined && !(p.gain >= 0 && p.gain <= 1.5)) err(`${at}: "gain" must be 0-1.5 (the part's level in the mix)`);
    if (p.pan !== undefined && !(p.pan >= -1 && p.pan <= 1)) err(`${at}: "pan" must be -1 (left) to 1 (right)`);
    if (p.character !== undefined && !CHARACTERS.includes(p.character)) err(`${at}: "character" must be one of ${CHARACTERS.join(', ')}`);
    const sounds = isDrums(p) ? Object.entries(p.kit || {}).map(([k, v]) => [`kit ${k}`, v]) : [['sound', p]];
    if (isDrums(p) && !Object.keys(p.kit || {}).length) err(`${at}: drums need a "kit": General MIDI number → { "sound", "set" }`);
    for (const [where, v] of sounds) {
      if (!String(v?.sound || '').trim()) { err(`${at} ${where}: needs "sound"`); continue; }
      if (!/^[\w:.-]{1,60}$/.test(v.sound)) err(`${at} ${where}: "${v.sound}" isn't a sound name`);
      else if (!SYNTHS[v.sound] && !v.source && !(known && known.has(v.sound))) err(`${at} ${where}: "${v.sound}" isn't a built-in synth (${Object.keys(SYNTHS).join(', ')}). A sample or soundfont needs "source": where it comes from and its licence (also in assets/SOURCES.md).`);
      const set = String(v.set || '');
      if (set && !set.startsWith('.')) err(`${at} ${where}: "set" is a chain of Strudel methods starting with "." (e.g. ".lpf(800).room(.3)")`);
      if (UNSAFE.test(set)) err(`${at} ${where}: "set" is a method chain only: no ; => newlines or code`);
      else if ((isDrums(p) ? KIT_FORBIDDEN : PITCHED_FORBIDDEN).test(set)) err(`${at} ${where}: "set" can't change the notes, timing, channel or sound name (${set.match(isDrums(p) ? KIT_FORBIDDEN : PITCHED_FORBIDDEN)[0]}…): the score owns those`);
      if (v.gain !== undefined && v !== p && !(v.gain >= 0 && v.gain <= 1.5)) err(`${at} ${where}: "gain" must be 0-1.5`);
    }
    if (isDrums(p) && p.channel !== 10) err(`${at}: a "kit" belongs on channel 10 (drums)`);
  }
  for (const r of regs) {
    const p = byCh.get(r.channel);
    if (!p) { err(`channel ${r.channel} (${r.name}) plays ${r.notes} notes but has no instrument`); continue; }
    if (r.kind === 'drums') for (const n of r.drums) if (!p.kit?.[String(n)]) err(`drums: the score plays General MIDI ${n} but the kit has no sound for it`);
  }
  for (const ch of byCh.keys()) if (!regs.some((r) => r.channel === ch)) err(`channel ${ch} has an instrument but the score never plays it`);

  // A palette that sounds good together (Mini Music's rules): parts sharing a register need different timbres, at most one
  // deliberately degraded sound, the low end and the top both covered, not three bright parts at once.
  const pitched = regs.filter((r) => r.kind === 'pitched' && byCh.has(r.channel));
  for (let i = 0; i < pitched.length; i++) for (let j = i + 1; j < pitched.length; j++) {
    const a = pitched[i]; const b = pitched[j]; const pa = byCh.get(a.channel); const pb = byCh.get(b.channel);
    const overlap = Math.min(a.q3, b.q3) - Math.max(a.q1, b.q1);
    if (overlap >= 0 && familyOf(pa.sound, pa.set) === familyOf(pb.sound, pb.set)) {
      errors.push(`instruments.json: ${a.name} and ${b.name} play in the same register (${noteName(Math.max(a.q1, b.q1))}-${noteName(Math.min(a.q3, b.q3))}) with the same kind of sound (${familyOf(pa.sound, pa.set)}): give one a clearly different timbre, or move it an octave in the score`);
    }
  }
  const lofi = inst.parts.filter((p) => p.character === 'lofi');
  if (lofi.length > 1) err(`${lofi.length} parts are "lofi" (${lofi.map((p) => p.role || p.channel).join(', ')}): keep at most one deliberately degraded sound`);
  if (pitched.length && !regs.some((r) => (r.kind === 'drums') || (r.middle !== null && r.middle < 48))) warnings.push('nothing covers the low end (no part centred below C3 and no drums): add a bass or a low pad, or say why not in "concept"');
  if (pitched.length > 1 && !pitched.some((r) => r.middle >= 67)) warnings.push('nothing sits on top (no part centred above G4): the piece may sound dark or closed; fine if intended');
  const bright = inst.parts.filter((p) => p.character === 'bright').map((p) => p.channel);
  if (bright.length >= 3) {
    const plays = barsPlaying(manifest); const nBars = Math.max(0, ...[...plays.values()].flatMap((s) => [...s])) + 1;
    for (let bar = 0; bar < nBars; bar++) {
      const at = bright.filter((ch) => plays.get(ch)?.has(bar));
      if (at.length >= 3) { warnings.push(`three or more bright parts play together from bar ${bar + 1} (channels ${at.join(', ')}): the top end will be harsh; darken one`); break; }
    }
  }
  for (const t of manifest.tracks) if (t.sounds?.length) warnings.push(`the score itself sets a sound on channel ${t.channel} (${t.sounds.join(', ')}): instruments.json replaces it; keep the score to notes`);
  return { errors, warnings, registers: regs };
}

const num = (v, d) => (Number.isFinite(Number(v)) ? +Number(v).toFixed(4) : d);
const strudelPan = (pan) => num(((Number(pan) || 0) + 1) / 2, 0.5);

// The Strudel layer that plays the instruments (Strudel reads every "double-quoted" string as mini-notation, so the
// generated code quotes plain strings with single quotes): appended after the score, it splits the score by channel, gives each
// channel its sound, level, pan and its own effects bus (orbit = channel), and stacks them again.
export function instrumentCode(inst) {
  const parts = inst.parts.map((p) => {
    const tail = (v, gain) => `.s(${JSON.stringify(v.sound)})${v.set || ''}.gain(${num(gain, 0.8)}).pan(${strudelPan(p.pan)})`;
    if (isDrums(p)) {
      const kit = Object.entries(p.kit).map(([gm, v]) => `p.filterValues((v) => drumOf(v) === ${Number(gm)})${tail(v, num(p.gain, 0.8) * num(v.gain, 1))}`);
      return `  ${p.channel}: (p) => stack(\n    ${kit.join(',\n    ')}),`;
    }
    return `  ${p.channel}: (p) => p${tail(p, p.gain ?? 0.8)},`;
  });
  return [
    '',
    '// ── instruments: music/instruments.json, added by the music engine (strudel.mjs). The score above holds the notes. ──',
    `const drumOf = (v) => { const gm = ${JSON.stringify(GM_DRUMS).replace(/"/g, "'")}; const s = String(v.s ?? '').toLowerCase().split(':')[0]; return Number(v.drum ?? v.note ?? gm[s.includes('_') ? s.slice(s.lastIndexOf('_') + 1) : s]) }`,
    'const __instruments = {',
    ...parts,
    '}',
    'all((p) => stack(...Object.entries(__instruments).map(([ch, play]) => play(p.filterValues((v) => v && v.midichan === Number(ch))).orbit(Number(ch)))))',
    '',
  ].join('\n');
}

// One short piece per channel for the audition: its instrument plays the part's lowest, middle and highest note (drums:
// every kit piece the score uses), one per bar at 120 BPM, so a silent or broken sound is caught in seconds.
export function auditionCode(inst, regs) {
  const lines = ['setcpm(120 / 4)'];
  for (const r of regs) {
    const p = inst.parts.find((x) => x.channel === r.channel); if (!p) continue;
    const ns = r.kind === 'drums' ? r.drums : [...new Set([r.lowest, r.middle, r.highest])];
    lines.push(`ch${r.channel}: note("<${ns.join(' ')}>").velocity(.9).midichan(${r.channel})`);
  }
  return `${lines.join('\n')}\n${instrumentCode(inst)}`;
}
export const auditionNotes = (r) => (r.kind === 'drums' ? r.drums : [...new Set([r.lowest, r.middle, r.highest])]);
