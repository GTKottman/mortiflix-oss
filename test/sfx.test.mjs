import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { saveConfig } from '../src/studio.mjs';
import { projectPaths } from '../src/projects.mjs';
import { setElevenKey } from '../src/voice/index.mjs';
import { sfxHandlers, makePlan, makeSounds, setCue, okCue, cutCue, mixSounds, soundPaths } from '../src/svc/sfx.mjs';

const tone = (f, s) => spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${s}`, f]);
function fixture(t) {
  const root = tempStudio(t);
  const id = 'sfx-test-project';
  const work = projectPaths(root, id).work;
  const src = join(work, 'video', 'src');
  mkdirSync(src, { recursive: true });
  mkdirSync(join(work, 'voice'), { recursive: true });
  const lines = [{ id: 'b01-1', start: 0, end: 2, words: [{ text: 'a', start: 0, end: 0.5 }, { text: 'b', start: 1, end: 1.5 }] }, { id: 'b02-1', start: 4, end: 6, words: [{ text: 'c', start: 4, end: 4.5 }, { text: 'd', start: 5, end: 5.5 }] }];
  writeFileSync(join(src, 'voice-timing.json'), JSON.stringify({ lines }));
  writeFileSync(join(src, 'video.ts'), 'export const video = { fps: 30, seconds: 8 };');
  writeFileSync(join(src, 'timing.ts'), "export const cues = {\n b01: { title: rel('b01', word('b01-1', 1)), ticks: [rel('b01', word('b01-1', 0)), 10] },\n b02: { pop: rel('b02', word('b02-1', 1)) + 6 },\n};\n");
  tone(join(work, 'voice', 'voice.wav'), 8);
  const lib = join(root, 'lib');
  mkdirSync(lib);
  tone(join(lib, 'tick.mp3'), 0.5);
  writeFileSync(join(lib, 'index.json'), JSON.stringify([{ file: 'tick.mp3', name: 'pencil tick', prompt: 'Pencil tick, short dry scratch', category: 'Other', length_s: 0.5 }]));
  return { root, id, work, lib };
}

test('plan reads cue times, matches library first', (t) => {
  const { work, lib } = fixture(t);
  const plan = makePlan(work, { library: lib });
  const at = plan.cues.map((c) => [c.shot, c.at_sec]);
  assert.deepEqual(at, [['b01', 0], ['b01', 0.333], ['b01', 1], ['b02', 5.2]]);
  assert.equal(plan.cues.filter((c) => c.source === 'library').length, 2); // both ticks
  assert.equal(plan.cues.find((c) => c.what === 'Title').source, 'generate');
  assert.ok(plan.summary.credits > 0);
});

test('make: estimate without confirm, no network', async (t) => {
  const { root, work, lib } = fixture(t);
  makePlan(work, { library: lib });
  const r = await makeSounds(root, work, { all: true }, { fetchImpl: () => { throw new Error('network!'); } });
  assert.equal(r.confirm_needed, true);
  assert.equal(r.calls, 2);
});

test('make: confirmed calls are logged, files made, mix works', async (t) => {
  const { root, work, lib } = fixture(t);
  setElevenKey(root, 'k');
  makePlan(work, { library: lib });
  const mp = join(root, 'x.mp3'); tone(mp, 1);
  const bytes = readFileSync(mp);
  let n = 0;
  const f = async () => { n++; return { ok: true, status: 200, arrayBuffer: async () => bytes }; };
  const r = await makeSounds(root, work, { all: true, confirm: true }, { fetchImpl: f });
  assert.equal(n, 2); assert.equal(r.made.length, 2);
  assert.equal(readFileSync(soundPaths(work).calls, 'utf8').trim().split('\n').length, 2);
  const m = mixSounds(work);
  assert.ok(existsSync(m.file)); assert.equal(m.sounds, 4); assert.ok(Math.abs(m.seconds - 8) < 0.2);
});

test('make: 402 stops at once with no retry; other error retries once', async (t) => {
  const { root, work, lib } = fixture(t);
  setElevenKey(root, 'k');
  makePlan(work, { library: lib });
  let n = 0;
  let r = await makeSounds(root, work, { all: true, confirm: true }, { fetchImpl: async () => { n++; return { ok: false, status: 402, text: async () => 'billing' }; } });
  assert.equal(n, 1); assert.equal(r.stopped.billing, true);
  n = 0;
  r = await makeSounds(root, work, { all: true, confirm: true }, { fetchImpl: async () => { n++; return { ok: false, status: 500, text: async () => 'x' }; } });
  assert.equal(n, 2); assert.equal(r.stopped.billing, false);
  assert.equal(readFileSync(soundPaths(work).calls, 'utf8').trim().split('\n').length, 2);
});

test('set / ok / cut', (t) => {
  const { work, lib } = fixture(t);
  const plan = makePlan(work, { library: lib });
  const c = plan.cues.find((x) => x.source === 'generate');
  assert.throws(() => okCue(work, c.id), /make this sound first/);
  setCue(work, { cue: c.id, dur_sec: 2, prompt: 'new' });
  assert.equal(readFileSync(soundPaths(work).plan, 'utf8').includes('"new"'), true);
  assert.equal(cutCue(work, c.id).cue.status, 'cut');
  assert.equal(cutCue(work, c.id, false).cue.status, 'planned');
  const lc = plan.cues.find((x) => x.source === 'library');
  assert.equal(okCue(work, lc.id).cue.status, 'ok');
});

test('handlers: no motion gives not_ready', async (t) => {
  const root = tempStudio(t);
  const work = projectPaths(root, 'empty-project').work; mkdirSync(work, { recursive: true });
  class PE extends Error { constructor(c, m) { super(m); this.code = c; } }
  const h = sfxHandlers({ root, needProject: (p) => p.project, ProtocolError: PE });
  assert.equal((await h['sfx.plan']({ project: 'empty-project' })).ready, false);
  await assert.rejects(h['sfx.plan.make']({ project: 'empty-project' }), (e) => e.code === 'not_ready');
});

test('make: a sound that comes back nearly silent stays to make, is not cached, and is not made again on its own', async (t) => {
  const { root, work, lib } = fixture(t);
  setElevenKey(root, 'k');
  makePlan(work, { library: lib });
  const quiet = join(root, 'q.mp3');
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'volume=-40dB', quiet]);
  const bytes = readFileSync(quiet);
  let n = 0;
  const r = await makeSounds(root, work, { all: true, confirm: true }, { fetchImpl: async () => { n++; return { ok: true, status: 200, arrayBuffer: async () => bytes }; } });
  assert.equal(n, 2); // once per distinct sound, no retry
  assert.equal(r.made.length, 0);
  assert.equal(r.silent.length, 2);
  const plan = JSON.parse(readFileSync(soundPaths(work).plan, 'utf8'));
  for (const c of plan.cues.filter((x) => x.source === 'generate')) { assert.equal(c.status, 'planned'); assert.match(c.failed, /nearly silent \(peak -\d+\.\d dBFS\)/); assert.equal(c.file, undefined); }
  const again = await makeSounds(root, work, { all: true }, { fetchImpl: () => { throw new Error('no'); } });
  assert.equal(again.from_library.length, 0); // the silent one was not cached
  assert.equal(again.calls, 2);
});

test('change: "Make a new one instead" with typed words makes from those words', (t) => {
  const { work, lib } = fixture(t);
  const plan = makePlan(work, { library: lib });
  const libCue = plan.cues.find((c) => c.source === 'library');
  setCue(work, { cue: libCue.id, source: 'generate', prompt: 'short chalk scratch line drawn fast on a blackboard', dur_sec: libCue.dur_sec, at_sec: libCue.at_sec });
  const c = JSON.parse(readFileSync(soundPaths(work).plan, 'utf8')).cues.find((x) => x.id === libCue.id);
  assert.equal(c.source, 'generate');
  assert.equal(c.prompt, 'short chalk scratch line drawn fast on a blackboard');
  assert.equal(c.status, 'planned');
});

test('credits: measured from the real calls, cache hits free', async (t) => {
  const { root, work, lib } = fixture(t);
  mkdirSync(soundPaths(work).dir, { recursive: true });
  writeFileSync(soundPaths(work).calls, `${JSON.stringify({ ok: true, status: 200, seconds: 0.6, credits: 7 })}\n${JSON.stringify({ ok: true, cache: 'hit', seconds: 0.6, credits: 0 })}\n`);
  const { measuredRate, creditsFor } = await import('../src/svc/sfx.mjs');
  const rate = measuredRate(join(work, '..'));
  assert.ok(Math.abs(rate - 7 / 0.6) < 0.01);
  assert.equal(creditsFor({ source: 'generate', dur_sec: 0.6 }, rate), 7);
  const v = makePlan(work, { library: lib });
  for (const c of v.cues.filter((x) => x.source === 'generate')) assert.equal(c.credits, creditsFor(c, rate));
});
