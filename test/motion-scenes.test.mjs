// Scenes one at a time: scene 1 alone, the OK builds only scene 2 (scene 1 is not rendered again), the lessons from scene 1's
// notes reach scene 2's prompt as mistakes never to repeat, no prompt tells the AI to copy another scene's motion, and making
// every scene together only happens after the warning is confirmed. No AI, no render, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths, loadProject } from '../src/projects.mjs';
import { sceneAheadStart, sceneBuilt, sceneRemaking, scenesSubmitted, sceneGet, sceneApprove, saveNote, approveLesson, lessonsBlock, sendNotes, listNotes, deleteNote, listLessons, firstWaits } from '../src/svc/lessons.mjs';
import { approveScene, allScenes } from '../src/svc/stages.mjs';
import { deriveMotionData, writeMotionData } from '../src/motiondata.mjs';
import * as qa from '../src/quickanimatic.mjs';

const COPY = /test clip|like scene 1|same motion|match the first|move like|copy scene|copy the first|copy its motion/i;

function setup(t) {
  const root = tempStudio(t);
  const id = createProject(root, { pipeline: 'v3', title: 'Scenes', answers: { topic: 'x' } }).id;
  const work = projectPaths(root, id).work;
  mkdirSync(join(work, 'script'), { recursive: true });
  const beats = ['b01', 'b02', 'b03'].map((b, i) => ({ id: b, name: `Scene ${i + 1}`, visual: `v${i}`, lines: [{ id: `${b}-1`, words: `Words ${i}.` }] }));
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats }));
  const lines = beats.map((b, i) => ({ id: `${b.id}-1`, text: `Words ${i}.`, start: i * 4 + 0.5, end: i * 4 + 3, words: [{ text: 'Words', start: i * 4 + 0.5 }] }));
  const timing = { seconds: 12, lines };
  return { root, id, work, beats, timing };
}

test('scene 1 alone, OK builds only scene 2, lessons reach it as mistakes never to repeat', async (t) => {
  const { root, id, work, beats, timing } = setup(t);
  assert.equal(firstWaits(root, id), true);
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['making', 'waiting', 'waiting']);
  let tg = qa.buildTarget(root, id, beats, timing);
  assert.deepEqual(tg.ids, ['b01']); assert.equal(tg.partial, true); assert.equal(tg.from, 0);
  // the owner's notes on scene 1 become a lesson
  const n = await saveNote(root, id, { node: 'b01', time: 1, text: 'titles landed too hard', send: false }, { fix: () => assert.fail('pending notes must not send a fix'), ask: async () => '{"lesson":"Titles settle softly, never slam.","section":"Motion"}' });
  assert.equal(n.note.pending, true); assert.equal(n.edit, null);
  approveLesson(root, id, n.lesson.id, 'project');
  // scene 1 was built: its clip exists
  mkdirSync(join(work, 'out', 'scenes'), { recursive: true });
  writeFileSync(join(work, 'out', 'scenes', 'b01.mp4'), 'clip1');
  writeFileSync(join(work, 'out', 'scenes', 'clips.json'), JSON.stringify([{ beats: ['b01'], file: 'b01.mp4', from: 0, to: tg.to }]));
  // not approved: scene 2 is refused out of turn
  assert.throws(() => sceneApprove(root, id, 'b02'), /being checked/);
  const r = approveScene(root, id, 'b01');
  assert.equal(r.next, 'b02');
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['ok', 'making', 'waiting']);
  tg = qa.buildTarget(root, id, beats, timing);
  assert.deepEqual(tg.ids, ['b02'], 'only scene 2 is built');
  assert.equal(tg.from, tg.all[1].from_frame); assert.ok(tg.from > 0);
  assert.deepEqual(tg.doneScenes.map((x) => x.beat), ['b01']);
  const c = { ...{ only: 'b02', target: tg, done: tg.doneScenes }, work, project: { title: 'Scenes' }, script: { beats: [beats[1]] }, timing: { seconds: tg.to / 30, lines: [] }, board: { cuts: [] }, frames: [], lines: [], brief: {} };
  const prompt = qa.writePrompt(root, id, c);
  assert.match(prompt, /Titles settle softly/, 'the lesson from scene 1 notes is in scene 2');
  assert.match(prompt, /Mistakes never to repeat/);
  assert.match(prompt, /Do NOT copy their motion/);
  assert.match(prompt, /ONLY scene b02/);
  assert.doesNotMatch(prompt, /\bb03\b/);
  assert.doesNotMatch(prompt, COPY);
  assert.doesNotMatch(lessonsBlock(root, id, { mark: false }), COPY);
  // the render of scene 2 is its own frames only: scene 1 is not rendered again
  const argvs = [];
  const renders = { add: (j) => { argvs.push(j.argv.join(' ')); mkdirSync(join(work, 'out', 'scenes'), { recursive: true }); writeFileSync(join(work, 'out', 'scenes', 'b02.mp4'), 'clip2'); return { id: 1, state: 'done', exit_code: 0 }; }, wait: async () => ({ state: 'done', exit_code: 0 }) };
  const ok = await qa.renderAnimatic({ root, renders, projectId: id, sessionId: 's', c, env: {}, frames: [tg.from, tg.to - 1], output: '../out/scenes/b02.mp4' });
  assert.equal(ok.ok, true);
  assert.equal(argvs.length, 1);
  assert.match(argvs[0], new RegExp(`--range ${tg.from}\\.\\.=${tg.to - 1}`));
  assert.doesNotMatch(argvs[0], /--range 0\.\./);
  assert.equal(readFileSync(join(work, 'out', 'scenes', 'b01.mp4'), 'utf8'), 'clip1', 'scene 1 clip untouched');
  // the last scene: approving it leaves nothing to build and the animatic may be approved
  approveScene(root, id, 'b02');
  assert.equal(approveScene(root, id, 'b03').next, null);
  assert.equal(firstWaits(root, id), false);
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['ok', 'ok', 'ok']);
});

test('motion.scene.all: warning without confirm builds nothing, confirm builds the rest', (t) => {
  const { root, id, beats, timing } = setup(t);
  const w = allScenes(root, id, false);
  assert.equal(w.needs_confirm, true);
  assert.match(w.warning, /none of them learn from your notes on scene 1/);
  assert.match(w.warning, /other 2 scenes/);
  assert.equal(sceneGet(root, id).mode, 'one');
  assert.deepEqual(qa.buildTarget(root, id, beats, timing).ids, ['b01'], 'nothing else is built');
  const r = allScenes(root, id, true);
  assert.equal(r.started, true); assert.equal(sceneGet(root, id).mode, 'all');
  assert.deepEqual(qa.buildTarget(root, id, beats, timing).ids, ['b01', 'b02', 'b03']);
  assert.equal(qa.buildTarget(root, id, beats, timing).partial, false);
  assert.equal(firstWaits(root, id), false);
});

test('legacy motion_first migrates; notes.send sends all pending as one fix; notes.delete', async (t) => {
  const { root, id } = setup(t);
  const { update } = await import('../src/projects.mjs');
  update(root, id, (p) => { p.mfx = { ...(p.mfx || {}), motion_first: { approved: true, at: 'x' } }; });
  assert.equal(sceneGet(root, id).mode, 'all'); assert.equal(sceneGet(root, id).scenes[0].state, 'ok');
  const fixes = [];
  const a = await saveNote(root, id, { node: 'b02', time: 1, text: 'one', send: false }, {});
  await saveNote(root, id, { node: 'b02', time: 2, text: 'two', send: false }, {});
  await saveNote(root, id, { node: 'b03', time: 2, text: 'other scene', send: false }, {});
  const s = sendNotes(root, id, 'b02', { fix: (node, text) => { fixes.push([node, text]); return { edit: { id: 'e9' } }; } });
  assert.equal(s.sent, 2); assert.equal(fixes.length, 1);
  assert.match(fixes[0][1], /1\. At 1\.00 s: one[\s\S]*2\. At 2\.00 s: two/); assert.doesNotMatch(fixes[0][1], /other scene/);
  assert.equal(listNotes(root, id, 'b03').notes[0].pending, true);
  assert.throws(() => sendNotes(root, id, 'b02', { fix: () => null }), /no pending/);
  deleteNote(root, id, listNotes(root, id, 'b03').notes[0].id);
  assert.equal(listNotes(root, id, 'b03').notes.length, 0);
});

test('motion data: a new scene probes only its own frames and keeps the approved scenes\' results', async (t) => {
  const { root, id, work } = setup(t);
  const probed = [];
  const probe = async (f) => { probed.push(f); return { width: 1920, height: 1080, layers: [{ id: 't', opacity: 1, bounds: { x: 100, y: 100, width: 300, height: 80 }, text: { text: 'Hello' } }] }; };
  mkdirSync(join(work, 'out'), { recursive: true }); mkdirSync(join(work, 'video', 'src'), { recursive: true });
  writeFileSync(join(work, 'out', 'scenes.json'), JSON.stringify({ scenes: [{ key: 's01', from_frame: 0, frames: 120, keys: [{ word: 'Words', at_frame: 15 }], boxes: [{ text: 'Old' }] }] }));
  writeFileSync(join(work, 'video', 'src', 'actions.json'), JSON.stringify([{ shot: 's01', at_frame: 20, at_sec: 0.667, what: 'Old action' }]));
  const scenes = [{ key: 's01', from_frame: 0, frames: 120 }, { key: 's02', from_frame: 120, frames: 120 }];
  const r = await writeMotionData({ work, scenes, fps: 30, totalFrames: 240, from: 120, timing: { lines: [] }, probe });
  assert.equal(r.ok, true);
  assert.ok(probed.length && probed.every((f) => f >= 120 && f < 240), `probed ${probed.join(',')}`);
  assert.deepEqual(scenes[0].keys, [{ word: 'Words', at_frame: 15 }]); assert.equal(scenes[0].boxes[0].text, 'Old');
  assert.equal(scenes[1].boxes[0].text, 'Hello'); assert.equal(scenes[1].boxes[0].from_frame, 120);
  assert.equal(JSON.parse(readFileSync(join(work, 'video', 'src', 'actions.json'), 'utf8'))[0].what, 'Old action');
});

test('no prompt or skill in the source tells the AI to copy another scene\'s motion', () => {
  const walk = (d, out = []) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'vendor'].includes(e.name)) continue; const p = join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(mjs|md|json|tsx?)$/.test(e.name)) out.push(p); } return out; };
  const here = join(import.meta.dirname, '..');
  const bad = [];
  for (const d of ['src', 'pipelines']) for (const f of walk(join(here, d))) if (COPY.test(readFileSync(f, 'utf8').replace(/Do NOT copy their motion/g, ''))) bad.push(f);
  assert.deepEqual(bad, []);
});

// The owner's rule (2026-11-04): while one scene is checked the next is made, one ahead; after many notes the OK asks.
test('one scene is made ahead of the one being checked, never two', (t) => {
  const { root, id, beats, timing } = setup(t);
  sceneBuilt(root, id, ['b01']);
  assert.equal(sceneAheadStart(root, id).id, 'b02');
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['review', 'making', 'waiting']);
  assert.deepEqual(qa.buildTarget(root, id, beats, timing).ids, ['b02']);
  assert.equal(sceneAheadStart(root, id), null, 'only one ahead');
  sceneBuilt(root, id, ['b02']);
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['review', 'ready', 'waiting']);
  assert.equal(sceneAheadStart(root, id), null, 'b03 waits until b02 is the one being checked');
  assert.throws(() => sceneApprove(root, id, 'b02'), /being checked/);
  const r = sceneApprove(root, id, 'b01');
  assert.equal(r.next_ready, true);
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['ok', 'review', 'waiting']);
  assert.equal(sceneAheadStart(root, id).id, 'b03');
});

test('a Fix on the checked scene builds it, not the scene made ahead, and the old clip does not count as new', (t) => {
  const { root, id, work, beats, timing } = setup(t);
  sceneBuilt(root, id, ['b01']);
  sceneAheadStart(root, id);
  sceneBuilt(root, id, ['b02']);
  sceneRemaking(root, id, 'b01');
  assert.deepEqual(qa.buildTarget(root, id, beats, timing).ids, ['b01']);
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['making', 'ready', 'waiting']);
  // the Fix waits while a scene is ahead: that scene's submission must not mark the old clip of the checked one as built
  mkdirSync(join(work, 'out', 'scenes'), { recursive: true });
  writeFileSync(join(work, 'out', 'scenes', 'b01.mp4'), 'c');
  writeFileSync(join(work, 'out', 'scenes', 'b03.mp4'), 'c');
  writeFileSync(join(work, 'out', 'scenes', 'clips.json'), JSON.stringify([{ beats: ['b01'], file: 'b01.mp4', from: 0, to: 9 }, { beats: ['b03'], file: 'b03.mp4', from: 20, to: 30 }]));
  sceneBuilt(root, id, ['b01']);
  sceneApprove(root, id, 'b01');
  sceneAheadStart(root, id);
  sceneRemaking(root, id, 'b02');
  assert.deepEqual(scenesSubmitted(root, id), ['b03']);
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['ok', 'making', 'ready']);
});

test('the OK asks about remaking the next scene only after many notes since it was started', async (t) => {
  const { root, id } = setup(t);
  sceneBuilt(root, id, ['b01']);
  sceneAheadStart(root, id);
  const note = (text) => saveNote(root, id, { node: 'b01', time: 1, text, send: false }, { fix: () => null });
  await note('one');
  await note('two');
  assert.deepEqual(sceneGet(root, id).next, { beat: 'b02', made: false, notes: 2, ask: false });
  await note('three');
  assert.equal(sceneGet(root, id).next.ask, true);
  sceneBuilt(root, id, ['b02']);
  assert.deepEqual(sceneGet(root, id).next, { beat: 'b02', made: true, notes: 3, ask: true });
  const r = approveScene(root, id, 'b01', { remakeNext: true });
  assert.equal(r.remaking, true);
  assert.deepEqual(sceneGet(root, id).scenes.map((s) => s.state), ['ok', 'making', 'waiting']);
});

test('a scene a session listed only in out/scenes.json joins clips.json and comes up for the OK (Texas b02)', (t) => {
  const { root, id, work } = setup(t);
  const out = join(work, 'out');
  mkdirSync(join(out, 'scenes'), { recursive: true });
  writeFileSync(join(out, 'scenes', 'b01-v1.mp4'), 'c');
  writeFileSync(join(out, 'scenes', 'b02-v1.mp4'), 'c');
  writeFileSync(join(out, 'scenes', 'clips.json'), JSON.stringify([{ beats: ['b01'], file: 'b01-v1.mp4', from: 0, to: 258, versions: [{ n: 1, file: 'b01-v1.mp4' }] }]));
  writeFileSync(join(out, 'scenes.json'), JSON.stringify({ scenes: [{ beat: 'b01', from_frame: 0, frames: 258, file: 'out/scenes/b01-v1.mp4' }, { beat: 'b02', from_frame: 258, frames: 152, file: 'out/scenes/b02-v1.mp4' }] }));
  sceneBuilt(root, id, ['b01']);
  sceneApprove(root, id, 'b01');
  assert.deepEqual(scenesSubmitted(root, id), ['b02']);
  assert.equal(sceneGet(root, id).scenes[1].state, 'review');
  assert.equal(sceneGet(root, id).scenes[1].clip.from, 258);
});
