import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { runChecks, writeArtcraft, openArtcraft, toSrt } from '../src/svc/artcraft.mjs';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function fixture(t, { silent = false } = {}) {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Check Me', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'out'), { recursive: true });
  mkdirSync(join(work, 'voice'), { recursive: true });
  // 0-2 s black, 2-3.5 s white (planned cut at 2), 3.5-5 s black (unplanned jump at 3.5)
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'color=white:s=160x90:r=30:d=1.5', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=1.5',
    '-f', 'lavfi', '-i', silent ? 'anullsrc=r=48000:cl=mono' : 'sine=f=440:r=48000', '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(work, 'out', 'animatic.mp4')]);
  assert.equal(r.status, 0, String(r.stderr));
  writeFileSync(join(work, 'out', 'scenes.json'), JSON.stringify({ fps: 30, scenes: [
    { key: 's01', from_frame: 0, frames: 60, keys: [{ word: 'Black', at_frame: 10 }], boxes: [{ text: 'A', x: 0, y: 0, w: 100, h: 50 }, { text: 'B', x: 50, y: 20, w: 100, h: 50 }] },
    { key: 's02', from_frame: 60, frames: 90, keys: [{ word: 'October', at_frame: 120 }] }] }));
  writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify({ lines: [{ id: 'b01-1', start: 0, words: [{ text: 'Black,', start: 0.3, end: 0.6 }, { text: 'October.', start: 2.0, end: 2.5 }] }] }));
  return { root, id: p.id };
}

test('checks: jump, sync, overlap, sound each report with shots and times', { skip: !ffmpeg }, (t) => {
  const { root, id } = fixture(t);
  const c = Object.fromEntries(runChecks(root, id).map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(c), ['jump', 'sync', 'overlap', 'sound']);
  assert.equal(c.jump.ok, false);
  assert.equal(c.jump.items.length, 1, 'the cut at 2 s is planned, the one at 3.5 s is not');
  assert.ok(Math.abs(c.jump.items[0].at_sec - 3.5) < 0.1);
  assert.equal(c.jump.items[0].shot, 's02');
  assert.equal(c.sync.ok, false, 'October shows at 4 s, is said at 2 s');
  assert.equal(c.sync.items.length, 1);
  assert.equal(c.sync.items[0].shot, 's02');
  assert.equal(c.overlap.ok, false);
  assert.match(c.overlap.items[0].text, /"A" and "B"/);
  assert.equal(c.sound.ok, true);
});

test('checks: all clear when nothing is wrong; silence is caught', { skip: !ffmpeg }, (t) => {
  const { root, id } = fixture(t, { silent: true });
  const r = runChecks(root, id, { keys: [], boxes: [], jump_threshold: 1 });
  assert.equal(r.find((x) => x.key === 'jump').ok, true);
  assert.equal(r.find((x) => x.key === 'sync').ok, true);
  assert.equal(r.find((x) => x.key === 'sound').ok, false);
});

test('artcraft.write: builds the project with the engine in order, no port, with captions and markers', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Check Me', answers: { topic: 'x' } });
  const calls = [];
  const fcproj = join(projectPaths(root, p.id).state, 'edit', 'Check Me.mortiflix');
  const plan = {
    fcproj, sequence: { name: 'Check Me', width: 1920, height: 1080, fps: 30, length_sec: 5 },
    clips: [
      { node: 's01', kind: 'shot', version: 1, start_sec: 0, dur_sec: 2, name: 'S01', media: { kind: 'video', path: '/x/a.mp4' } },
      { node: 's02', kind: 'shot', version: 1, start_sec: 2, dur_sec: 3, name: 'S02', media: { kind: 'video', path: '/x/b.mp4' } },
      { node: 'b01-1', kind: 'line', version: 1, start_sec: 0.5, name: 'L1', media: { kind: 'audio', path: '/x/v.wav' } },
      { node: 'music', kind: 'music', version: 1, start_sec: 0, name: 'Music', media: { kind: 'audio', path: '/x/m.wav' } },
      { node: 'fx1', kind: 'sfx', version: 1, start_sec: 2, name: 'Whoosh', media: { kind: 'audio', path: '/x/w.wav' } }],
    markers: [{ kind: 'chapter', time_sec: 0, name: '1 Open' }, { kind: 'chapter', time_sec: 2, name: '2 Turn' }],
    captions: [{ start_sec: 0.3, end_sec: 1, text: 'Black' }],
  };
  const cli = (args) => {
    calls.push(args);
    const j = args.join(' ');
    if (j.includes('file.import')) return JSON.stringify({ errors: [], items: [1, 2, 3, 4, 5] });
    if (j.includes('file.newSequence')) return '{"sequence":9}';
    if (j.includes('timeline.place') && j.includes('"items"')) return '{"clips":[11,12],"placed":[[11],[12]]}';
    if (j.includes('timeline.place')) return '{"clips":[20]}';
    return 'null';
  };
  const r = writeArtcraft(root, p.id, { cli, plan });
  assert.equal(r.file, fcproj);
  assert.deepEqual(r.tracks, ['V1', 'A1', 'A2', 'A3', 'C1']);
  assert.equal(r.markers, 2);
  assert.equal(r.captions, 1);
  assert.ok(calls.every((a) => !a.join(' ').includes('--control')), 'no control port');
  assert.ok(calls.some((a) => a.includes('run')));
  assert.match(readFileSync(join(fcproj, '..', 'media', 'captions.srt'), 'utf8'), /00:00:00,300 --> 00:00:01,000\nBlack/);
});

test('artcraft.write: refuses when nothing is shot yet', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Empty', answers: { topic: 'x' } });
  assert.throws(() => writeArtcraft(root, p.id, { cli: () => 'null', plan: { fcproj: '/tmp/x.mortiflix', clips: [], markers: [], sequence: {} } }), /nothing to hand over/);
});

test('artcraft.open: launches the file detached (mocked spawn)', (t) => {
  const root = tempStudio(t);
  const file = join(root, 'a.mortiflix');
  writeFileSync(file, '{}');
  let got;
  const r = openArtcraft(file, { spawnFn: (cmd, args, o) => { got = { cmd, args, o }; return { unref() {} }; } });
  assert.equal(r.opened, file);
  assert.deepEqual(got.args, [file]);
  assert.equal(got.o.detached, true);
  assert.throws(() => openArtcraft(join(root, 'nope.mortiflix'), { spawnFn: () => ({}) }), /make the ArtCraft file first/);
});

test('toSrt numbers and times captions', () => {
  assert.equal(toSrt([{ start_sec: 1.5, end_sec: 2, text: 'a' }]), '1\n00:00:01,500 --> 00:00:02,000\na\n');
});
