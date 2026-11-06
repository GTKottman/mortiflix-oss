// The DAW render cache (doc 24 §1): the key ignores the song's rev and follows everything that changes the sound; the
// real engine renders the same file at 1 and 8 threads, through the render queue, and the same render asked for again
// comes from the cache without running the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { songPaths } from '../src/song-store.mjs';
import { songFromNotes } from '../src/song-import.mjs';
import { writeSong } from '../src/song.mjs';
import { RenderQueue } from '../src/renderq.mjs';
import { renderKey, renderProjectSong, rendersDir } from '../src/song-render.mjs';

const REAL = [process.env.MFX_DAW_ENGINE, join(homedir(), '.cache/mortiflix/engine-build/mortiflix-engine_artefacts/Release/mortiflix-engine')].find((f) => f && existsSync(f));
const FOUR = join(import.meta.dirname, 'fixtures', 'songs', 'four');
const fourSong = () => songFromNotes({ blueprint: JSON.parse(readFileSync(join(FOUR, 'blueprint.json'), 'utf8')), notes: JSON.parse(readFileSync(join(FOUR, 'notes.json'), 'utf8')), instruments: null }).song;

function songProject(t) {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Render', answers: { topic: 'tides' } });
  const sp = songPaths(root, p.id);
  mkdirSync(sp.music, { recursive: true });
  writeFileSync(sp.song, writeSong(fourSong()));
  return { root, id: p.id, work: projectPaths(root, p.id).work };
}

test('the render key: the rev never counts; notes, render settings, the engine, blobs and audio files do', (t) => {
  const { work } = songProject(t);
  const song = fourSong();
  const base = { song, work, settings: {}, engine: '{"version":"0.1.0"}' };
  const k = renderKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(renderKey({ ...base, song: { ...song, rev: 41 } }), k, 'a new rev alone is the same render');
  assert.equal(renderKey({ ...base, settings: { rate: 48000, blockSize: 512, threads: 8 } }), k, 'the defaults spelled out are the same render');
  assert.notEqual(renderKey({ ...base, settings: { blockSize: 256 } }), k);
  assert.notEqual(renderKey({ ...base, engine: '{"version":"0.1.1"}' }), k);
  const moved = structuredClone(song);
  const notes = Object.values(moved.patterns[0].notes)[0];
  notes[0] = { ...notes[0], vel: 0.9 };
  assert.notEqual(renderKey({ ...base, song: moved }), k, 'one note louder is a new render');

  // a blob (a plugin's state) is read from music/daw/blobs; a changed file is a new render
  const blobDir = join(work, 'music', 'daw', 'blobs');
  mkdirSync(blobDir, { recursive: true });
  const withBlob = { ...song, channels: song.channels.map((c, i) => (i ? c : { ...c, blob: 'ab'.repeat(32) })) };
  writeFileSync(join(blobDir, `${'ab'.repeat(32)}.bin`), 'state one');
  const kb = renderKey({ ...base, song: withBlob });
  writeFileSync(join(blobDir, `${'ab'.repeat(32)}.bin`), 'state two');
  assert.notEqual(renderKey({ ...base, song: withBlob }), kb);

  // an audio file in the project
  mkdirSync(join(work, 'voice', 'out'), { recursive: true });
  writeFileSync(join(work, 'voice', 'out', 'l03.wav'), 'take one');
  const withAudio = { ...song, audio: [{ id: 'a03', file: 'voice/out/l03.wav' }] };
  const ka = renderKey({ ...base, song: withAudio });
  writeFileSync(join(work, 'voice', 'out', 'l03.wav'), 'take two');
  assert.notEqual(renderKey({ ...base, song: withAudio }), ka);
});

test('the real engine through the render queue: 1 and 8 threads give one file; the same render again is the cache', { skip: !REAL && 'the engine is not built on this machine' }, async (t) => {
  const { root, id } = songProject(t);
  const queue = new RenderQueue({ logDir: join(root, 'run', 'renders') });
  const fileSha = (dir) => createHash('sha256').update(readFileSync(join(dir, 'mix-f32.wav'))).digest('hex');

  const one = await renderProjectSong(root, id, { queue, bin: REAL, settings: { threads: 1 } });
  const eight = await renderProjectSong(root, id, { queue, bin: REAL, settings: { threads: 8 } });
  assert.equal(queue.jobs.size, 2, 'both went through the render queue');
  assert.deepEqual([one.cached, eight.cached], [false, false]);
  assert.equal(one.dir, join(rendersDir(root, id), one.key.slice(0, 12)));
  assert.ok(one.report.ok && one.report.files[0].float && one.report.files[0].rate === 48000, 'a 48 kHz float render');
  assert.equal(one.report.settings.threads, 1);
  assert.equal(eight.report.settings.threads, 8);
  assert.equal(fileSha(one.dir), fileSha(eight.dir), 'the same samples at 1 and 8 threads');
  assert.equal(fileSha(one.dir), one.report.files[0].sha256, 'the report names the file it wrote');

  const again = await renderProjectSong(root, id, { queue, bin: REAL, settings: { threads: 8 } });
  assert.equal(again.cached, true);
  assert.equal(again.dir, eight.dir);
  assert.equal(queue.jobs.size, 2, 'the engine did not run again');
  assert.deepEqual(readdirSync(rendersDir(root, id)).sort(), [one.dir, eight.dir].map((d) => d.split('/').pop()).sort(), 'no half-written folders left');
});
