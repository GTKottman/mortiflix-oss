// A video's music written as a song (owner, 2026-10-23: "harmony and the melody, all of the stuff that makes a good song
// good should be used"). Used when the scoring pack is a researched genre (packs/scoring/<genre>/profile.json).
//
// The plan call writes the music the way the owner's music-prompt-2 describes it: banks and scenes. Banks are each
// part's pattern variants (a drum grid, a bass riff in chord tones, a comping rhythm and voicing, melody phrases in
// scale degrees); scenes are the sections, each a chord loop and the variant every part plays. The song carries the
// genre's signature elements (its hook and its beat). Code flattens the scenes onto one timeline, fits every pitch to
// the chord of its moment (the harmony lock), swings what the genre swings, and turns the picture's big moments into
// arrangement moves (a drop, a fill) instead of extra notes. The AI decides the music; code writes the notes.
import { parseChord, parseScale, chartTimeline, MODES, checkHarmony } from '../../pipelines/_shared/skills/music/lib/harmony.mjs';
import { intensity } from '../../pipelines/_shared/skills/music/lib/score.mjs';
import { ROLES, PARTS, manifestOf } from './compose.mjs';
import { signatureProblems } from './genre.mjs';

const r3 = (x) => Math.round(x * 1000) / 1000;
const bpbOf = (meter) => Number(String(meter).split('/')[0]);
const MOVES = ['drop', 'fill', 'none'];
const TONES = ['R', '3', '5', '7', '9', '6', '8'];
// drum rows by name → General MIDI
export const DRUM_GM = { kick: 36, rim: 37, sidestick: 37, snare: 38, ghost: 38, clap: 39, hat: 42, 'closed hat': 42, 'closed-hat': 42, chh: 42, 'open hat': 46, 'open-hat': 46, ohh: 46, ride: 51, crash: 49, tom: 45, 'low tom': 41, 'high tom': 48, shaker: 70, tambourine: 54, perc: 37 };
const gmOf = (row) => DRUM_GM[String(row).toLowerCase().trim()] ?? DRUM_GM[String(row).toLowerCase().replace(/s$/, '').trim()];
const VEL = { X: 0.9, x: 0.7, g: 0.35 };

const noteList = (extra) => ({ type: 'array', items: { type: 'object', required: ['t', 'd', ...Object.keys(extra)], properties: { t: { type: 'number', description: 'start, in beats from the start of the pattern' }, d: { type: 'number', description: 'length in beats' }, v: { type: 'number', description: 'velocity 0.1-1' }, ...extra } } });
export const SONG_SCHEMA = {
  type: 'object',
  required: ['title', 'dramatic_reading', 'must_not', 'concept', 'scale', 'swing', 'genre_signature', 'motif', 'banks', 'sections', 'moments', 'ending', 'note'],
  properties: {
    title: { type: 'string' },
    dramatic_reading: { type: 'string', description: 'the transformation in one line: "confusion -> recognition -> confidence"' },
    must_not: { type: 'string' },
    concept: { type: 'string', description: 'the three essential musical traits and how the topic becomes audible musical behaviour' },
    scale: { type: 'string', description: 'tonic:mode, e.g. "A:dorian"' },
    swing: { type: 'object', required: ['amount', 'on'], properties: { amount: { type: 'number', description: '0.5 straight … 0.66 hard swing (the genre feel)' }, on: { type: 'string', enum: ['8th', '16th'] } } },
    genre_signature: { type: 'array', items: { type: 'object', required: ['id', 'carries', 'how', 'where'], properties: { id: { type: 'string', description: 'an "unforgettable" element id from the genre profile' }, carries: { type: 'string', enum: ['hook', 'beat', 'bass', 'harmony', 'texture', 'arrangement'] }, how: { type: 'string' }, where: { type: 'string', description: 'which sections' } } } },
    motif: { type: 'object', required: ['degrees', 'beats', 'contour', 'why'], properties: { degrees: { type: 'array', items: { type: 'integer' } }, beats: { type: 'array', items: { type: 'number' } }, contour: { type: 'string' }, why: { type: 'string' } } },
    banks: {
      type: 'object', required: ['drums', 'bass', 'pad', 'melody'],
      properties: {
        drums: { type: 'array', items: { type: 'object', required: ['name', 'steps', 'parts'], properties: { name: { type: 'string' }, steps: { type: 'integer', enum: [8, 16, 32], description: '16 = one bar of 16ths in 4/4, 32 = two bars' }, parts: { type: 'object', additionalProperties: { type: 'string' }, description: 'row name (kick, snare, rim, clap, hat, open hat, ride, crash, tom, shaker) → "x...X...g..." (x hit, X accent, g ghost, . rest)' } } } },
        bass: { type: 'array', items: { type: 'object', required: ['name', 'bars', 'notes'], properties: { name: { type: 'string' }, bars: { type: 'integer', enum: [1, 2, 4] }, notes: noteList({ tone: { type: 'string', enum: TONES, description: 'chord tone of the chord sounding at that moment: R root, 3, 5, 7, 9, 6, 8 (octave)' } }) } } },
        pad: { type: 'array', items: { type: 'object', required: ['name', 'bars', 'hits', 'voicing'], properties: { name: { type: 'string' }, bars: { type: 'integer', enum: [1, 2, 4] }, hits: noteList({}), voicing: { type: 'array', items: { type: 'string', enum: TONES }, description: 'which chord tones sound, e.g. ["3", "7", "9"] for a rootless shell, ["R", "3", "5", "7"] full' } } } },
        melody: { type: 'array', items: { type: 'object', required: ['name', 'bars', 'notes'], properties: { name: { type: 'string' }, bars: { type: 'integer', enum: [1, 2, 4, 8] }, notes: noteList({ deg: { type: 'integer', description: 'scale degree from the tonic: 0 tonic, 7 an octave up (7-note modes), negatives below' } }) } } },
        arp: { type: 'array', items: { type: 'object', required: ['name', 'bars', 'notes'], properties: { name: { type: 'string' }, bars: { type: 'integer', enum: [1, 2, 4] }, notes: noteList({ tone: { type: 'string', enum: TONES } }) } } },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object', required: ['name', 'function', 'bars', 'chords', 'play', 'why'],
        properties: {
          name: { type: 'string', description: 'story-bearing, never Intro/Verse/A/B' },
          function: { type: 'string', description: 'establish, develop, destabilise, withhold, release, reinterpret, resolve' },
          bars: { type: 'integer', description: 'how many bars; all sections add up to the video\'s bars' },
          chords: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, description: 'the chord loop, one chord per bar, cycling through the section; ["Am7", "D7"] splits a bar' },
          play: { type: 'object', description: 'part → the bank variant it plays here, or "rest". Parts: drums, bass, pad, melody, arp', additionalProperties: { type: 'string' } },
          why: { type: 'string' },
        },
      },
    },
    moments: { type: 'array', items: { type: 'object', required: ['cut', 'move', 'why'], properties: { cut: { type: 'integer' }, move: { type: 'string', enum: MOVES, description: 'drop: drums and bass stop for the two beats before the cut, so it lands in space; fill: a drum fill into it; none: the music carries on' }, why: { type: 'string' } } } },
    ending: { type: 'string' },
    note: { type: 'string', description: 'for the owner, short: the idea, the hook, the beat, what to listen for' },
  },
};

const banksOf = (plan) => ({ drums: plan.banks?.drums || [], bass: plan.banks?.bass || [], pad: plan.banks?.pad || [], melody: plan.banks?.melody || [], arp: plan.banks?.arp || [] });
const findVariant = (plan, part, name) => banksOf(plan)[part]?.find((v) => v.name === name) || null;

// Problems the code can't fix itself (each goes back to a fresh fix call with only the errors).
export function songProblems(plan, { bars, profile, meter = '4/4' }) {
  const p = [];
  const bpb = bpbOf(meter);
  try { parseScale(plan.scale); } catch (e) { p.push(`scale: ${e.message}`); }
  p.push(...signatureProblems(plan.genre_signature, profile));
  const sum = (plan.sections || []).reduce((a, s) => a + (Number(s.bars) || 0), 0);
  if (sum !== bars) p.push(`sections: their bars add up to ${sum}; the video is exactly ${bars} bars`);
  const B = banksOf(plan);
  for (const [part, list] of Object.entries(B)) {
    const names = new Set();
    for (const v of list) {
      if (names.has(v.name)) p.push(`banks.${part}: "${v.name}" is used twice`); names.add(v.name);
      const len = part === 'drums' ? (v.steps === 32 ? 2 : 1) * bpb : (v.bars || 1) * bpb;
      if (part === 'drums') {
        for (const [row, s] of Object.entries(v.parts || {})) {
          if (gmOf(row) === undefined) p.push(`banks.drums "${v.name}": unknown row "${row}" (use kick, snare, rim, clap, hat, open hat, ride, crash, tom, shaker)`);
          if (typeof s !== 'string' || !/^[xXg.]+$/.test(s) || s.length !== v.steps) p.push(`banks.drums "${v.name}".${row}: ${v.steps} characters of x X g .`);
        }
        continue;
      }
      for (const n of v.notes || v.hits || []) if (!(n.t >= 0 && n.t < len - 1e-9 && n.d > 0)) { p.push(`banks.${part} "${v.name}": a note at t=${n.t} (d=${n.d}) is outside its ${v.bars} bar(s)`); break; }
    }
  }
  for (const [i, s] of (plan.sections || []).entries()) {
    if (!Array.isArray(s.chords) || !s.chords.length) p.push(`sections[${i}] "${s.name}": no chords`);
    for (const c of (s.chords || []).flat()) { try { parseChord(c); } catch (e) { p.push(`sections[${i}] "${s.name}": ${e.message}`); } }
    for (const [part, name] of Object.entries(s.play || {})) {
      if (!['drums', 'bass', 'pad', 'melody', 'arp'].includes(part)) p.push(`sections[${i}] "${s.name}": no part "${part}" (drums, bass, pad, melody, arp)`);
      else if (name !== 'rest' && !findVariant(plan, part, name)) p.push(`sections[${i}] "${s.name}": ${part} plays "${name}", which isn't in banks.${part}`);
    }
  }
  const m = plan.motif || {};
  if (!Array.isArray(m.degrees) || m.degrees.length < 3 || !Array.isArray(m.beats) || m.beats.length !== m.degrees.length) p.push('motif: 3 or more degrees, one length in beats each');
  return p;
}

// The chord tone named by `tone` in a chord, as a pitch class (null when the chord has no such tone).
function tonePc(chord, tone, strict = false) {
  const has = (iv) => chord.tones.has((chord.root + iv) % 12) || (!strict && chord.tens.has((chord.root + iv) % 12));
  const first = (ivs) => { for (const iv of ivs) if (chord.tones.has((chord.root + iv) % 12)) return (chord.root + iv) % 12; return null; };
  switch (tone) {
    case 'R': case '8': return chord.bass;
    case '3': return first([4, 3, 5, 2]);
    case '5': return first([7, 6, 8]);
    case '7': return first([10, 11, 9]);
    case '6': return first([9]) ?? (has(9) ? (chord.root + 9) % 12 : null);
    case '9': return first([2, 1, 3]) ?? (has(2) ? (chord.root + 2) % 12 : null);
    default: return null;
  }
}
const nearestWithPc = (pc, target, lo, hi) => { let best = null; for (let p = lo; p <= hi; p++) if (((p % 12) + 12) % 12 === pc && (best === null || Math.abs(p - target) < Math.abs(best - target))) best = p; return best; };

// The notes: [{ part, pitch, start, dur, vel }] in beats from bar 1.
// A drum the instrument pack's kit doesn't have plays as the nearest one it does (a shaker as the hat…), else not at all.
const KIN = { 70: [42, 46], 54: [42, 46], 46: [42], 51: [42, 46], 42: [46, 70], 37: [38, 39], 39: [38, 37], 38: [39, 37], 41: [45, 48], 48: [45, 41], 45: [41, 48], 49: [51, 46] };
const inKit = (gm, kit) => (!kit || kit.has(gm) ? gm : (KIN[gm] || []).find((x) => kit.has(x)));

export function writeSong({ plan, bp, cuts = [], voiceBusy = () => false, kit = null }) {
  const bpb = bpbOf(bp.meter);
  const { timeline } = chartTimeline(bp.chart, { bars: bp.bars, beatsPerBar: bpb });
  const chordAt = (t) => timeline.find((c) => t >= c.begin - 1e-9 && t < c.end - 1e-9);
  const mode = MODES[String(plan.scale).split(':')[1].trim().toLowerCase()];
  const tonic = parseChord(String(plan.scale).split(':')[0].trim()).root;
  const notes = [];
  // a pitched note sounding a semitone (or a minor 9th) from another part's is moved to the nearest other choice, or left out
  const rubs = (part, pitch, a, b) => notes.some((n) => n.part !== part && n.part !== 'drums' && n.start < b - 1e-9 && n.start + n.dur > a + 1e-9 && [1, 11].includes(Math.abs(n.pitch - pitch) % 12));
  const place = (part, choices, start, dur, vel) => { const p = choices.find((x) => x !== null && x !== undefined && !rubs(part, x, start, start + dur)); if (p === undefined) return false; notes.push({ part, pitch: p, start: r3(start), dur: r3(dur), vel }); return true; };
  const chordPitches = (chord, target, lo, hi) => { const out = []; for (let p = lo; p <= hi; p++) if (chord.tones.has(((p % 12) + 12) % 12)) out.push(p); return out.sort((x, y) => Math.abs(x - target) - Math.abs(y - target) || x - y); };
  const secOf = (bar) => bp.sections.findIndex((s) => bar >= s.start_bar && bar <= s.end_bar);
  const under = (beat) => voiceBusy(bp.offset_sec + beat * 60 / bp.bpm);
  const sections = plan.sections;
  // every bar a part plays: [absolute start beat of the bar, the pattern position of that bar, the variant]
  const barsOf = (part) => {
    const out = [];
    for (let bar = 1; bar <= bp.bars; bar++) {
      const i = secOf(bar); if (i < 0) continue;
      const v = findVariant(plan, part, sections[i].play?.[part]);
      if (!v) continue;
      const len = part === 'drums' ? (v.steps === 32 ? 2 : 1) : (v.bars || 1);
      out.push({ bar, t0: (bar - 1) * bpb, p0: ((bar - bp.sections[i].start_bar) % len) * bpb, v });
    }
    return out;
  };
  const each = (part, list, f) => { for (const b of barsOf(part)) for (const n of list(b.v)) if (n.t >= b.p0 - 1e-9 && n.t < b.p0 + bpb - 1e-9) f(b.t0 + (n.t - b.p0), n, b); };

  // the drums: the grids, step by step
  for (const b of barsOf('drums')) {
    const step = (b.v.steps === 32 ? 2 * bpb : bpb) / (b.v.steps === 8 ? 8 : b.v.steps === 32 ? 32 : 16) * (b.v.steps === 8 ? 1 : 1);
    for (const [row, s] of Object.entries(b.v.parts || {})) {
      const gm = inKit(gmOf(row), kit); if (gm === undefined) continue;
      for (let k = 0; k < s.length; k++) {
        const at = k * step; if (at < b.p0 - 1e-9 || at >= b.p0 + bpb - 1e-9 || s[k] === '.') continue;
        notes.push({ part: 'drums', pitch: gm, start: r3(b.t0 + at - b.p0), dur: 0.25, vel: VEL[s[k]] ?? 0.7 });
      }
    }
  }
  // the melody first (it has the right of way): the phrases in scale degrees; a note the chord doesn't allow there moves
  // to the nearest chord tone
  const degreePitch = (d, octave) => { const k = ((d % mode.length) + mode.length) % mode.length; return 12 * (octave + 1) + tonic + mode[k] + 12 * Math.floor(d / mode.length); };
  const mel = [];
  each('melody', (v) => v.notes || [], (t, n) => { const c = chordAt(t); if (c) mel.push({ t, d: Math.min(n.d, c.end - t), pitch: degreePitch(n.deg, 4), v: n.v ?? 0.7, c }); });
  mel.sort((a, b) => a.t - b.t);
  mel.forEach((m, i) => {
    const pc = ((m.pitch % 12) + 12) % 12;
    const ok = m.c.chord.tones.has(pc) || m.c.chord.tens.has(pc);
    const onBeat = Math.abs(m.t - Math.round(m.t)) < 1e-6;
    const next = mel[i + 1];
    const passing = m.d <= 0.5 + 1e-9 && !onBeat && next && Math.abs(next.pitch - m.pitch) <= 2;
    const pitch = ok || passing ? m.pitch : chordPitches(m.c.chord, m.pitch, m.pitch - 6, m.pitch + 6)[0] ?? m.pitch;
    notes.push({ part: 'melody', pitch, start: r3(m.t), dur: r3(m.d), vel: m.v - (under(m.t) ? 0.08 : 0) });
  });
  // the bass: chord tones of the chord sounding at each note, around the root, at or under A2
  each('bass', (v) => v.notes || [], (t, n) => {
    const c = chordAt(t); if (!c) return;
    const root = 36 + c.chord.bass; const r = root > 45 ? root - 12 : root;
    const pc = tonePc(c.chord, n.tone, true) ?? c.chord.bass;
    const pitch = n.tone === '8' ? r + 12 : nearestWithPc(pc, r + 3, r, r + 11) ?? r;
    place('bass', [pitch, r], t, Math.min(n.d, c.end - t), n.v ?? 0.75);
  });
  // the pad (keys, comping): the voicing's chord tones, each voice moving the shortest way from the last chord; a voice
  // that would rub against the melody or the bass takes the next octave or drops out
  let voicing = [52, 57, 62, 67];
  each('pad', (v) => (v.hits || []).map((h) => ({ ...h, voicing: v.voicing })), (t, n) => {
    const c = chordAt(t); if (!c) return;
    let pcs = [...new Set((n.voicing?.length ? n.voicing : ['R', '3', '5', '7']).map((x) => tonePc(c.chord, x, true)).filter((x) => x !== null))];
    if (pcs.length < 2) pcs = [...new Set([c.chord.root, tonePc(c.chord, '3', true), tonePc(c.chord, '7', true) ?? tonePc(c.chord, '5', true)].filter((x) => x !== null))];
    const dur = Math.min(n.d, c.end - t); const vel = (n.v ?? 0.6) - (under(t) ? 0.05 : 0);
    const next = [];
    for (const pc of pcs) {
      const prev = voicing.reduce((best, x) => (best === null || Math.abs(nearestWithPc(pc, x, 50, 74) - x) < Math.abs(nearestWithPc(pc, best, 50, 74) - best) ? x : best), null);
      const p = nearestWithPc(pc, prev ?? 62, 50, 74);
      const choices = [p, p + 12, p - 12].filter((x) => x >= 48 && x <= 79 && !next.some((y) => Math.abs(y - x) <= 1));
      const k = choices.find((x) => !rubs('pad', x, t, t + dur));
      if (k !== undefined) { next.push(k); notes.push({ part: 'pad', pitch: k, start: r3(t), dur: r3(dur), vel }); }
    }
    if (next.length) voicing = next.sort((a, b) => a - b);
  });
  // the arp: chord tones in the middle register, the nearest one that rubs against nothing
  each('arp', (v) => v.notes || [], (t, n) => {
    const c = chordAt(t); if (!c) return;
    const pc = tonePc(c.chord, n.tone, true) ?? c.chord.root;
    const p = nearestWithPc(pc, n.tone === '8' ? 74 : 67, 60, 81);
    place('arp', [p, ...chordPitches(c.chord, p, 60, 81)], t, Math.min(n.d, c.end - t), n.v ?? 0.5);
  });
  // the picture's big moments as arrangement moves
  const drop = (t) => { for (let k = notes.length - 1; k >= 0; k--) { const n = notes[k]; if (['drums', 'bass', 'arp'].includes(n.part) && n.start >= t - 2 - 1e-9 && n.start < t - 1e-9) notes.splice(k, 1); else if (n.part === 'bass' && n.start < t - 2 && n.start + n.dur > t - 2) n.dur = r3(t - 2 - n.start); } };
  const fill = (t) => {
    for (let k = notes.length - 1; k >= 0; k--) if (notes[k].part === 'drums' && notes[k].start >= t - 1 - 1e-9 && notes[k].start < t - 1e-9) notes.splice(k, 1);
    for (let k = 0; k < 4; k++) { const gm = inKit(k < 2 ? 38 : 45, kit); if (gm !== undefined) notes.push({ part: 'drums', pitch: gm, start: r3(t - 1 + k * 0.25), dur: 0.25, vel: 0.5 + k * 0.1 }); }
  };
  for (const m of plan.moments || []) {
    const h = cuts.find((x) => x.cut === m.cut); if (!h) continue;
    const t = (h.bar - 1) * bpb + (h.beat - 1);
    if (m.move === 'drop') drop(t); else if (m.move === 'fill') fill(t);
  }

  // swing: off-beat 8ths (or 16ths) start late and end where they did
  const sw = Math.max(0.5, Math.min(0.7, Number(plan.swing?.amount) || 0.5));
  if (sw > 0.5) {
    const pair = plan.swing?.on === '16th' ? 0.5 : 1;
    const late = Math.round((sw - 0.5) * pair * 48) / 48;
    for (const n of notes) {
      const pos = r3(n.start % pair);
      if (Math.abs(pos - pair / 2) > 1e-6 || n.dur <= late + 0.05) continue;
      n.start = r3(n.start + late); if (n.part !== 'drums') n.dur = r3(n.dur - late);
    }
  }
  // a note can't run past the end; a sliver is no note
  const end = bp.bars * bpb;
  for (let k = notes.length - 1; k >= 0; k--) { const n = notes[k]; if (n.start >= end - 1e-9) notes.splice(k, 1); else if (n.start + n.dur > end) n.dur = r3(end - n.start); if (n.dur < 0.05) notes.splice(k, 1); }
  return notes.sort((a, b) => a.start - b.start || a.part.localeCompare(b.part) || a.pitch - b.pitch);
}

// The blueprint the engine checks, from the song plan: sections in bars, the chart from each section's chord loop, the
// intensity of each section measured from what it plays (the parts decide how busy a section is, not a number asked).
export function songBlueprint({ plan, map, cuts }) {
  let bar = 1;
  const sections = plan.sections.map((s) => { const o = { name: s.name, start_bar: bar, end_bar: bar + s.bars - 1, function: s.function, intensity: 5, picture: '', variation: 'statement', parts: Object.entries(s.play || {}).filter(([, v]) => v !== 'rest').map(([k]) => k), why: s.why }; bar += s.bars; return o; });
  const moveOf = new Map((plan.moments || []).map((m) => [m.cut, m]));
  return {
    title: plan.title, bpm: map.bpm, meter: map.meter, bars: map.bars, scale: plan.scale, offset_sec: map.offset_sec,
    dramatic_reading: plan.dramatic_reading,
    motif: { degrees: plan.motif.degrees, beats: plan.motif.beats, role: ROLES.melody.name, contour: plan.motif.contour || null },
    sections,
    hits: cuts.map((h) => { const m = moveOf.get(h.cut); const kind = !h.fits || !m || m.move === 'none' ? 'none' : 'anticipation'; return { t_sec: h.t_sec, bar: h.bar, beat: h.beat, kind, what: `${h.what}${m ? `: ${m.move}, ${m.why}` : ''}` }; }),
    chart: sections.map((s, i) => ({ bars: [s.start_bar, s.end_bar], chords: plan.sections[i].chords })),
    roles: [],
    genre_signature: plan.genre_signature,
    ending: plan.ending,
    made_by: 'the studio: the song plan (banks and scenes) by one AI call, the notes by src/music/song.mjs',
  };
}

// Write, then measure: each section's intensity is set from what it plays (0-10 by its measured level), so the
// engine's curve check holds what the parts really do; the harmony lock is the engine's own.
export function songChecked({ plan, bp, cuts, voiceBusy, kit = null }) {
  const notes = writeSong({ plan, bp, cuts, voiceBusy, kit });
  const used = new Set(notes.map((n) => n.part));
  bp.roles = PARTS.filter((k) => used.has(k)).map((k) => ({ channel: ROLES[k].channel, harmony: ROLES[k].harmony, name: ROLES[k].name, job: ROLES[k].job }));
  const man = manifestOf(notes, bp);
  const first = intensity(man, bp);
  const levels = first.sections.map((s) => s.measured);
  const lo = Math.min(...levels); const hi = Math.max(...levels);
  bp.sections.forEach((s, i) => { s.intensity = hi > lo ? Math.round(1 + 8 * (levels[i] - lo) / (hi - lo)) : 5; });
  return { notes, harmony: checkHarmony(man, bp), curve: intensity(man, bp) };
}

// ---- the plan call's prompt ----

// The owner's own music rules (music-prompt-1 §2 and music-prompt-2's hook, banks and scenes, and arrangement steps),
// read from the owner's prompts folder ($MFX_MUSIC_PROMPTS, else ~/Documents/programs/music prompts) when it's there.
import { existsSync as _exists, readFileSync as _read } from 'node:fs';
import { join as _join } from 'node:path';
import { homedir } from 'node:os';
const between = (text, from, to) => { const a = text.indexOf(from); if (a < 0) return ''; const b = to ? text.indexOf(to, a + from.length) : -1; return text.slice(a, b > a ? b : undefined).trim(); };
export function ownerRules() {
  const dir = process.env.MFX_MUSIC_PROMPTS || _join(homedir(), 'Documents', 'programs', 'music prompts');
  const f1 = _join(dir, 'music-prompt-1.md'); const f2 = _join(dir, 'music-prompt-2.md');
  if (!_exists(f1) || !_exists(f2)) return '';
  const p1 = _read(f1, 'utf8'); const p2 = _read(f2, 'utf8');
  return [
    between(p1, '# 2. Composition and Listener Experience', '# 3. Structure'),
    between(p2, '# STEP 1 — DISCOVER THE MUSICAL HOOK', '# STEP 3'),
    between(p2, '# STEP 4 — BUILD A CLEAR ARRANGEMENT ARCHITECTURE', '# STEP 5'),
    between(p2, '# STEP 7 — ARRANGEMENT, DEVELOPMENT, AND LISTENER EXPERIENCE', '# STEP 9'),
  ].filter(Boolean).join('\n\n');
}

export function songPrompt({ c, pack, map, cuts, scenes, words, harmony, melodyCraft, profileText, fix, kit = null }) {
  const rows = kit ? Object.entries(DRUM_GM).filter(([, gm]) => kit.has(gm)).map(([k]) => k).filter((k, i, a) => !/-|^chh$|^ohh$|^ghost$|^sidestick$|^perc$/.test(k)) : null;
  const bpb = bpbOf(map.meter);
  const barOf = (t) => Math.floor((t - map.offset_sec) / map.sec_per_bar) + 1;
  const busy = (a, b) => c.timing.lines.filter((l) => l.end > a && l.start < b).map((l) => l.text).join(' ');
  return [
    `You write the original music for "${c.project.title}", a video with narration, as a real ${pack.profile.name} piece: a memorable hook, a groove that locks, harmony that moves with purpose, phrases that breathe, a form that builds and resolves. You write it as banks and scenes (below); the studio's code turns them into notes on the chord of every moment, renders the parts with the instrument pack and mixes them under the voice. Answer with the JSON asked for and nothing else.`,
    `## The brief\n${JSON.stringify({ ...c.project.intake?.answers, ...Object.fromEntries(Object.entries(c.project.mfx?.answers || {}).map(([k, v]) => [k, v.answer])) })}`,
    `## The genre: ${pack.profile.name} (researched; write inside it, and name in "genre_signature" the elements that carry your hook and your beat)\n${profileText}`,
    `## The clock (fixed by the studio from the cuts: plan in these bars)\n${map.bpm} BPM, ${map.meter}, bar 1 starts at ${map.offset_sec} s, a bar is ${map.sec_per_bar} s. The video is exactly ${map.bars} bars: your sections must add up to ${map.bars}.`,
    `## The picture, in bars\n${scenes.map((s, i) => `scene ${i + 1} from bar ${Math.max(1, barOf(s.start_sec))} (${s.start_sec.toFixed(1)} s): "${s.name || s.key}". Spoken: "${busy(s.start_sec, s.end_sec)}"`).join('\n')}\n\nCuts: ${cuts.map((h) => `cut ${h.cut} at bar ${h.bar} beat ${h.beat} (${h.t_sec} s): ${h.what}`).join('; ')}\n\nWhere the voice speaks (bars): ${words}`,
    `## How the studio plays your banks and scenes
- A section plays its chord loop (one chord per bar, cycling; ["Am7", "D7"] splits a bar) and, for every part, the bank variant named in "play" (or "rest"). A variant of 2 or 4 bars loops inside the section from its first bar. Keep sections a whole number of phrases (4 or 8 bars) unless the picture needs a shorter one; let only the 2-3 biggest picture moments move a section boundary.
- drums: a step grid per variant (16 steps = one bar of 16ths, 32 = two bars). Rows the kit has: ${rows ? rows.join(', ') : 'kick, snare, rim, clap, hat, open hat, ride, crash, tom, shaker'}. X accent, x hit, g ghost.
- bass: notes as chord tones ("R", "3", "5", "7", "9", "6", "8"); the code finds that tone in the chord sounding at that moment, so one riff follows every chord. Write the genre's bass behaviour (where it locks to the kick, where it leaves holes).
- pad (keys, comping): a rhythm of hits and a voicing (which chord tones sound); voice-led by the code.
- melody: real phrases in scale degrees with their rhythm (t, d in beats from the start of the variant). Write the motif's statement, its answer, and its developments as separate variants; a phrase has a beginning, a peak and an ending, with rests. Chord tones on the beats; passing notes short, off the beat, by step (the code moves a note the chord doesn't allow to the nearest chord tone).
- arp (optional): a pattern of chord tones in the middle register.
- swing: the genre's feel, on 8ths or 16ths; it applies to every part.
- moments: for each cut, drop (drums and bass stop for the two beats before it), fill (a drum fill into it) or none. Use drop or fill for at most 2-3 cuts that change the meaning; the music carries on through the rest. No other notes are added for the picture.
- The voice talks almost all the time: the music sits ~20 dB under it. Keep the melody sparse and low-key while words are spoken; give it room in the gaps and at the end.`,
    harmony,
    `## The owner's music rules (follow them)\n${ownerRules()}`,
    `## Melody craft\n${melodyCraft}`,
    `## The owner's recent pieces (vary key and opening chords from them)\n${JSON.stringify(c.recent.map((r) => ({ title: r.title, scale: r.scale, bpm: r.bpm, opening: r.opening })))}`,
    fix ? `## Your last plan was refused: fix only these\n${fix.errors.join('\n')}\n\n## That plan\n${JSON.stringify(fix.plan)}` : '',
  ].filter(Boolean).join('\n\n');
}
