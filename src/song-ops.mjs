// Operations: the only way the song changes (doc 18 §5–6, doc 28 §3.4). The UI, `mfx`, imports and undo all send the
// same ops: { op, ...args, by: 'hand' | 'ai' | 'import', edit? }. Note ops become text edits of the section's row in
// song.strudel.js through the edit ladder (the original kept word for word, the changed bars hard-coded in plain
// Strudel), so the notes always come from the text. Locks keep the AI off what the owner touched or approved; every
// change records its inverse for undo (music/daw/undo.jsonl).
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSong, saveSong, songPaths, strudelDirOf } from './song-store.mjs';
import { ticksPerBar, sectionLayout } from './song.mjs';
import { parseSongFile, setRow, replaceRow, renumberRows, retimeMusic } from './strudel/songfile.mjs';
import { createStrudel } from './strudel/edit.mjs';
import { UserError } from './studio.mjs';

const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const noteName = (n) => `${n.t}:${n.key}:${n.len}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

// One shared ladder per process (its evaluator is a locked-down child process).
let shared = null;
export function ladderFor(root) {
  if (!shared) shared = createStrudel({ strudelDir: strudelDirOf(root), timeoutMs: 4000 });
  return shared;
}
export function closeLadder() { shared?.close(); shared = null; }

// The locks an op would touch (for 'ai' and 'import' ops). Bars are 1-based in messages, ticks inside.
function blockingLocks(song, op, scope) {
  return (song.locks || []).filter((l) => {
    const s = l.scope || {};
    if (scope.pattern && s.pattern && s.pattern !== scope.pattern) return false;
    if (scope.channel && s.channel && s.channel !== scope.channel) return false;
    if (s.fromTick !== undefined && scope.fromTick !== undefined && (scope.toTick <= s.fromTick || scope.fromTick >= s.toTick)) return false;
    if (s.plugin || s.insert || s.automation || s.item || s.controller) return Object.entries(s).every(([k, v]) => scope[k] === v);
    return Boolean(s.pattern || s.channel);
  }).filter((l) => !(op.unlock || []).includes(l.id));
}
function lockWords(song, l) {
  const s = l.scope || {};
  const tpb = ticksPerBar(song.meter[0]);
  const ch = song.channels.find((c) => c.id === s.channel);
  const bars = s.fromTick !== undefined ? ` bars ${s.fromTick / tpb + 1}–${s.toTick / tpb}` : '';
  return `${s.pattern || ''} ${ch?.name || s.channel || ''}${bars} ${l.by === 'ok' ? 'were OK\'d' : 'are hand-edited'} (${l.id})`.replace(/\s+/g, ' ').trim();
}

// Adds a hand lock over whole bars, merged with the pattern × channel's touching locks.
function addHandLock(song, pattern, channel, fromTick, toTick, rev) {
  const near = song.locks.filter((l) => l.by === 'hand' && l.scope.pattern === pattern && l.scope.channel === channel && l.scope.fromTick !== undefined && l.scope.fromTick <= toTick && fromTick <= l.scope.toTick);
  for (const l of near) { fromTick = Math.min(fromTick, l.scope.fromTick); toTick = Math.max(toTick, l.scope.toTick); }
  song.locks = song.locks.filter((l) => !near.includes(l));
  const n = Math.max(0, ...song.locks.map((l) => Number(String(l.id).slice(1)) || 0)) + 1;
  const lock = { id: `L${String(n).padStart(3, '0')}`, scope: { pattern, channel, fromTick, toTick }, by: 'hand', at: new Date().toISOString(), rev };
  song.locks.push(lock);
  return { added: lock, removed: near };
}

// Bars (0-based, in the section) where two note lists differ.
function changedBars(a, b, tpb) {
  const k = (n) => `${n.t}|${n.len}|${n.key}|${n.vel ?? 0.8}`;
  const A = new Set(a.map(k)); const B = new Set(b.map(k));
  const out = new Set();
  for (const n of a) if (!B.has(k(n))) out.add(Math.floor(n.t / tpb));
  for (const n of b) if (!A.has(k(n))) out.add(Math.floor(n.t / tpb));
  return [...out].sort((x, y) => x - y);
}

// Applies a batch. Returns { rev, applied: [ops], refused: [{ op, why }], inverse: [ops] }.
// Lock refusals refuse only that op ("the rest goes through"); any other error refuses the whole batch.
export async function applyOps(root, id, opsIn, { ladder = null } = {}) {
  let ops = opsIn;
  const loaded = loadSong(root, id);
  if (!loaded) throw new UserError('no song yet: import the score first (mortiflix music <project> --song)');
  const song = clone(loaded.song);
  let text = loaded.text;
  const tpb = ticksPerBar(song.meter[0]);
  const layout = sectionLayout(song);
  const rowOf = (pattern) => layout.findIndex((x) => x.id === pattern);
  const applied = []; const refused = []; const inverse = [];
  let pendingMeta = null;   // music/daw/notes-meta.json while a batch mutes or unmutes notes
  const rev = song.rev + 1;

  ops = [...ops];
  for (let oi = 0; oi < ops.length; oi++) {
    const op0 = ops[oi];
    const op = { by: 'hand', ...op0 };
    if (!['hand', 'ai', 'import'].includes(op.by)) throw new UserError(`"by" must be hand, ai or import (got ${op.by})`);

    // ---- notes: through the ladder into the row's text ----
    // the kept list of muted notes, on its own (undo of a mute or unmute; the text is put back by its own step)
    if (op.op === 'meta.drop' || op.op === 'meta.add') {
      const metaFile = join(songPaths(root, id).music, 'daw', 'notes-meta.json');
      const meta = pendingMeta ?? (existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : { muted: [] });
      pendingMeta = meta;
      const k = (n) => `${n.t}|${n.key}|${n.len}`;
      const these = new Set(op.notes.map(k));
      if (op.op === 'meta.drop') meta.muted = meta.muted.filter((m) => !(m.pattern === op.pattern && m.channel === op.channel && these.has(k(m.note))));
      else meta.muted.push(...op.notes.map((n) => ({ pattern: op.pattern, channel: op.channel, note: n })));
      applied.push(op);
      continue;
    }
    if (['note.add', 'note.set', 'note.del', 'note.replace', 'strudel.set'].includes(op.op)) {
      const [pattern, channel] = op.op === 'strudel.set' ? String(op.region || '').split('.') : [op.pattern, op.channel];
      const p = song.patterns.find((x) => x.id === pattern);
      const c = song.channels.find((x) => x.id === channel);
      if (!p || !c) throw new UserError(`there is no pattern ${pattern} with channel ${channel}`);
      const row = rowOf(pattern);
      const block = parseSongFile(text).blocks.find((b) => b.channel === c.midiChannel);
      if (!block || !block.rows[row]) throw new UserError(`song.strudel.js has no row for ${pattern} in ${c.name}`);
      const before = block.rows[row].text;
      // the file leaves defaults out: velocity 0.8 is put back before comparing
      const old = (p.notes[channel] || []).map((n) => ({ ...n, vel: n.vel ?? 0.8 }));
      let wanted = null; let after = null;
      if (op.op === 'strudel.set') {
        if (op.before !== undefined && op.before !== before) throw new UserError(`${pattern} ${c.name} changed since it was read: read it again`);
        after = String(op.after);
      } else {
        const byName = new Map(old.map((n) => [noteName(n), n]));
        if (op.op === 'note.add') wanted = [...old, ...(op.notes || []).map((n) => ({ t: n.t, len: n.len, key: n.key, vel: n.vel ?? 0.8 }))];
        if (op.op === 'note.replace') wanted = (op.notes || []).map((n) => ({ t: n.t, len: n.len, key: n.key, vel: n.vel ?? 0.8 }));
        if (op.op === 'note.del') { for (const nm of op.ids || []) if (!byName.has(nm)) throw new UserError(`${pattern} ${c.name} has no note ${nm}`); wanted = old.filter((n) => !(op.ids || []).includes(noteName(n))); }
        if (op.op === 'note.set') {
          for (const nm of op.ids || []) if (!byName.has(nm)) throw new UserError(`${pattern} ${c.name} has no note ${nm}`);
          wanted = old.map((n) => ((op.ids || []).includes(noteName(n)) ? { ...n, ...op.fields } : n));
        }
        for (const n of wanted) {
          if (!Number.isInteger(n.t) || n.t < 0 || n.t >= p.bars * tpb) throw new UserError(`a note at tick ${n.t} is outside ${pattern} (${p.bars} bars)`);
          if (!Number.isInteger(n.key) || n.key < 0 || n.key > 127) throw new UserError(`key ${n.key} is outside MIDI's 0–127`);
          if (!Number.isInteger(n.len) || n.len < 1) throw new UserError('a note needs a length of at least 1 tick');
        }
      }
      let notes;
      const lad = ladder || ladderFor(root);
      if (wanted) {
        const r = await lad.edit(before, wanted, { bars: p.bars, tpb });
        after = r.code; notes = r.notes;
      } else {
        notes = (await lad.notes(after, { bars: p.bars, tpb })).notes;
      }
      notes = notes.map(({ t, len, key, vel, fine }) => ({ t, len, key, vel, ...(fine ? { fine } : {}) }));
      // locks are checked against the bars that really change
      const touched = changedBars(old, notes, tpb);
      if (op.by !== 'hand' && touched.length) {
        const hit = blockingLocks(song, op, { pattern, channel, fromTick: touched[0] * tpb, toTick: (touched.at(-1) + 1) * tpb });
        if (hit.length) { refused.push({ op, why: hit.map((l) => lockWords(song, l)).join('; ') }); continue; }
      }
      text = setRow(text, c.midiChannel, row, after);
      // the row as it now stands in the file (new lines are indented under it): what undo must find there
      after = parseSongFile(text).blocks.find((b) => b.channel === c.midiChannel).rows[row].text;
      if (notes.length) p.notes[channel] = notes; else delete p.notes[channel];
      song.strudel.regions[`${pattern}.${channel}`] = { sha: sha16(after), rev, by: op.undo ? 'hand' : op.by };
      inverse.unshift({ op: 'strudel.set', region: `${pattern}.${channel}`, before: after, after: before, by: 'hand', undo: true });
      if (op.by === 'hand' && !op.undo && touched.length) {
        const { added, removed } = addHandLock(song, pattern, channel, touched[0] * tpb, (touched.at(-1) + 1) * tpb, rev);
        inverse.unshift({ op: 'lock.restore', remove: added.id, put: removed, undo: true });
      }
      applied.push({ ...op, region: `${pattern}.${channel}`, before, after });
      continue;
    }

    // ---- a section's bars: Cut it, Repeat, + bars (doc 19 §2): every part's row, in plain Strudel ----
    if (op.op === 'section.time') {
      const p = song.patterns.find((x) => x.id === op.section);
      if (!p) throw new UserError(`there is no section ${op.section}`);
      const len = p.bars;
      const { kind } = op;
      const from = Number(op.from); const to = Number(op.to ?? op.from); const n = Number(op.n); const at = Number(op.at);
      if (kind === 'cut' || kind === 'repeat') {
        if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from && to <= len)) throw new UserError(`bars ${from}–${to} aren't inside ${op.section} (1–${len})`);
        if (kind === 'cut' && to - from + 1 >= len) throw new UserError(`that would cut all of ${op.section}: remove the section instead`);
      } else if (kind === 'add') {
        if (!(Number.isInteger(n) && n >= 1 && n <= 64 && Number.isInteger(at) && at >= 1 && at <= len + 1)) throw new UserError('add needs n (1–64) bars at a bar inside the section (or one past its end)');
      } else throw new UserError('kind must be cut, repeat or add');
      if (op.by !== 'hand') {
        const hit = blockingLocks(song, op, { pattern: op.section });
        if (hit.length) { refused.push({ op, why: hit.map((l) => lockWords(song, l)).join('; ') }); continue; }
      }
      inverse.unshift({ op: 'song.restore', text, fields: clone({ patterns: song.patterns, playlist: song.playlist, markers: song.markers, locks: song.locks, strudel: song.strudel }), by: 'hand', undo: true });
      const delta = kind === 'cut' ? -(to - from + 1) : kind === 'repeat' ? to - from + 1 : n;
      const newLen = len + delta;
      const row = rowOf(op.section);
      const startTick = layout[row].startTick;
      const lad = ladder || ladderFor(root);
      // each part's row: rewritten, then its notes read from the new text
      for (const blk of parseSongFile(text).blocks) {
        const c = song.channels.find((x) => x.midiChannel === blk.channel);
        const music = retimeMusic(blk.rows[row].text, len, { kind, from, to, n, at });
        text = replaceRow(text, blk.channel, row, newLen, music);
        if (!c) continue;
        const notes = music === 'silence' ? [] : (await lad.notes(music, { bars: newLen, tpb })).notes.map(({ t, len: l, key, vel, fine }) => ({ t, len: l, key, vel, ...(fine ? { fine } : {}) }));
        if (notes.length) p.notes[c.id] = notes; else delete p.notes[c.id];
        song.strudel.regions[`${op.section}.${c.id}`] = { sha: sha16(music), rev, by: op.by };
      }
      p.bars = newLen;
      // the playlist ripples: this section's length, everything after it moves
      for (const it of song.playlist.items) {
        if (it.kind === 'pattern' && it.ref === op.section) it.len = newLen * tpb;
        else if (it.at?.tick !== undefined && it.at.tick > startTick) it.at.tick += delta * tpb;
      }
      // markers after the change move with the music; locks inside a cut go, later ones move
      const edge = startTick + (kind === 'add' ? (at - 1) : kind === 'repeat' ? to : (to)) * tpb;
      for (const m of song.markers) {
        if (m.tick >= edge) m.tick += delta * tpb;
        else if (kind === 'cut' && m.tick >= startTick + (from - 1) * tpb) m.tick = startTick + (from - 1) * tpb;
      }
      const localEdge = edge - startTick;
      song.locks = song.locks.filter((l) => {
        if (l.scope.pattern !== op.section || l.scope.fromTick === undefined) return true;
        if (kind === 'cut' && l.scope.fromTick >= (from - 1) * tpb && l.scope.toTick <= to * tpb) return false;
        if (l.scope.fromTick >= localEdge) { l.scope.fromTick += delta * tpb; l.scope.toTick += delta * tpb; }
        return true;
      });
      const sections = sectionLayout(song).map((x) => ({ id: x.id, name: song.patterns.find((q) => q.id === x.id)?.name, bars: x.bars }));
      text = renumberRows(text, sections);
      // the bars the owner made (a repeat's copy, added bars) are locked as hand edits; a cut leaves nothing to lock
      if (op.by === 'hand' && kind !== 'cut') {
        const [na, nb] = kind === 'repeat' ? [to, to + (to - from + 1)] : [at - 1, at - 1 + n];
        for (const c of song.channels) addHandLock(song, op.section, c.id, na * tpb, nb * tpb, rev);
      }
      applied.push(op);
      continue;
    }
    if (op.op === 'song.restore') {
      text = op.text;
      Object.assign(song, clone(op.fields));
      applied.push({ op: 'song.restore' });
      continue;
    }

    // ---- Mute a part: those notes stop playing (they leave the text) but are kept, to come back (doc 18 §3.2) ----
    if (op.op === 'note.mute' || op.op === 'note.unmute') {
      const p = song.patterns.find((x) => x.id === op.pattern);
      const c = song.channels.find((x) => x.id === op.channel);
      if (!p || !c) throw new UserError(`there is no pattern ${op.pattern} with channel ${op.channel}`);
      const metaFile = join(songPaths(root, id).music, 'daw', 'notes-meta.json');
      const meta = pendingMeta ?? (existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : { muted: [] });
      pendingMeta = meta;
      const tpbL = tpb;
      let target;
      if (op.op === 'note.mute') {
        const [a, b] = op.bars;
        const inBars = (n) => n.t >= (a - 1) * tpbL && n.t < b * tpbL;
        const old = (p.notes[c.id] || []).map((n) => ({ ...n, vel: n.vel ?? 0.8 }));
        const muting = old.filter(inBars);
        if (!muting.length) { applied.push(op); continue; }
        meta.muted.push(...muting.map((n) => ({ pattern: op.pattern, channel: c.id, note: n })));
        target = old.filter((n) => !inBars(n));
        inverse.unshift({ op: 'meta.drop', pattern: op.pattern, channel: c.id, notes: muting, undo: true });
      } else {
        const back = op.notes || meta.muted.filter((m) => m.pattern === op.pattern && m.channel === c.id && (!op.bars || (m.note.t >= (op.bars[0] - 1) * tpbL && m.note.t < op.bars[1] * tpbL))).map((m) => m.note);
        const key = (n) => `${n.t}|${n.key}|${n.len}`;
        const backKeys = new Set(back.map(key));
        meta.muted = meta.muted.filter((m) => !(m.pattern === op.pattern && m.channel === c.id && backKeys.has(key(m.note))));
        target = [...(p.notes[c.id] || []).map((n) => ({ ...n, vel: n.vel ?? 0.8 })), ...back];
        inverse.unshift({ op: 'meta.add', pattern: op.pattern, channel: c.id, notes: back, undo: true });
      }
      // the text change goes through the ladder like any note edit
      // the notes leave (or come back to) the text through the ladder: a hand edit, so it locks its bars
      ops.splice(oi + 1, 0, { op: 'note.replace', pattern: op.pattern, channel: c.id, notes: target, by: op.by, undo: Boolean(op.undo) });
      applied.push(op);
      continue;
    }

    // ---- locks ----
    if (op.op === 'lock.add') {
      const n = Math.max(0, ...song.locks.map((l) => Number(String(l.id).slice(1)) || 0)) + 1;
      const lock = { id: `L${String(n).padStart(3, '0')}`, scope: op.scope, by: op.lockBy || 'ok', at: new Date().toISOString(), rev };
      song.locks.push(lock);
      inverse.unshift({ op: 'lock.del', id: lock.id, undo: true });
      applied.push({ ...op, id: lock.id });
      continue;
    }
    if (op.op === 'lock.del') {
      const l = song.locks.find((x) => x.id === op.id);
      if (!l) throw new UserError(`there is no lock ${op.id}`);
      song.locks = song.locks.filter((x) => x !== l);
      inverse.unshift({ op: 'lock.restore', remove: null, put: [l], undo: true });
      applied.push(op);
      continue;
    }
    if (op.op === 'lock.restore') {
      song.locks = song.locks.filter((x) => x.id !== op.remove).concat(op.put || []);
      applied.push(op);
      continue;
    }

    // ---- fields: patterns, channels, playlist items, mixer inserts, markers, maps ----
    const lists = { 'pattern.set': song.patterns, 'channel.set': song.channels, 'item.set': song.playlist.items, 'insert.set': song.mixer.inserts, 'marker.set': song.markers };
    if (lists[op.op]) {
      const x = lists[op.op].find((y) => y.id === op.id);
      if (!x) throw new UserError(`there is no ${op.op.split('.')[0]} ${op.id}`);
      if (op.by !== 'hand') {
        const kind = op.op.split('.')[0];
        const hit = blockingLocks(song, op, kind === 'pattern' ? { pattern: op.id } : kind === 'channel' ? { channel: op.id } : { [kind]: op.id });
        if (hit.length) { refused.push({ op, why: hit.map((l) => lockWords(song, l)).join('; ') }); continue; }
      }
      const prev = Object.fromEntries(Object.keys(op.fields || {}).map((k) => [k, x[k] === undefined ? null : clone(x[k])]));
      if ('notes' in (op.fields || {}) || 'id' in (op.fields || {})) throw new UserError('notes and ids are not changed this way');
      for (const [k, v] of Object.entries(op.fields || {})) { if (v === null) delete x[k]; else x[k] = v; }
      inverse.unshift({ op: op.op, id: op.id, fields: prev, by: 'hand', undo: true });
      applied.push(op);
      continue;
    }
    if (op.op === 'marker.add') {
      const n = Math.max(0, ...song.markers.map((m) => Number(String(m.id).replace(/\D/g, '')) || 0)) + 1;
      const m = { id: `k${String(n).padStart(2, '0')}`, kind: 'marker', from: op.by === 'hand' ? 'owner' : 'ai', ...op.marker };
      song.markers.push(m);
      inverse.unshift({ op: 'marker.del', id: m.id, undo: true });
      applied.push({ ...op, id: m.id });
      continue;
    }
    if (op.op === 'marker.del') {
      const m = song.markers.find((x) => x.id === op.id);
      if (!m) throw new UserError(`there is no marker ${op.id}`);
      song.markers = song.markers.filter((x) => x !== m);
      inverse.unshift({ op: 'marker.add', marker: m, by: 'hand', undo: true });
      applied.push(op);
      continue;
    }
    if (op.op === 'loop.set' || op.op === 'tempo.set' || op.op === 'meter.set') {
      const key = op.op.split('.')[0];
      inverse.unshift({ op: op.op, value: clone(song[key]), by: 'hand', undo: true });
      song[key] = op.value;
      applied.push(op);
      continue;
    }
    throw new UserError(`unknown operation "${op.op}"`);
  }

  if (!applied.length) return { rev: song.rev, applied, refused, inverse: [] };
  const saved = saveSong(root, id, song, text);
  if (pendingMeta) { const f = join(songPaths(root, id).music, 'daw', 'notes-meta.json'); mkdirSync(join(songPaths(root, id).music, 'daw'), { recursive: true }); writeFileSync(f, JSON.stringify(pendingMeta, null, 1) + '\n'); }
  // the undo log: one line per batch, newest last
  const sp = songPaths(root, id);
  mkdirSync(join(sp.music, 'daw'), { recursive: true });
  if (!ops.every((o) => o.undo)) appendFileSync(join(sp.music, 'daw', 'undo.jsonl'), JSON.stringify({ rev: saved, at: new Date().toISOString(), ops: inverse }) + '\n');
  return { rev: saved, applied, refused, inverse };
}

// Undo the last batch: its inverse ops, applied by hand (adding no locks of their own).
export async function undo(root, id, opts = {}) {
  const f = join(songPaths(root, id).music, 'daw', 'undo.jsonl');
  const lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
  if (!lines.length) throw new UserError('nothing to undo');
  const last = JSON.parse(lines.pop());
  const r = await applyOps(root, id, last.ops.map((o) => ({ ...o, undo: true })), opts);
  writeFileSync(f, lines.length ? lines.join('\n') + '\n' : '');
  return r;
}
