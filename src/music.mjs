// Music the owner finishes themselves. The studio writes the score in Strudel and hands over its MIDI (every channel,
// the arrangement, the cue sheet); the owner gives every channel its sound in their own DAW, mixes, exports from bar 1,
// and imports the master here. For videos this is the recommended way: Strudel's render is the stand-in until it arrives.
//
// Two ways in, both through this module: the web studio (the project's Music panel) and
// `mortiflix music <project> --import <file>`.
//
//   projects/<id>/music/blueprint.json       the plan (tempo, meter, bars): what the master must fit
//   projects/<id>/music/notes.json           the score's MIDI, captured by the music engine (the first note's time)
//   projects/<id>/out/music/midi/            the MIDI pack the owner downloads
//   projects/<id>/music/own-master/master.wav     the owner's master, 48 kHz stereo
//   projects/<id>/music/own-master/report.json    what it measured and how it fits the score
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { REPO, UserError, writeJson } from './studio.mjs';
import { projectPaths, loadProject, event, now } from './projects.mjs';
import { zip, dirEntries } from './zip.mjs';

// A file URL: import() reads a plain C:\... path as a URL with the scheme "c:" and refuses it.
const engine = (name) => import(pathToFileURL(join(REPO, 'pipelines', '_shared', 'skills', 'music', 'lib', name)).href);
export const MAX_MASTER_BYTES = 1024 * 1024 * 1024;
export const AUDIO_EXT = ['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.ogg'];

export function musicPaths(root, id) {
  const w = projectPaths(root, id).work;
  return { blueprint: join(w, 'music', 'blueprint.json'), notes: join(w, 'music', 'notes.json'), midi: join(w, 'out', 'music', 'midi'),
    sheet: join(w, 'music', 'MUSIC-SHEET.md'), own: join(w, 'music', 'own-master'), master: join(w, 'music', 'own-master', 'master.wav'),
    report: join(w, 'music', 'own-master', 'report.json') };
}

const readJ = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

// Did the brief ask the owner to finish the music from the MIDI? (intake "music" or "finish")
export function finishesOwnMaster(project) {
  const a = project?.intake?.answers || {};
  return /from the midi|my own|own master|own daw|in my daw/i.test(`${a.music ?? ''} ${a.finish ?? ''}`);
}

// What a master must fit: the score's length and when its first note sounds.
export function expectation(root, id) {
  const mp = musicPaths(root, id);
  const bp = readJ(mp.blueprint); if (!bp?.bpm || !bp?.bars) return null;
  const [n, d] = String(bp.meter || '4/4').split('/').map(Number); const bpb = (n * 4) / d;
  const notes = readJ(mp.notes);
  const first = notes ? Math.min(...notes.tracks.flatMap((t) => t.notes.map((x) => x.start))) : null;
  return { title: bp.title || null, bpm: bp.bpm, meter: bp.meter || '4/4', bars: bp.bars, seconds: +(bp.bars * bpb * 60 / bp.bpm).toFixed(3),
    first_note_sec: Number.isFinite(first) ? +(first * 60 / bp.bpm).toFixed(3) : null };
}

export function musicStatus(root, id) {
  const p = loadProject(root, id); const mp = musicPaths(root, id);
  const midi = existsSync(mp.midi) ? readdirSync(mp.midi).filter((f) => /\.(mid|md)$/.test(f)).sort() : [];
  return { finish: finishesOwnMaster(p) ? 'own' : 'strudel', expect: expectation(root, id), midi, sheet: existsSync(mp.sheet),
    own: readJ(mp.report), state: p.state, needs_you: p.needs_you || null };
}

// The MIDI pack as one zip: every channel, the arrangement, the cue sheet, and the music sheet.
export function midiPack(root, id) {
  const mp = musicPaths(root, id);
  if (!existsSync(mp.midi)) throw new UserError('there is no MIDI yet: the studio writes it once the score passes its check');
  const files = dirEntries(mp.midi, 'midi');
  if (existsSync(mp.sheet)) files.push({ name: 'MUSIC-SHEET.md', data: readFileSync(mp.sheet) });
  return zip(files);
}

// Imports the owner's master from a file (CLI) or bytes (web). Returns the report; errors in it mean the file can't be
// used as is, warnings are for the owner and the session to weigh.
export async function importMaster(root, id, { file = null, buffer = null, name = null }) {
  const mp = musicPaths(root, id);
  const expect = expectation(root, id);
  if (!expect) throw new UserError('this project has no score yet: the master is made from its MIDI pack, which comes after the score');
  const src = name || (file ? basename(file) : 'master.wav');
  if (!AUDIO_EXT.includes(extname(src).toLowerCase())) throw new UserError(`${src}: import an audio file (${AUDIO_EXT.join(' ')})`);
  if (file && !existsSync(file)) throw new UserError(`no file at ${file}`);
  const { toStudioWav, checkOwnMaster } = await engine('master.mjs');
  mkdirSync(mp.own, { recursive: true });
  let input = file;
  if (buffer) { input = join(tmpdir(), `mfx-master-${process.pid}-${Date.now()}${extname(src).toLowerCase()}`); writeFileSync(input, buffer); }
  const next = join(mp.own, 'master.next.wav');
  try { toStudioWav(input, next); } finally { if (buffer) rmSync(input, { force: true }); }
  const r = checkOwnMaster(next, expect);
  if (r.errors.length) { rmSync(next, { force: true }); return { ok: false, source: src, ...r, expect }; }
  copyFileSync(next, mp.master); rmSync(next, { force: true });
  const report = { ok: true, source: src, file: 'music/own-master/master.wav', imported_at: now(), expect, ...r };
  writeJson(mp.report, report);
  event(root, id, { event: 'MUSIC_IMPORTED', actor: 'owner', details: `${src}: ${r.measured.seconds} s, ${r.measured.lufs} LUFS${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ''}` });
  return report;
}
