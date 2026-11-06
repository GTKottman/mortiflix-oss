// The song (doc 18): one JSON file per project, music/song.json, holding everything the mini DAW plays. The notes in
// it are a cache worked out from music/song.strudel.js (doc 28); everything else (channels, playlist, audio, mixer,
// automation, markers, locks) is kept here. Only the studio server writes it, through this module.
//
// Time: ticks, whole numbers, 960 per quarter note. Music is placed in ticks; narration and effects in seconds (they
// belong to the video). Only fields that differ from their defaults are written, so the file stays small, and notes are
// written one per line so two versions diff cleanly.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PPQ = 960;
export const FORMAT = 'mortiflix.song';
export const VERSION = 1;

// Note fields: range and default (doc 18 §3.2). A default isn't written.
export const NOTE_FIELDS = {
  t: { int: true, min: 0 }, len: { int: true, min: 1 }, key: { int: true, min: 0, max: 127 },
  vel: { min: 0, max: 1, def: 0.8 }, rel: { min: 0, max: 1, def: 0.5 }, pan: { min: -1, max: 1, def: 0 },
  fine: { int: true, min: -1200, max: 1200, def: 0 }, modX: { min: 0, max: 1, def: 0.5 }, modY: { min: 0, max: 1, def: 0.5 },
  slide: { bool: true, def: false }, porta: { bool: true, def: false },
};

export function emptySong({ title = 'Untitled', bpm = 120, num = 4, den = 4, offsetSec = 0, scale = null } = {}) {
  return {
    format: FORMAT, version: VERSION, rev: 0, title, ppq: PPQ, sampleRate: 48000, offsetSec,
    tempo: [{ tick: 0, bpm, shape: 'jump' }], meter: [{ bar: 1, num, den }], scale,
    channels: [], patterns: [], playlist: { tracks: [], items: [] }, audio: [], automation: [], controllers: [],
    mixer: { inserts: [], master: { plugins: [], volDb: 0 } }, markers: [], loop: null, locks: [], strudel: { regions: {} },
  };
}

// Ticks per bar for a meter: 960 × 4 × num / den (3840 in 4/4, 2880 in 6/8).
export const ticksPerBar = ({ num = 4, den = 4 } = {}) => PPQ * 4 * num / den;

// Where each pattern sits: [{ id, startBar (1-based), bars, startTick, ticks }] in playlist order of the "Music" items.
export function sectionLayout(song) {
  const tpb = ticksPerBar(song.meter?.[0]);
  const items = (song.playlist?.items || []).filter((i) => i.kind === 'pattern').sort((a, b) => (a.at?.tick ?? 0) - (b.at?.tick ?? 0));
  return items.map((i) => ({ id: i.ref, item: i.id, startTick: i.at.tick, ticks: i.len, startBar: i.at.tick / tpb + 1, bars: i.len / tpb }));
}

// ---------- checking ----------

// Plain-words errors; an empty list means the song can be saved. `dir` (the project's music folder) lets blob
// references be checked against music/daw/blobs/<sha256>.bin.
export function checkSong(song, { dir = null } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!song || typeof song !== 'object') return ['the song is not a JSON object'];
  if (song.format !== FORMAT) err(`"format" must be "${FORMAT}"`);
  if (song.version !== VERSION) err(`"version" must be ${VERSION}`);
  if (!Number.isInteger(song.rev) || song.rev < 0) err('"rev" must be a whole number ≥ 0');
  if (song.ppq !== PPQ) err(`"ppq" must be ${PPQ}`);
  if (song.sampleRate !== 48000) err('"sampleRate" must be 48000 (one rate end to end)');
  const isInt = (v) => Number.isInteger(v);

  // maps: sorted, sensible
  if (!Array.isArray(song.tempo) || !song.tempo.length || song.tempo[0].tick !== 0) err('the tempo map must start at tick 0');
  (song.tempo || []).forEach((p, i, a) => {
    if (!isInt(p.tick) || p.tick < 0) err(`tempo point ${i + 1}: "tick" must be a whole number ≥ 0`);
    if (!(p.bpm >= 20 && p.bpm <= 400)) err(`tempo point ${i + 1}: "bpm" must be 20–400`);
    if (!['jump', 'linear'].includes(p.shape ?? 'jump')) err(`tempo point ${i + 1}: "shape" must be jump or linear`);
    if (i && p.tick <= a[i - 1].tick) err('the tempo map must be sorted by tick, one point per tick');
  });
  if (!Array.isArray(song.meter) || !song.meter.length || song.meter[0].bar !== 1) err('the meter map must start at bar 1');
  (song.meter || []).forEach((m, i, a) => {
    if (!isInt(m.bar) || m.bar < 1) err(`meter ${i + 1}: "bar" must be a whole number ≥ 1`);
    if (!(isInt(m.num) && m.num >= 1 && m.num <= 32) || ![1, 2, 4, 8, 16, 32].includes(m.den)) err(`meter ${i + 1}: ${m.num}/${m.den} isn't a usable time signature`);
    if (i && m.bar <= a[i - 1].bar) err('the meter map must be sorted by bar, one change per bar');
  });

  // ids unique across their lists, and every reference resolves
  const ids = (list, what) => {
    const seen = new Set();
    for (const x of list || []) {
      if (!x || typeof x.id !== 'string' || !x.id) { err(`a ${what} has no id`); continue; }
      if (seen.has(x.id)) err(`two ${what}s share the id "${x.id}"`);
      seen.add(x.id);
    }
    return seen;
  };
  const channels = ids(song.channels, 'channel');
  const patterns = ids(song.patterns, 'pattern');
  const tracks = ids(song.playlist?.tracks, 'playlist row');
  ids(song.playlist?.items, 'playlist item');
  const audio = ids(song.audio, 'audio file');
  const automation = ids(song.automation, 'automation clip');
  ids(song.controllers, 'controller');
  const inserts = ids(song.mixer?.inserts, 'mixer insert');
  ids(song.markers, 'marker');
  ids(song.locks, 'lock');

  for (const c of song.channels || []) {
    if (!/^ch\d{2,}$/.test(c.id)) err(`channel "${c.id}": ids are ch01, ch02 …`);
    if (!['instrument', 'drums', 'layer'].includes(c.kind)) err(`channel "${c.id}": "kind" must be instrument, drums or layer`);
    if (c.insert && !inserts.has(c.insert)) err(`channel "${c.id}" goes to mixer insert "${c.insert}", which doesn't exist`);
    if (c.kind === 'layer') for (const l of c.layer || []) if (!channels.has(l)) err(`layer channel "${c.id}" plays "${l}", which doesn't exist`);
    if (c.pan !== undefined && !(c.pan >= -1 && c.pan <= 1)) err(`channel "${c.id}": "pan" must be −1 … 1`);
    if (c.midiChannel !== undefined && !(isInt(c.midiChannel) && c.midiChannel >= 1 && c.midiChannel <= 16)) err(`channel "${c.id}": "midiChannel" must be 1–16`);
  }

  for (const p of song.patterns || []) {
    if (!(isInt(p.bars) && p.bars >= 1)) err(`pattern "${p.id}": "bars" must be a whole number ≥ 1`);
    if (p.copyOf && !patterns.has(p.copyOf)) err(`pattern "${p.id}" is a copy of "${p.copyOf}", which doesn't exist`);
    if (p.sameAs && !patterns.has(p.sameAs)) err(`pattern "${p.id}" has the same notes as "${p.sameAs}", which doesn't exist`);
    for (const [ch, notes] of Object.entries(p.notes || {})) {
      if (!channels.has(ch)) err(`pattern "${p.id}" has notes for "${ch}", which isn't a channel`);
      if (!Array.isArray(notes)) { err(`pattern "${p.id}" › ${ch}: notes must be a list`); continue; }
      notes.forEach((n, i) => {
        const where = `pattern "${p.id}" › ${ch} note ${i + 1}`;
        for (const k of ['t', 'len', 'key']) if (n[k] === undefined) err(`${where}: "${k}" is missing`);
        for (const [k, v] of Object.entries(n)) {
          const f = NOTE_FIELDS[k];
          if (!f) { err(`${where}: "${k}" isn't a note field`); continue; }
          if (f.bool) { if (typeof v !== 'boolean') err(`${where}: "${k}" must be true or false`); continue; }
          if (typeof v !== 'number' || !Number.isFinite(v)) { err(`${where}: "${k}" must be a number`); continue; }
          if (f.int && !isInt(v)) err(`${where}: "${k}" must be a whole number${k === 't' || k === 'len' ? ' of ticks' : ''}`);
          if (f.min !== undefined && v < f.min) err(`${where}: "${k}" ${v} is under ${f.min}`);
          if (f.max !== undefined && v > f.max) err(`${where}: "${k}" ${v} is over ${f.max}`);
        }
      });
    }
  }

  for (const i of song.playlist?.items || []) {
    if (!tracks.has(i.track)) err(`playlist item "${i.id}" is on row "${i.track}", which doesn't exist`);
    if (i.kind === 'pattern') {
      if (!patterns.has(i.ref)) err(`playlist item "${i.id}" plays pattern "${i.ref}", which doesn't exist`);
      if (!isInt(i.at?.tick) || i.at.tick < 0) err(`playlist item "${i.id}": "at.tick" must be a whole number ≥ 0`);
      if (!isInt(i.len) || i.len < 1) err(`playlist item "${i.id}": "len" must be a whole number of ticks ≥ 1`);
      if (i.offset !== undefined && !isInt(i.offset)) err(`playlist item "${i.id}": "offset" must be whole ticks`);
    } else if (i.kind === 'audio') {
      if (!audio.has(i.ref)) err(`playlist item "${i.id}" plays audio "${i.ref}", which doesn't exist`);
      if (!(i.at?.sec >= 0)) err(`playlist item "${i.id}": audio is placed in seconds ("at.sec" ≥ 0)`);
    } else if (i.kind === 'automation') {
      if (!automation.has(i.ref)) err(`playlist item "${i.id}" plays automation "${i.ref}", which doesn't exist`);
    } else err(`playlist item "${i.id}": "kind" must be pattern, audio or automation`);
  }

  for (const a of song.audio || []) {
    if (typeof a.file !== 'string' || a.file.startsWith('/') || a.file.includes('..')) err(`audio "${a.id}": "file" must be a path inside the project`);
  }
  for (const x of song.mixer?.inserts || []) {
    if (x.out && x.out !== 'master' && !inserts.has(x.out)) err(`mixer insert "${x.id}" goes to "${x.out}", which doesn't exist`);
    for (const s of x.sends || []) if (!inserts.has(s.to)) err(`mixer insert "${x.id}" sends to "${s.to}", which doesn't exist`);
  }
  for (const m of song.markers || []) if (!isInt(m.tick) || m.tick < 0) err(`marker "${m.id}": "tick" must be a whole number ≥ 0`);
  if (song.loop && !(isInt(song.loop.fromTick) && isInt(song.loop.toTick) && song.loop.toTick > song.loop.fromTick)) err('the loop must run from a whole tick to a later one');
  for (const l of song.locks || []) {
    const s = l.scope || {};
    if (s.pattern && !patterns.has(s.pattern)) err(`lock "${l.id}" is on pattern "${s.pattern}", which doesn't exist`);
    if (s.channel && !channels.has(s.channel)) err(`lock "${l.id}" is on channel "${s.channel}", which doesn't exist`);
    if (!['hand', 'ok'].includes(l.by)) err(`lock "${l.id}": "by" must be hand or ok`);
  }

  // blobs (plugin states): every one referenced exists and matches its hash
  if (dir) {
    const blobs = new Set();
    JSON.stringify(song, (k, v) => { if (k === 'blob' && typeof v === 'string') blobs.add(v); return v; });
    for (const sha of blobs) {
      const f = join(dir, 'daw', 'blobs', `${sha}.bin`);
      if (!existsSync(f)) err(`blob ${sha.slice(0, 12)}… is missing from music/daw/blobs`);
      else if (createHash('sha256').update(readFileSync(f)).digest('hex') !== sha) err(`blob ${sha.slice(0, 12)}… doesn't match its hash`);
    }
  }
  return errors;
}

// ---------- writing ----------

// A note with its defaults left out, keys in a fixed order.
export function compactNote(n) {
  const out = {};
  for (const [k, f] of Object.entries(NOTE_FIELDS)) {
    if (n[k] === undefined) continue;
    if (f.def !== undefined && n[k] === f.def) continue;
    out[k] = n[k];
  }
  return out;
}

// JSON with every note on its own line (and the rest indented by 1), so versions diff line by line.
export function writeSong(song) {
  const lines = [];
  const isNotes = (v) => Array.isArray(v) && v.length > 0 && v.every((n) => n && typeof n === 'object' && 't' in n && 'key' in n);
  const text = JSON.stringify(song, (k, v) => {
    if (!isNotes(v)) return v;
    return v.map((n) => { lines.push(JSON.stringify(compactNote(n))); return `@@note${lines.length - 1}@@`; });
  }, 1);
  return text.replace(/"@@note(\d+)@@"/g, (_, i) => lines[Number(i)]) + '\n';
}

export const readSong = (text) => JSON.parse(text);
