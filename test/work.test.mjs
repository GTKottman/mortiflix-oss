// work.active (owner's first run: "It should be obvious what's being worked on"): only real state, in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, update } from '../src/projects.mjs';
import { syncCanvas, canvasView, nodeAction } from '../src/canvas.mjs';
import { activeWork } from '../src/svc/work.mjs';
import { createService } from '../src/service.mjs';

function project(t) {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Work', answers: { topic: 'x' } });
  const work = join(root, 'projects', p.id);
  mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: ['One.', 'Two.', 'Three.'].map((w, i) => ({ id: `b0${i + 1}`, words: w })) }));
  syncCanvas(root, p.id);
  return { root, id: p.id };
}
// the owner's look and motion are picked (the style frames and the animatic wait for them)
const steps = (root, id, done) => update(root, id, (p) => { p.state = 'queued'; p.mfx = { ...p.mfx, look_brief: { vibe: 'calm' }, transition_brief: { transition_pack: null }, motion_brief: { motion_pack: null, rule_packs: [] } }; for (const k of done) p.steps[k] = { state: 'approved', version: 1 }; });

test('work: nothing is animated while no session runs; the steps before the shots are named', (t) => {
  const { root, id } = project(t);
  steps(root, id, ['brief', 'script', 'voice', 'style-frames']);
  const w = activeWork(root, id, { running: false, g: canvasView(root, id) });
  assert.equal(w.running, false);
  assert.deepEqual(w.nodes, []);
  assert.ok(w.before_shots.length >= 1, JSON.stringify(w.before_shots));
});

test('work: the step the runner is on, its pieces not made yet, and the doing line with progress', (t) => {
  const { root, id } = project(t);
  steps(root, id, ['brief', 'script', 'voice', 'style-frames']);
  let w = activeWork(root, id, { running: true, g: canvasView(root, id) });
  assert.equal(w.step.key, 'transitions');
  assert.equal(w.doing, 'Making the transitions between shots: cut 1 of 2');
  assert.deepEqual(w.progress, { done: 0, total: 2, noun: 'transitions' });
  steps(root, id, ['transitions']);
  w = activeWork(root, id, { running: true, g: canvasView(root, id), activity: [{ kind: 'text', text: 'Rendering S02 now' }] });
  assert.equal(w.step.key, 'animatic');
  assert.equal(w.doing, 'Animating shot 1 of 3');
  assert.deepEqual(w.nodes.map((n) => [n.id, n.what, n.v]), [['s01', 'making', 1], ['s02', 'making', 1], ['s03', 'making', 1]]);
  assert.equal(w.current, 's02', 'the activity names the piece it is on');
  // the owner's Fix comes first
  nodeAction(root, id, 's03', { action: 'fix', text: 'bluer' });
  w = activeWork(root, id, { running: true, g: canvasView(root, id), render: { progress: { percent: 40 } } });
  assert.deepEqual(w.nodes.map((n) => [n.id, n.what]), [['s03', 'making']]);
  assert.equal(w.doing, 'Making shot 3 (your Fix) · rendering 40%');
});

test('work: the service sends work.active and the status line says what the AI does', async (t) => {
  const { root, id } = project(t);
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  await svc.handle({ id: 1, type: 'project.open', params: { id } });
  steps(root, id, ['brief', 'script', 'voice', 'style-frames', 'transitions']);
  update(root, id, (p) => { p.session = { running: true, id: 'x' }; });
  svc.poke(0);
  await new Promise((r) => setTimeout(r, 60));
  const ev = out.filter((m) => m.event === 'work.active').at(-1)?.data;
  assert.equal(ev?.doing, 'Animating shot 1 of 3');
  assert.equal(out.filter((m) => m.event === 'status').at(-1).data.line, 'Animating shot 1 of 3');
  await svc.handle({ id: 2, type: 'work.get', params: {} });
  assert.equal(out.find((m) => m.id === 2).result.nodes.length, 3);
});

test('stage statuses: shots count only shots (never the transition board), and all made is ready, never "not started"', async (t) => {
  const { root, id } = project(t);
  const work = join(root, 'projects', id);
  mkdirSync(join(work, 'transitions'), { recursive: true });
  writeFileSync(join(work, 'transitions', 'board.json'), JSON.stringify({ cuts: [{ from_scene: 's01', to_scene: 's02', transition: 'Crossfade' }, { from_scene: 's02', to_scene: 's03', transition: 'Wipe' }] }));
  mkdirSync(join(work, 'voice', 'clips'), { recursive: true });
  const wav = Buffer.alloc(64);
  writeFileSync(join(work, 'voice', 'clips', 'b01-1.wav'), wav);
  writeFileSync(join(work, 'voice', 'clips', 'b02-1.wav'), wav);
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify([{ id: 'b01-1', text: 'One.' }, { id: 'b02-1', text: 'Two.' }]));
  syncCanvas(root, id);
  const { stageStatuses } = await import('../src/svc/stages.mjs');
  const st = stageStatuses(root, id);
  assert.equal(st[4].total, 3, 'three shots, the two transitions not counted');
  assert.equal(st[4].text, '0/3 shots');
  assert.equal(st[1].kind, 'ready');
  assert.equal(st[1].text, '2/2 voice lines ready');
});

test('a stop says when Claude Code\'s login is the cause, and project.resume carries on', async (t) => {
  const { loginTrouble } = await import('../src/runner.mjs');
  assert.ok(loginTrouble('Claude Code stopped (1): OAuth session expired. Please run /login'));
  assert.ok(!loginTrouble('the render timed out'));
  const { root, id } = project(t);
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  await svc.handle({ id: 1, type: 'project.open', params: { id } });
  update(root, id, (p) => { p.state = 'paused'; p.needs_you = { text: 'The last two sessions stopped without moving the project forward (OAuth session expired). Check the activity log, then resume.', at: 'x', cause: 'login' }; });
  svc.status(true);
  const st = out.filter((m) => m.event === 'status').at(-1).data;
  assert.equal(st.state, 'paused');
  assert.equal(st.needs_you.cause, 'login');
  await svc.handle({ id: 2, type: 'project.resume', params: {} });
  assert.equal(out.find((m) => m.id === 2).ok, true);
  svc.status(true);
  assert.equal(out.filter((m) => m.event === 'status').at(-1).data.needs_you, null);
});
