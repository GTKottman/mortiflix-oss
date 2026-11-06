// A score becomes a song (doc 18 S2, doc 28 M5): the Strudel song file is plain Strudel (one $: arrange() per part),
// it plays the score note for note, and the song's notes are worked out from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createEvaluator } from '../src/strudel/evaluator.mjs';
import { importScore, toManifest, compareManifests } from '../src/song-import.mjs';
import { parseSongFile, songNotes, setRow, notesOnly } from '../src/strudel/songfile.mjs';
import { checkSong, sectionLayout } from '../src/song.mjs';

const dir = [process.env.MFX_STRUDEL, join(homedir(), 'Mortiflix', 'tools', 'strudel')].find((d) => d && existsSync(join(d, 'node_modules', '@strudel', 'core')));
const skip = dir ? false : 'Strudel is not installed';
const FX = join(import.meta.dirname, 'fixtures', 'songs');
const load = (name) => {
  const rd = (f) => (existsSync(join(FX, name, f)) ? readFileSync(join(FX, name, f), 'utf8') : null);
  return { blueprint: JSON.parse(rd('blueprint.json')), notes: JSON.parse(rd('notes.json')), instruments: rd('instruments.json') ? JSON.parse(rd('instruments.json')) : null, sources: { score: rd('score.strudel.js'), notes: rd('notes.json'), blueprint: rd('blueprint.json') } };
};

test('three scores import note for note (4/4 with drums, 6/8, notes crossing section ends and off the grid)', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  for (const name of ['four', 'six-eight', 'crossing']) {
    const f = load(name);
    const { song, text } = await importScore({ ...f, evaluator: ev });
    assert.deepEqual(checkSong(song), [], name);
    assert.deepEqual(compareManifests(f.notes, toManifest(song)), [], `${name}: song → manifest equals notes.json`);
    // the file is plain Strudel: no helpers of ours, one $: arrange() per part
    assert.doesNotMatch(text, /mfx/);
    const parsed = parseSongFile(text);
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.blocks.map((b) => b.channel), f.notes.tracks.map((x) => x.channel).sort((a, b) => a - b));
    for (const b of parsed.blocks) assert.deepEqual(b.rows.map((r) => r.section), f.blueprint.sections.map((s) => s.id));
    // the whole file (with its sounds) runs as one program
    const run = await ev.run(text, { bars: f.blueprint.bars, mode: 'haps', ms: 20000 });
    assert.ok(run.ok, run.error);
  }
});

test('the song: maps, channels, sections, playlist, markers, mixer from the score', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const { song } = await importScore({ ...load('four'), evaluator: ev });
  assert.equal(song.offsetSec, 0.5);
  assert.deepEqual(song.tempo, [{ tick: 0, bpm: 96, shape: 'jump' }]);
  assert.deepEqual(song.scale, { root: 'D', mode: 'dorian', limitToScale: true });
  assert.deepEqual(song.channels.map((c) => [c.id, c.name, c.kind, c.instrument]), [['ch02', 'Bass', 'instrument', null], ['ch03', 'Keys', 'instrument', null], ['ch10', 'Drums', 'drums', null]]);
  assert.deepEqual(sectionLayout(song).map((x) => [x.id, x.startBar, x.bars]), [['m01', 1, 4], ['m02', 5, 4]]);
  assert.equal(song.patterns[1].sameAs, 'm01', 'the two sections play the same notes: offered as "edit both"');
  assert.deepEqual(song.markers.find((m) => m.kind === 'hit'), { id: 'h01', tick: 15360, name: 'logo', kind: 'hit', sec: 10.5, from: 'blueprint' });
  assert.deepEqual(song.playlist.tracks.map((r) => r.name), ['Music', 'Narration', 'Sound effects', 'Reference (Strudel)']);
  assert.equal(song.mixer.inserts.length, 3);
  assert.equal(Object.keys(song.strudel.regions).length, 6);
  // the kick's sound re-pitches it (.note(31)): the notes stay General MIDI 36
  assert.ok(song.patterns[0].notes.ch10.some((n) => n.key === 36));
  assert.ok(!song.patterns[0].notes.ch10.some((n) => n.key === 31));
});

test('a row can be changed and read back; the rest of the file stays byte for byte', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const { song, text } = await importScore({ ...load('six-eight'), evaluator: ev });
  const sections = song.patterns.map((p) => ({ id: p.id, bars: p.bars }));
  const changed = setRow(text, 1, 1, 'note("<[d5 ~ ~ ~ ~ ~] ~ ~>")');
  const a = text.split('\n'); const b = changed.split('\n');
  assert.equal(a.length, b.length);
  assert.equal(a.filter((l, i) => l !== b[i]).length, 1, 'one line changes');
  const got = await songNotes(ev, changed, sections, { ticksPerBar: 2880, beatsPerBar: 3 });
  assert.deepEqual(got.problems, []);
  assert.deepEqual(got.parts[1].m02, [{ t: 0, len: 480, key: 74, vel: 0.8 }]);
  assert.deepEqual(got.parts[1].m01, song.patterns[0].notes.ch01);
  assert.deepEqual(got.parts[2].m02, song.patterns[1].notes.ch02);
  // the notes are read without the sounds
  assert.doesNotMatch(notesOnly(text), /\.s\(/);
});

test('mortiflix music <project> --song writes song.json and song.strudel.js; a bad song is never saved', { skip }, async (t) => {
  const { tempStudio } = await import('./helpers.mjs');
  const { createProject } = await import('../src/projects.mjs');
  const { songPaths, loadSong, saveSong } = await import('../src/song-store.mjs');
  const { cpSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Song test', answers: { topic: 'tides' } });
  const sp = songPaths(root, p.id);
  for (const f of ['blueprint.json', 'notes.json', 'instruments.json', 'score.strudel.js']) cpSync(join(FX, 'four', f), join(sp.music, f));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'mortiflix'), 'music', p.id, '--song'], { encoding: 'utf8', env: { ...process.env, MORTIFLIX_STUDIO: root, MFX_STRUDEL: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 sections × 3 parts, 218 notes, the same as the score note for note/);
  const { song, text } = loadSong(root, p.id);
  assert.equal(song.rev, 1);
  assert.match(text, /^\/\/ "Four" · 96 BPM · 4\/4 · D:dorian/);
  song.patterns[0].notes.ch02[0].key = 200;
  assert.throws(() => saveSong(root, p.id, song), /can't be saved: .*"key" 200 is over 127/);
  assert.equal(loadSong(root, p.id).song.rev, 1, 'the file on disk is unchanged');
});

test('the demo backend writes a song (S11): the browser can try the song lane with no Claude, no Strudel, no engine', async (t) => {
  const { tempStudio } = await import('./helpers.mjs');
  const { createProject, startProject } = await import('../src/projects.mjs');
  const { respond } = await import('../src/gates.mjs');
  const { Runner } = await import('../src/runner.mjs');
  const { loadSong } = await import('../src/song-store.mjs');
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Demo song', answers: { topic: 'tides' } });
  startProject(root, p.id);
  const { setBrief } = await import('../src/svc/lookbrief.mjs');
  const { setMotionBrief, setTransitionBrief } = await import('../src/svc/motionbrief.mjs');
  setBrief(root, p.id, { vibe: 'calm', font: 'Inter' }); // the owner picks a look before the style frames
  setMotionBrief(root, p.id, {}); // and leaves the motion to the AI before the animatic
  setTransitionBrief(root, p.id, {}); // and the transitions to the library
  const runner = new Runner(root);
  runner.acquire();
  t.after(() => runner.release());
  await runner.loop();
  // the music is written once every gate before it is passed
  for (const step of ['brief', 'script', 'voice', 'style-frames', 'transitions', 'animatic']) {
    respond(root, p.id, step, 1, { verdict: 'approve' });
    await runner.loop();
  }
  const { song, text } = loadSong(root, p.id);
  assert.deepEqual(checkSong(song), []);
  assert.deepEqual(song.patterns.map((x) => [x.id, x.bars]), [['m01', 2], ['m02', 2], ['m03', 2], ['m04', 2]]);
  assert.deepEqual(song.channels.map((c) => c.name), ['Bass', 'Keys', 'Drums']);
  assert.match(text, /\$: arrange\(/);
  // with Strudel installed, the file plays exactly the song's notes
  if (dir) {
    const ev = createEvaluator({ strudelDir: dir });
    t.after(() => ev.close());
    const got = await songNotes(ev, text, song.patterns.map((x) => ({ id: x.id, bars: x.bars })));
    assert.deepEqual(got.problems, []);
    const full = (ns) => (ns || []).map((n) => ({ vel: 0.8, ...n }));   // the file leaves defaults out
    for (const pat of song.patterns) for (const c of song.channels) assert.deepEqual(full(got.parts[c.midiChannel][pat.id]), full(pat.notes[c.id]), `${pat.id} ${c.id}`);
  }
});
