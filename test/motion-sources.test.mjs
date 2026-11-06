// The Motion build names each scene's approved stills and frame by absolute path and inlines their code; missing sources
// stop the scene honestly before any call or render (2026-11-02: bdb9 and d4fd scene 1 rebuilt from guesses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths, loadProject } from '../src/projects.mjs';
import * as qa from '../src/quickanimatic.mjs';
import { sceneSources } from '../src/svc/motionsources.mjs';

function setup(t) {
  const root = tempStudio(t);
  const id = createProject(root, { pipeline: 'v3', title: 'Sources', answers: { topic: 'x' } }).id;
  const work = projectPaths(root, id).work;
  const put = (rel, d) => { mkdirSync(join(work, rel, '..'), { recursive: true }); writeFileSync(join(work, rel), d); };
  const beats = [{ id: 'b01', name: 'The question', visual: 'v', lines: [{ id: 'b01-1', words: 'Who gets your chats?' }] }];
  put('script/beats.json', JSON.stringify({ beats }));
  put('video/src/video.ts', 'export const video = { width: 1920, height: 1080, fps: 30, seconds: 4 };');
  put('video/src/ui.tsx', 'export const Ui = () => null;');
  put('video/src/scenes/st_b01.tsx', "export const stills = { 'b01-1': () => 'HEADLINE_CODE' };");
  put('video/src/scenes/sf01.tsx', 'export const SF01 = () => null; // FRAME_CODE');
  put('design/stills/b01-1-v1.png', 'rejected'); put('design/stills/b01-1-v2.png', 'x');
  put('design/stills/stills.json', JSON.stringify({ mode: 'groups', lines: { 'b01-1': { state: 'ok', current: 2, versions: [{ v: 1, file: 'design/stills/b01-1-v1.png' }, { v: 2, file: 'design/stills/b01-1-v2.png' }] } } }));
  put('out/frames/sf01-v1.png', 'x');
  put('design/frames-state.json', JSON.stringify({ planned: true, frames: [{ id: 'sf01', label: 'SF01', beats: ['b01'], state: 'ok', current: 1, versions: [{ v: 1, file: 'out/frames/sf01-v1.png' }] }] }));
  const c = { only: 'b01', target: { ids: ['b01'], from: 0, to: 120, all: [] }, done: [], work, project: { title: 'Sources' }, script: { beats }, timing: { seconds: 4, lines: [] }, board: { cuts: [] }, frames: [], lines: [], brief: {} };
  return { root, id, work, c };
}

test('the Motion prompt names the approved still and frame by absolute path, inlines their code, never the rejected version', (t) => {
  const { root, id, work, c } = setup(t);
  const p = qa.writePrompt(root, id, c);
  const src = join(work, 'video', 'src');
  assert.ok(p.includes(`- b01-1: picture ${join(work, 'design/stills/b01-1-v2.png')}`));
  assert.ok(p.includes(`Their code: ${join(src, 'scenes/st_b01.tsx')}`));
  assert.ok(p.includes(`code ${join(src, 'scenes/sf01.tsx')}`));
  assert.ok(p.includes(`The look's code: ${join(src, 'video.ts')} and ${join(src, 'ui.tsx')}`));
  assert.match(p, /HEADLINE_CODE/); assert.match(p, /FRAME_CODE/);
  assert.match(p, /Add ONLY motion/); assert.match(p, /No new facts/); assert.match(p, /tally marks/);
  assert.match(p, new RegExp(`every src/\\.\\.\\. path in this prompt means ${src.replace(/[.]/g, '\\.')}/`));
  assert.ok(!p.includes('b01-1-v1.png'), 'never the rejected version');
  assert.deepEqual(sceneSources(root, id, work, ['b01']).missing, []);
});

test('a missing still code stops the scene before any call or render, with the honest reason', async (t) => {
  const { root, id, work } = setup(t);
  rmSync(join(work, 'video/src/scenes/st_b01.tsx'));
  assert.deepEqual(sceneSources(root, id, work, ['b01']).missing, [join(work, 'video/src/scenes/st_b01.tsx')]);
  // a scene with no OK'd still at all
  writeFileSync(join(work, 'design/stills/stills.json'), JSON.stringify({ lines: {} }));
  assert.match(sceneSources(root, id, work, ['b01']).missing[0], /approved stills of b01 \(none OK'd\)/);
});

test('the build call reports sources it could not open: nothing is written or rendered', async (t) => {
  const { root, id, work } = setup(t);
  mkdirSync(join(work, 'voice'), { recursive: true }); mkdirSync(join(work, 'out', 'voice'), { recursive: true });
  writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify({ seconds: 4, lines: [{ id: 'b01-1', text: 'Who gets your chats?', start: 0.2, end: 3, words: [{ text: 'Who', start: 0.2 }] }] }));
  // a real wav so the narration copy passes
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '1', join(work, 'out/voice/narration.wav')]);
  let why = null, calls = 0;
  const run = async () => { calls++; return { ok: true, structured: { files: [{ path: 'src/Main.tsx', content: 'GUESSED' }], seconds: 4, note: '', facts_note: '', missing_sources: [join(work, 'video/src/scenes/st_b01.tsx')] } }; };
  const renders = { add: () => assert.fail('nothing renders'), wait: async () => assert.fail('nothing renders') };
  const r = await qa.quickAnimatic({ root, id, view: {}, run, runArgs: {}, config: {}, onActivity: () => {}, fallback: async (w) => { why = w; return { ok: false, paused: true }; }, renders, sessionId: 's' });
  assert.equal(why && calls, 1, why);
  assert.equal(r.paused, true);
  assert.match(why, /could not find the approved still code; nothing was made/);
  assert.ok(!require_exists(join(work, 'video/src/Main.tsx')), 'the guessed code is not written');
  assert.ok(loadProject(root, id));
});
const require_exists = (f) => { try { return Boolean(readFileSyncSafe(f)); } catch { return false; } };
import { readFileSync as readFileSyncSafe } from 'node:fs';

test('a scene Fix clip (out/scenes/b01-e004.mp4 in scenes.json) becomes Version 2: clips.json, versions, sceneGet', async (t) => {
  const { root, id, work } = setup(t);
  const { sceneGet } = await import('../src/svc/lessons.mjs');
  const { execFileSync } = await import('node:child_process');
  mkdirSync(join(work, 'out/scenes'), { recursive: true });
  for (const f of ['b01.mp4', 'b01-e004.mp4']) execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=1', '-c:v', 'libx264', join(work, 'out/scenes', f)]);
  writeFileSync(join(work, 'out/scenes/clips.json'), JSON.stringify([{ beats: ['b01'], file: 'b01.mp4', from: 0, to: 124 }]));
  writeFileSync(join(work, 'out/scenes.json'), JSON.stringify({ made_from: 'out/animatic.mp4', fps: 30, scenes: [{ key: 's01', beat: 'b01', from_frame: 0, frames: 124, file: 'out/scenes/b01-e004.mp4' }] }));
  assert.deepEqual(await qa.syncSceneEdits(work), [{ beat: 'b01', file: 'b01-e004.mp4' }]);
  assert.deepEqual(await qa.syncSceneEdits(work), [], 'idempotent');
  const clips = JSON.parse(readFileSyncSafe(join(work, 'out/scenes/clips.json'), 'utf8'));
  assert.equal(clips[0].file, 'b01-e004.mp4');
  assert.deepEqual(clips[0].versions, [{ n: 1, file: 'b01.mp4' }, { n: 2, file: 'b01-e004.mp4' }]);
  const sc = sceneGet(root, id).scenes[0];
  assert.deepEqual(sc.versions.map((v) => [v.n, v.file]), [[1, join(work, 'out/scenes/b01.mp4')], [2, join(work, 'out/scenes/b01-e004.mp4')]]);
  assert.equal(sc.clip.file, join(work, 'out/scenes/b01-e004.mp4'));
});

test('a scene clip is checked against its exact frame plan (160 frames = 5.333 s), within 5% or one frame', async (t) => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'qc-dur-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clip = join(dir, 'b01.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x36:r=30', '-frames:v', '160', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  const QC = join(import.meta.dirname, '..', 'pipelines/_shared/skills/final-pass/qc.mjs');
  const dur = (want) => { spawnSync(process.execPath, [QC, clip, '--fps', '30', '--duration', String(want), '--no-loudness', '--json', join(dir, 'q.json')], { cwd: dir }); return JSON.parse(readFileSync(join(dir, 'q.json'), 'utf8')).checks.find((c) => c.id === 'format.duration').result; };
  assert.equal(dur(5.333), 'pass');
  assert.equal(dur(5), 'fail', 'the old rounded target fails, so it must never be sent');
  // the studio sends the exact length, never Math.round
  const src = readFileSync(join(import.meta.dirname, '..', 'src/quickanimatic.mjs'), 'utf8');
  assert.doesNotMatch(src, /'--duration', String\(Math\.round/);
});

test('a Motion submission marks the scene being made as built (a session submitted it): review, not "Regenerating"', async (t) => {
  const { root, id, work } = setup(t);
  const { sceneGet, scenesSubmitted } = await import('../src/svc/lessons.mjs');
  assert.equal(sceneGet(root, id).scenes[0].state, 'making');
  assert.deepEqual(scenesSubmitted(root, id), [], 'no clip yet: still making');
  mkdirSync(join(work, 'out/scenes'), { recursive: true });
  writeFileSync(join(work, 'out/scenes/b01.mp4'), 'clip');
  writeFileSync(join(work, 'out/scenes/clips.json'), JSON.stringify([{ beats: ['b01'], file: 'b01.mp4', from: 0, to: 124 }]));
  assert.deepEqual(scenesSubmitted(root, id), ['b01']);
  assert.equal(sceneGet(root, id).scenes[0].state, 'review');
});
