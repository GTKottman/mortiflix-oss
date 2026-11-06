// Where a project's song lives and how it's saved (doc 18 §1): music/song.json and music/song.strudel.js, written only
// by the studio, atomically (temp file + rename) under one lock, and only when checkSong passes.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { projectPaths } from './projects.mjs';
import { withLock, UserError } from './studio.mjs';
import { toolsDir } from './setup.mjs';
import { checkSong, writeSong, readSong } from './song.mjs';
import { importScore, songFromNotes } from './song-import.mjs';
import { createEvaluator } from './strudel/evaluator.mjs';
import { parseSongFile } from './strudel/songfile.mjs';
import { parseChord } from '../pipelines/_shared/skills/music/lib/harmony.mjs';

export function songPaths(root, id) {
  const music = join(projectPaths(root, id).work, 'music');
  return { music, song: join(music, 'song.json'), strudel: join(music, 'song.strudel.js'), lock: join(music, '.song.lock'),
    blobs: join(music, 'daw', 'blobs'), versions: join(music, 'daw', 'versions'), audio: join(music, 'daw', 'audio'),
    blueprint: join(music, 'blueprint.json'), notes: join(music, 'notes.json'), instruments: join(music, 'instruments.json'), score: join(music, 'score.strudel.js') };
}

const atomic = (file, text) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };

export function loadSong(root, id) {
  const sp = songPaths(root, id);
  if (!existsSync(sp.song)) return null;
  return { song: readSong(readFileSync(sp.song, 'utf8')), text: existsSync(sp.strudel) ? readFileSync(sp.strudel, 'utf8') : null };
}

// Who wants to know when a song is saved (the sound engine reloads it: song.patch).
const savedListeners = new Set();
export function onSongSaved(fn) { savedListeners.add(fn); return () => savedListeners.delete(fn); }

// Saves both files; the song's rev goes up by one. Refuses a song that fails its check.
export function saveSong(root, id, song, text) {
  const sp = songPaths(root, id);
  mkdirSync(sp.music, { recursive: true });
  return withLock(sp.lock, () => {
    const errors = checkSong(song, { dir: sp.music });
    if (errors.length) throw new UserError(`the song can't be saved: ${errors.slice(0, 3).join('; ')}`);
    const prev = existsSync(sp.song) ? readSong(readFileSync(sp.song, 'utf8')).rev : 0;
    song.rev = prev + 1;
    if (text !== undefined) atomic(sp.strudel, text);
    atomic(sp.song, writeSong(song));
    for (const fn of savedListeners) { try { fn(root, id, song.rev); } catch { /* a listener never stops a save */ } }
    return song.rev;
  });
}

export function strudelDirOf(root) {
  const d = process.env.MFX_STRUDEL || join(toolsDir(root), 'strudel');
  if (!existsSync(join(d, 'node_modules', '@strudel', 'core'))) throw new UserError('Strudel isn\'t installed: mortiflix setup music');
  return d;
}

// The project's checked score → its song. `evaluator` may be shared (the server keeps one); otherwise one is made.
export async function importProjectSong(root, id, { evaluator = null } = {}) {
  const sp = songPaths(root, id);
  for (const [f, what] of [[sp.blueprint, 'the blueprint'], [sp.notes, 'the score\'s notes (they come when the score passes its check)']]) if (!existsSync(f)) throw new UserError(`no song yet: ${what} ${f === sp.notes ? '' : 'is missing'}`.trim());
  const rd = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
  const ev = evaluator || createEvaluator({ strudelDir: strudelDirOf(root) });
  try {
    const r = await importScore({ blueprint: JSON.parse(rd(sp.blueprint)), notes: JSON.parse(rd(sp.notes)), instruments: rd(sp.instruments) ? JSON.parse(rd(sp.instruments)) : null,
      evaluator: ev, sources: { score: rd(sp.score), notes: rd(sp.notes), blueprint: rd(sp.blueprint) } });
    const rev = saveSong(root, id, r.song, r.text);
    const version = makeVersion(root, id, { by: 'import', why: 'imported from the checked score' });
    return { ...r, rev, version, paths: sp };
  } finally { if (!evaluator) ev.close(); }
}

// What the song lane draws (doc 19 §6): the song, or before the first import a draft made from the blueprint and the
// score's notes (read-only, no Strudel needed). null when there is no score yet.
export function songView(root, id) {
  const saved = loadSong(root, id);
  if (saved) return { draft: false, song: saved.song, ...extras(root, id, saved) };
  const sp = songPaths(root, id);
  if (!existsSync(sp.blueprint) || !existsSync(sp.notes)) return null;
  try {
    const rd = (f) => JSON.parse(readFileSync(f, 'utf8'));
    const { song, text } = songFromNotes({ blueprint: rd(sp.blueprint), notes: rd(sp.notes), instruments: existsSync(sp.instruments) ? rd(sp.instruments) : null });
    return { draft: true, song, ...extras(root, id, { song, text }) };
  } catch (e) { return { draft: true, song: null, error: e.message }; }
}

// ---- versions (doc 18 §8): a full copy of song.json and song.strudel.js (and notes-meta.json) per version, a line in
// music/daw/versions/index.json each. Blobs are shared by hash, never copied. Going back makes a new version equal to
// the old one: history is never rewritten.

const vname = (v) => `v${String(v).padStart(4, '0')}`;

export function listVersions(root, id) {
  const f = join(songPaths(root, id).versions, 'index.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}

// by: import | ai | hand | ok | render; why: plain words; edit: the edit request id, if any.
export function makeVersion(root, id, { by, why = '', edit = null } = {}) {
  const sp = songPaths(root, id);
  if (!existsSync(sp.song)) throw new UserError('no song yet');
  return withLock(sp.lock, () => {
    mkdirSync(sp.versions, { recursive: true });
    const list = listVersions(root, id);
    const v = (list.at(-1)?.v || 0) + 1;
    const songText = readFileSync(sp.song, 'utf8');
    atomic(join(sp.versions, `${vname(v)}.json`), songText);
    if (existsSync(sp.strudel)) atomic(join(sp.versions, `${vname(v)}.strudel.js`), readFileSync(sp.strudel, 'utf8'));
    const meta = join(sp.music, 'daw', 'notes-meta.json');
    if (existsSync(meta)) atomic(join(sp.versions, `${vname(v)}.notes-meta.json`), readFileSync(meta, 'utf8'));
    const entry = { v, rev: readSong(songText).rev, at: new Date().toISOString(), by, why, edit, sha: createHash('sha256').update(songText).digest('hex').slice(0, 16) };
    list.push(entry);
    atomic(join(sp.versions, 'index.json'), JSON.stringify(list, null, 1) + '\n');
    return entry;
  });
}

// Back to version v: its files become the song again (rev goes on counting), and that is a new version.
export function goBackTo(root, id, v) {
  const sp = songPaths(root, id);
  const entry = listVersions(root, id).find((x) => x.v === Number(v));
  if (!entry) throw new UserError(`there is no version ${v}`);
  const old = readSong(readFileSync(join(sp.versions, `${vname(entry.v)}.json`), 'utf8'));
  const text = existsSync(join(sp.versions, `${vname(entry.v)}.strudel.js`)) ? readFileSync(join(sp.versions, `${vname(entry.v)}.strudel.js`), 'utf8') : undefined;
  const meta = join(sp.versions, `${vname(entry.v)}.notes-meta.json`);
  if (existsSync(meta)) atomic(join(sp.music, 'daw', 'notes-meta.json'), readFileSync(meta, 'utf8'));
  saveSong(root, id, old, text);
  return makeVersion(root, id, { by: 'hand', why: `went back to v${entry.v}` });
}

// What the music screens show beside the notes: each part's Strudel row per section (screen B, the Piano roll's pane),
// the chord chart (the Piano roll's chord row), the notes each of its chords is made of (the rows that fit, lit in the
// Piano roll: chord tones, and the tensions a melody may hold) and the muted notes (drawn hollow).
function extras(root, id, { song, text }) {
  const sp = songPaths(root, id);
  const rows = {};
  if (text) {
    const order = (song.playlist?.items || []).filter((i) => i.kind === 'pattern').sort((a, b) => a.at.tick - b.at.tick).map((i) => i.ref);
    for (const b of parseSongFile(text).blocks) {
      const ch = song.channels.find((c) => c.midiChannel === b.channel);
      if (!ch) continue;
      b.rows.forEach((r, i) => { if (order[i]) (rows[order[i]] ||= {})[ch.id] = r.text; });
    }
  }
  let chart = null;
  try { chart = JSON.parse(readFileSync(sp.blueprint, 'utf8')).chart || null; } catch { chart = null; }
  const fits = {};
  for (const row of Array.isArray(chart) ? chart : []) {
    for (const sym of (row.chords || []).flat()) {
      if (fits[sym]) continue;
      try { const c = parseChord(sym); fits[sym] = { tones: [...c.tones], tens: [...c.tens] }; } catch { /* a symbol the lock refuses lights nothing */ }
    }
  }
  let muted = [];
  try { muted = JSON.parse(readFileSync(join(sp.music, 'daw', 'notes-meta.json'), 'utf8')).muted || []; } catch { muted = []; }
  return { rows, chart, fits, muted };
}
