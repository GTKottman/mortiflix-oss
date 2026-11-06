// A finished score becomes a song (doc 18 §7.1, doc 28 §1): music/notes.json + blueprint + instruments → song.json and
// song.strudel.js. The Strudel file is written from the score's notes; the song's notes are then worked out from that
// file (not copied), and must equal notes.json exactly, or the import fails and says which note.
import { createHash } from 'node:crypto';
import { emptySong, ticksPerBar, checkSong, PPQ } from './song.mjs';
import { buildSongFile, songNotes, parseSongFile } from './strudel/songfile.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const ROLE_COLOURS = ['#7a3f14', '#2f6f8f', '#8f2f5a', '#4f7f2f', '#6f4f9f', '#9f7f2f', '#2f8f6f', '#8f4f2f'];

function meterOf(m = '4/4') {
  const [num, den] = String(m).split('/').map(Number);
  return { num: num || 4, den: den || 4 };
}

// notes.json tracks (beats) → per channel, per section, notes in ticks from the section start.
function rowsFromManifest(manifest, sections, tpb) {
  const rows = {};
  for (const tr of manifest.tracks) {
    rows[tr.channel] = {};
    for (const sec of sections) rows[tr.channel][sec.id] = [];
    for (const n of tr.notes) {
      const tick = Math.round(n.start * PPQ);
      const sec = sections.find((s) => tick >= s.startTick && tick < s.startTick + s.bars * tpb);
      if (!sec) continue;
      rows[tr.channel][sec.id].push({ t: tick - sec.startTick, len: Math.max(1, Math.round(n.dur * PPQ)), key: n.pitch, vel: n.velocity });
    }
  }
  return rows;
}

// The song's notes as a notes.json-shaped manifest (doc 18 §7.4): beats, whole song, per channel.
export function toManifest(song) {
  const tpb = ticksPerBar(song.meter[0]);
  const start = new Map();
  for (const i of song.playlist.items) if (i.kind === 'pattern') start.set(i.ref, i.at.tick);
  const tracks = new Map();
  for (const c of song.channels) tracks.set(c.id, { channel: c.midiChannel, name: c.name, kind: c.kind === 'drums' ? 'drums' : 'pitched', notes: [] });
  for (const p of song.patterns) for (const [ch, ns] of Object.entries(p.notes || {})) {
    for (const n of ns) tracks.get(ch)?.notes.push({ pitch: n.key, start: +((start.get(p.id) + n.t) / PPQ).toFixed(6), dur: +(n.len / PPQ).toFixed(6), velocity: n.vel ?? 0.8 });
  }
  const list = [...tracks.values()].filter((t) => t.notes.length).sort((a, b) => a.channel - b.channel);
  for (const t of list) t.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { title: song.title, bpm: song.tempo[0].bpm, meter: `${song.meter[0].num}/${song.meter[0].den}`, beats_per_bar: tpb / PPQ, bars: song.patterns.reduce((s, p) => s + p.bars, 0), tracks: list };
}

// Compares two manifests note by note (whole ticks, velocity to 3 decimals). Returns plain-words differences.
export function compareManifests(want, got, { limit = 5 } = {}) {
  const key = (n) => `${Math.round(n.start * PPQ)}|${n.pitch}|${Math.round(n.dur * PPQ)}|${Math.round(n.velocity * 1000)}`;
  const say = (n, bpb) => `pitch ${n.pitch} at bar ${Math.floor(n.start / bpb) + 1} beat ${+((n.start % bpb) + 1).toFixed(3)}, ${+n.dur.toFixed(3)} beats, velocity ${n.velocity}`;
  const out = [];
  const bpb = want.beats_per_bar || 4;
  const chans = new Set([...want.tracks.map((t) => t.channel), ...got.tracks.map((t) => t.channel)]);
  for (const c of [...chans].sort((a, b) => a - b)) {
    const a = want.tracks.find((t) => t.channel === c)?.notes || [];
    const b = got.tracks.find((t) => t.channel === c)?.notes || [];
    const left = new Map();
    for (const n of b) { const k = key(n); left.set(k, [...(left.get(k) || []), n]); }
    for (const n of a) { const k = key(n); const l = left.get(k); if (l?.length) l.shift(); else out.push(`channel ${c}: the score's note ${say(n, bpb)} is missing from the song`); }
    for (const l of left.values()) for (const n of l) out.push(`channel ${c}: the song has an extra note ${say(n, bpb)}`);
  }
  return out.length > limit ? [...out.slice(0, limit), `… ${out.length - limit} more`] : out;
}

// Joins notes in the same place with the same pitch and length (MIDI can't tell them apart). Returns how many.
function dedupe(manifest) {
  let joined = 0;
  for (const t of manifest.tracks) {
    const seen = new Set();
    t.notes = t.notes.filter((n) => { const k = `${Math.round(n.start * PPQ)}|${n.pitch}|${Math.round(n.dur * PPQ)}`; if (seen.has(k)) { joined++; return false; } seen.add(k); return true; });
  }
  return joined;
}

// The song and its Strudel file from the score's notes, without running anything: the patterns' notes are the score's
// (ticks from each section's start). importScore checks them against the file; the demo uses this as it is.
export function songFromNotes({ blueprint: bp, notes: manifestIn, instruments = null, sources = {} }) {
  const warnings = [];
  const manifest = JSON.parse(JSON.stringify(manifestIn));
  const joined = dedupe(manifest);
  if (joined) warnings.push(`${joined} note${joined === 1 ? '' : 's'} in the same place with the same pitch and length were joined into one (MIDI can't tell them apart)`);
  const meter = meterOf(bp.meter || manifest.meter);
  const tpb = ticksPerBar(meter);
  const bpm = manifest.bpm ?? bp.bpm;
  const sections = (bp.sections || []).map((s, i) => ({ id: s.id || `m${pad(i + 1)}`, name: s.name, bars: s.end_bar - s.start_bar + 1, startTick: (s.start_bar - 1) * tpb, beat: s.beat || null }));
  if (!sections.length) throw new Error('the blueprint has no sections');
  const scale = bp.scale ? (() => { const [root, mode] = String(bp.scale).split(':'); return { root, mode: mode || 'major', limitToScale: true }; })() : null;

  const song = emptySong({ title: bp.title || manifest.title || 'Untitled', bpm, num: meter.num, den: meter.den, offsetSec: bp.offset_sec || 0, scale });
  const partOf = (ch) => instruments?.parts?.find((p) => Number(p.channel) === ch) || null;
  const roleOf = (ch) => (bp.roles || []).find((r) => Number(r.channel) === ch) || null;
  const tracks = [...manifest.tracks].sort((a, b) => a.channel - b.channel);
  tracks.forEach((tr, i) => {
    const part = partOf(tr.channel);
    const drums = tr.channel === 10 || tr.kind === 'drums' || Boolean(part?.kit);
    song.channels.push({ id: `ch${pad(tr.channel)}`, name: part?.role || roleOf(tr.channel)?.name || tr.name || `Channel ${tr.channel}`, role: part?.role || roleOf(tr.channel)?.name || null,
      colour: ROLE_COLOURS[i % ROLE_COLOURS.length], kind: drums ? 'drums' : 'instrument', midiChannel: tr.channel, instrument: null, insert: `mx${pad(tr.channel)}`,
      volDb: part?.gain ? +(20 * Math.log10(part.gain)).toFixed(2) : 0, pan: Number(part?.pan) || 0 });
    song.mixer.inserts.push({ id: `mx${pad(tr.channel)}`, n: tr.channel, name: song.channels.at(-1).name, plugins: [], volDb: 0, pan: 0, out: 'master' });
  });

  const rows = rowsFromManifest(manifest, sections, tpb);
  const chan = (ch) => song.channels.find((c) => c.midiChannel === ch);
  const text = buildSongFile({
    title: song.title, bpm, meter, scale: bp.scale || null,
    sections: sections.map(({ id, name, bars }) => ({ id, name, bars })),
    parts: tracks.map((tr) => ({ channel: tr.channel, name: chan(tr.channel).name, drums: chan(tr.channel).kind === 'drums', sound: partOf(tr.channel), rows: rows[tr.channel] })),
  });

  song.playlist.tracks.push({ id: 'r1', name: 'Music' }, { id: 'r2', name: 'Narration' }, { id: 'r3', name: 'Sound effects' }, { id: 'r4', name: 'Reference (Strudel)', mute: true });
  sections.forEach((sec, i) => {
    const notes = {};
    for (const c of song.channels) {
      const ns = (rows[c.midiChannel]?.[sec.id] || []).map(({ t, len, key, vel }) => ({ t, len, key, vel })).sort((a, b) => a.t - b.t || a.key - b.key || a.len - b.len);
      if (ns.length) notes[c.id] = ns;
    }
    song.patterns.push({ id: sec.id, name: sec.name, colour: null, bars: sec.bars, cue: sec.id, notes });
    song.playlist.items.push({ id: `i${String(i + 1).padStart(3, '0')}`, kind: 'pattern', ref: sec.id, track: 'r1', at: { tick: sec.startTick }, len: sec.bars * tpb });
    song.markers.push({ id: `k${pad(i + 1)}`, tick: sec.startTick, name: sec.name, kind: 'section', from: 'blueprint' });
  });
  (bp.hits || []).forEach((h, i) => song.markers.push({ id: `h${pad(i + 1)}`, tick: Math.round((((h.bar - 1) * tpb / PPQ) + ((h.beat ?? 1) - 1)) * PPQ), name: h.what || 'hit', kind: 'hit', sec: h.t_sec, from: 'blueprint' }));
  markSameAs(song);
  // each pattern (section × part) remembers the hash of the text its notes came from (doc 28 §1.4)
  const parsed = parseSongFile(text);
  song.strudel.regions = {};
  for (const b of parsed.blocks) b.rows.forEach((r, i) => { song.strudel.regions[`${sections[i].id}.ch${pad(b.channel)}`] = { sha: sha(r.text).slice(0, 16) }; });
  song.strudel.sha = sha(text);
  song.source = { score: 'music/score.strudel.js', scoreSha: sources.score ? sha(sources.score) : null, notesSha: sources.notes ? sha(sources.notes) : null, blueprintSha: sources.blueprint ? sha(sources.blueprint) : null, importedAt: new Date().toISOString() };
  return { song, text, warnings, manifest, sections, tpb };
}

// Identical sections: offered as "edit both".
function markSameAs(song) {
  for (const p of song.patterns) delete p.sameAs;
  for (let i = 0; i < song.patterns.length; i++) for (let j = 0; j < i; j++) {
    const [a, b] = [song.patterns[i], song.patterns[j]];
    if (!b.sameAs && a.bars === b.bars && Object.keys(a.notes).length && JSON.stringify(a.notes) === JSON.stringify(b.notes)) { a.sameAs = b.id; break; }
  }
}

// in: { blueprint, notes (notes.json), instruments (instruments.json or null), evaluator, sources: { score, notes, blueprint } texts }
// out: { song, text, warnings }, or throws with the differences when the file doesn't play the score exactly.
// The patterns' notes are worked out from the Strudel file, not copied.
export async function importScore({ evaluator, ...input }) {
  const { song, text, warnings, manifest, sections, tpb } = songFromNotes(input);
  const drumChannels = song.channels.filter((c) => c.kind === 'drums').map((c) => c.midiChannel);
  const derived = await songNotes(evaluator, text, sections, { ticksPerBar: tpb, beatsPerBar: tpb / PPQ, drumChannels });
  if (derived.problems.length) throw Object.assign(new Error(`the song file doesn't play the score: ${derived.problems.slice(0, 3).join('; ')}`), { problems: derived.problems, text });
  for (const p of song.patterns) {
    p.notes = {};
    for (const c of song.channels) { const ns = derived.parts[c.midiChannel]?.[p.id] || []; if (ns.length) p.notes[c.id] = ns; }
  }
  markSameAs(song);
  // exactness: the file plays the score note for note
  const diff = compareManifests(manifest, toManifest(song));
  if (diff.length) throw Object.assign(new Error(`the song doesn't play the score exactly:\n  ${diff.join('\n  ')}`), { problems: diff, text });
  const errors = checkSong(song);
  if (errors.length) throw new Error(`the imported song fails its check: ${errors.join('; ')}`);
  return { song, text, warnings };
}
