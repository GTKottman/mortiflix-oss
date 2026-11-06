// What a session sees and does to the song (doc 26 §2–4), behind `mfx song …`. Every write is a doc 18 operation with
// by: 'ai', so locks hold (an edit request lifts only the locks inside its bars), a write based on an old read is refused,
// and the AI's notes must pass the harmony check where the owner's would only warn.
import { existsSync, readFileSync } from 'node:fs';
import { loadSong, songPaths, importProjectSong } from './song-store.mjs';
import { applyOps, ladderFor, noteName } from './song-ops.mjs';
import { ticksPerBar, sectionLayout, PPQ } from './song.mjs';
import { parseSongFile } from './strudel/songfile.mjs';
import { toManifest } from './song-import.mjs';
import { readEdits } from './canvas.mjs';
import { UserError } from './studio.mjs';
import { checkHarmony } from '../pipelines/_shared/skills/music/lib/harmony.mjs';
import { noteToMidi } from '../pipelines/_shared/skills/music/lib/score.mjs';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nameOf = (k) => `${NAMES[k % 12]}${Math.floor(k / 12) - 1}`;
const need = (song) => { if (!song) throw new UserError('no song yet: run mfx song import once the score passes its check'); return song; };

function fraction(ticks) {
  // ticks → "1/8", "3/16" … of a whole note (3840 ticks), else ticks
  const whole = PPQ * 4;
  for (const d of [1, 2, 4, 8, 16, 32, 3, 6, 12, 24]) { const n = ticks * d / whole; if (Number.isInteger(n)) return `${n}/${d}`; }
  return String(ticks);
}

function lockLines(song) {
  const tpb = ticksPerBar(song.meter[0]);
  return (song.locks || []).map((l) => {
    const s = l.scope || {};
    const ch = song.channels.find((c) => c.id === s.channel);
    const bars = s.fromTick !== undefined ? ` bars ${s.fromTick / tpb + 1}–${s.toTick / tpb}` : '';
    return `${l.id}: ${s.pattern || 'every section'} ${ch?.name || s.channel || 'all parts'}${bars} (${l.by === 'ok' ? 'OK\'d' : 'hand-edited'})`;
  });
}

// mfx song: the song in short.
export function songSummary(root, id) {
  const loaded = need(loadSong(root, id));
  const { song } = loaded;
  const layout = sectionLayout(song);
  const edits = readEdits(root, id).filter((e) => e.state === 'requested' && e.kind === 'cue');
  return {
    rev: song.rev, title: song.title, tempo: song.tempo[0].bpm, meter: `${song.meter[0].num}/${song.meter[0].den}`,
    scale: song.scale ? `${song.scale.root}:${song.scale.mode}` : null,
    sections: layout.map((x) => ({ id: x.id, name: song.patterns.find((p) => p.id === x.id)?.name, bars: `${x.startBar}–${x.startBar + x.bars - 1}` })),
    parts: song.channels.map((c) => ({ id: c.id, name: c.name, plays: c.instrument ? c.instrument.name : 'its Strudel sound' })),
    locks: lockLines(song),
    open_bar_edits: edits.map((e) => ({ id: e.id, section: e.node, bars: e.bars || null, part: e.part || null, text: e.text })),
  };
}

// mfx song show m02 [--part ch02] [--bars 3-4]: the notes as a table (bars and beats inside the section).
export function songShow(root, id, { section, part = null, bars = null }) {
  const { song } = need(loadSong(root, id));
  const p = song.patterns.find((x) => x.id === section);
  if (!p) throw new UserError(`there is no section ${section}: mfx song lists them`);
  const tpb = ticksPerBar(song.meter[0]);
  const beatsPerBar = tpb / PPQ;
  const [a, b] = bars || [1, p.bars];
  const rows = [];
  for (const c of song.channels) {
    if (part && c.id !== part) continue;
    for (const n of p.notes[c.id] || []) {
      const bar = Math.floor(n.t / tpb) + 1;
      if (bar < a || bar > b) continue;
      rows.push({ part: c.id, bar, beat: +((n.t % tpb) / PPQ + 1).toFixed(3), key: nameOf(n.key), len: fraction(n.len), vel: n.vel ?? 0.8, id: noteName(n) });
    }
  }
  const layout = sectionLayout(song).find((x) => x.id === section);
  return { rev: song.rev, section, name: p.name, song_bars: `${layout.startBar}–${layout.startBar + p.bars - 1}`, beats_per_bar: beatsPerBar, notes: rows,
    locks: lockLines({ ...song, locks: song.locks.filter((l) => !l.scope.pattern || l.scope.pattern === section) }) };
}

// mfx song strudel [m02] [--part ch02]: the rows exactly as in song.strudel.js.
export function songStrudel(root, id, { section = null, part = null } = {}) {
  const { song, text } = need(loadSong(root, id));
  const layout = sectionLayout(song);
  const out = [];
  for (const b of parseSongFile(text).blocks) {
    const ch = song.channels.find((c) => c.midiChannel === b.channel);
    if (part && ch?.id !== part) continue;
    b.rows.forEach((r, i) => { if (!section || layout[i]?.id === section) out.push({ section: layout[i]?.id, part: ch?.id, name: ch?.name, bars: r.bars, strudel: r.text }); });
  }
  return { rev: song.rev, rows: out };
}

// A note as a session writes it: { bar, beat, key: 'D2' | 38, len: '1/8' | ticks, vel } → ticks inside the section.
export function parseNote(n, tpb) {
  const key = typeof n.key === 'number' ? n.key : noteToMidi(String(n.key).toLowerCase());
  if (!Number.isInteger(key) || key < 0 || key > 127) throw new UserError(`"${n.key}" isn't a note (a name like D2, or a MIDI number)`);
  const len = typeof n.len === 'number' ? n.len : (() => { const m = String(n.len).match(/^(\d+)\/(\d+)$/); if (!m) throw new UserError(`length "${n.len}" must be a fraction like 1/8, or ticks`); return Math.round(Number(m[1]) / Number(m[2]) * PPQ * 4); })();
  const t = Math.round((Number(n.bar) - 1) * tpb + (Number(n.beat ?? 1) - 1) * PPQ);
  if (!Number.isFinite(t)) throw new UserError('every note needs a bar (and a beat)');
  return { t, len, key, vel: n.vel === undefined ? 0.8 : Number(n.vel) };
}

// The edit request's lifted locks: those inside its bars (and part) only (doc 18 §5 rule 4).
function liftedBy(song, editId, section, part, fromTick, toTick, root, id) {
  if (!editId) return [];
  const e = readEdits(root, id).find((x) => x.id === editId);
  if (!e) throw new UserError(`there is no edit request ${editId}`);
  if (!['requested', 'working', 'fast'].includes(e.state)) throw new UserError(`${editId} is ${e.state}, not open`);
  if (e.node !== section) throw new UserError(`${editId} is about ${e.node}, not ${section}`);
  const tpb = ticksPerBar(song.meter[0]);
  const [ea, eb] = e.bars ? [(e.bars[0] - 1) * tpb, e.bars[1] * tpb] : [0, Infinity];
  if (fromTick < ea || toTick > eb) throw new UserError(`${editId} covers bars ${e.bars[0]}–${e.bars[1]} of ${section}: write inside them`);
  if (e.part && part && e.part !== part) throw new UserError(`${editId} is about ${e.part}, not ${part}`);
  return song.locks.filter((l) => l.scope.pattern === section && (!l.scope.channel || !e.part || l.scope.channel === e.part)
    && (l.scope.fromTick === undefined || (l.scope.fromTick >= ea && l.scope.toTick <= eb))).map((l) => l.id);
}

// A write based on an old read: refused when the owner changed that section × part since `rev`.
function checkRev(song, region, rev) {
  if (rev === undefined || rev === null) return;
  const r = song.strudel.regions?.[region];
  if (r?.rev && r.rev > Number(rev) && r.by === 'hand') {
    const [sec, ch] = region.split('.');
    throw new UserError(`the owner changed ${sec} ${song.channels.find((c) => c.id === ch)?.name || ch} while you worked: run mfx song show ${sec} again`);
  }
}

// Harmony on AI writes (doc 26 §4): refused when the write adds a problem the song didn't have.
function harmonyAdded(root, id, before, after) {
  const bpPath = songPaths(root, id).blueprint;
  if (!existsSync(bpPath)) return [];
  const bp = JSON.parse(readFileSync(bpPath, 'utf8'));
  if (!bp.chart || !bp.scale) return [];
  const flat = (r) => Object.values(r.problems || {}).flat();
  const a = checkHarmony(toManifest(before), bp); const b = checkHarmony(toManifest(after), bp);
  if (a.errors.length && !Object.keys(a.problems || {}).length) return [];   // the blueprint can't be checked: nothing to compare
  const had = new Set(flat(a));
  return flat(b).filter((m) => !had.has(m));
}

async function aiWrite(root, id, ops, { rev, region }) {
  const { song } = need(loadSong(root, id));
  checkRev(song, region, rev);
  const r = await applyOps(root, id, ops.map((o) => ({ ...o, by: 'ai' })));
  if (r.refused.length) {
    if (r.applied.length) await (await import('./song-ops.mjs')).undo(root, id);
    throw new UserError(`refused: ${r.refused.map((x) => x.why).join('; ')}`);
  }
  const added = harmonyAdded(root, id, song, loadSong(root, id).song);
  if (added.length) {
    await (await import('./song-ops.mjs')).undo(root, id);
    throw new UserError(`the notes leave the harmony: ${added.slice(0, 4).join('; ')}${added.length > 4 ? ` (+${added.length - 4} more)` : ''}`);
  }
  return { rev: r.rev, changed: r.applied.map((a) => a.region).filter(Boolean) };
}

// mfx song notes m02 ch02 --bars 3-4 --file new.json [--edit E012]: that part's notes in those bars, replaced.
export async function songWriteNotes(root, id, { section, part, bars, notes, edit = null, rev = null }) {
  const { song } = need(loadSong(root, id));
  const p = song.patterns.find((x) => x.id === section);
  if (!p || !song.channels.some((c) => c.id === part)) throw new UserError(`there is no part ${part} in ${section}`);
  const tpb = ticksPerBar(song.meter[0]);
  const [a, b] = bars;
  const from = (a - 1) * tpb; const to = b * tpb;
  const fresh = (notes || []).map((n) => parseNote(n, tpb));
  for (const n of fresh) if (n.t < from || n.t >= to) throw new UserError(`a note at bar ${Math.floor(n.t / tpb) + 1} is outside bars ${a}–${b}`);
  const old = p.notes[part] || [];
  const out = old.filter((n) => n.t >= from && n.t < to).map(noteName);
  const unlock = liftedBy(song, edit, section, part, from, to, root, id);
  const ops = [];
  if (out.length) ops.push({ op: 'note.del', pattern: section, channel: part, ids: out, unlock, edit });
  if (fresh.length) ops.push({ op: 'note.add', pattern: section, channel: part, notes: fresh, unlock, edit });
  if (!ops.length) return { rev: song.rev, changed: [] };
  // one ladder edit for the whole change: delete and add as a single target
  const target = [...old.filter((n) => n.t < from || n.t >= to).map((n) => ({ ...n, vel: n.vel ?? 0.8 })), ...fresh];
  const loaded = loadSong(root, id);
  const block = parseSongFile(loaded.text).blocks.find((x) => x.channel === song.channels.find((c) => c.id === part).midiChannel);
  const row = sectionLayout(song).findIndex((x) => x.id === section);
  const lad = ladderFor(root);
  const r = await lad.edit(block.rows[row].text, target, { bars: p.bars, tpb });
  return aiWrite(root, id, [{ op: 'strudel.set', region: `${section}.${part}`, before: block.rows[row].text, after: r.code, unlock, edit, bars: [a, b] }], { rev, region: `${section}.${part}` });
}

// mfx song strudel m02 ch02 --bars 3-4 --file bars.strudel.js [--edit E012]: Strudel for those bars, put in place with
// the rest of the row kept word for word (the original plays the other bars: Strudel's arrange()).
export async function songWriteStrudel(root, id, { section, part, bars, code, edit = null, rev = null }) {
  const loaded = need(loadSong(root, id));
  const { song, text } = loaded;
  const p = song.patterns.find((x) => x.id === section);
  const c = song.channels.find((x) => x.id === part);
  if (!p || !c) throw new UserError(`there is no part ${part} in ${section}`);
  const tpb = ticksPerBar(song.meter[0]);
  const [a, b] = bars;
  if (a < 1 || b > p.bars || a > b) throw new UserError(`bars ${a}–${b} aren't inside ${section} (bars 1–${p.bars})`);
  const lad = ladderFor(root);
  // the new bars must run on their own first
  const got = await lad.notes(String(code), { bars: b - a + 1, tpb });
  const block = parseSongFile(text).blocks.find((x) => x.channel === c.midiChannel);
  const row = sectionLayout(song).findIndex((x) => x.id === section);
  const before = block.rows[row].text;
  // the wanted notes: the row's own outside the bars, the new code's inside (moved to the bars)
  const old = (p.notes[part] || []).map((n) => ({ ...n, vel: n.vel ?? 0.8 }));
  const target = [...old.filter((n) => n.t < (a - 1) * tpb || n.t >= b * tpb), ...got.notes.map(({ t, len, key, vel }) => ({ t: t + (a - 1) * tpb, len, key, vel }))];
  const r = await lad.edit(before, target, { bars: p.bars, tpb, fill: { from: a, to: b, code: String(code) } });
  const unlock = liftedBy(song, edit, section, part, (a - 1) * tpb, b * tpb, root, id);
  return aiWrite(root, id, [{ op: 'strudel.set', region: `${section}.${part}`, before, after: r.code, unlock, edit, bars: [a, b] }], { rev, region: `${section}.${part}` });
}

// mfx song ops <ops.json> [--edit E012]: a batch, all or nothing.
export async function songWriteOps(root, id, { ops, edit = null, rev = null }) {
  const { song } = need(loadSong(root, id));
  if (!Array.isArray(ops) || !ops.length) throw new UserError('ops must be a list of operations (doc 18 §6)');
  for (const o of ops) if (o.region || o.pattern) checkRev(song, o.region || `${o.pattern}.${o.channel}`, rev);
  return aiWrite(root, id, ops.map((o) => ({ ...o, edit })), { rev: null, region: null });
}

export async function songImport(root, id) {
  const r = await importProjectSong(root, id);
  return { rev: r.rev, version: r.version.v, sections: r.song.patterns.length, parts: r.song.channels.length, warnings: r.warnings };
}
