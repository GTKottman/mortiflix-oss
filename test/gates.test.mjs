import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, addIntakeFile, projectPaths, loadProject } from '../src/projects.mjs';
import * as gates from '../src/gates.mjs';

const checksFor = (root, id, step) => gates.stepChecks(root, id, step).map((c) => ({ id: c.id, result: 'pass' }));

async function stingProject(root) {
  const p = createProject(root, { pipeline: 'logo-sting', title: 'Acme sting', answers: { mood: 'calm' } });
  await addIntakeFile(root, p.id, { field: 'logo', name: 'logo.svg', buffer: Buffer.from('<svg/>') });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'out'), { recursive: true });
  writeFileSync(join(work, 'out', 'a.png'), 'png');
  return { id: p.id, work };
}

test('a required intake answer blocks the start', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'logo-sting', title: 'x' });
  assert.throws(() => startProject(root, p.id), /required/);
});

test('submit enforces items, checks, folder and review mode', async (t) => {
  const root = tempStudio(t);
  const { id, work } = await stingProject(root);
  const ok = { note: 'Three directions', items: [{ path: 'out/a.png', label: 'A' }], error_checks: checksFor(root, id, 'directions') };

  assert.throws(() => gates.submit(root, id, 'directions', { ...ok, note: '' }), /note/);
  assert.throws(() => gates.submit(root, id, 'directions', { ...ok, items: [{ text: 'just words' }] }), /frames step needs/);
  assert.throws(() => gates.submit(root, id, 'directions', { ...ok, error_checks: [] }), /missing/);
  assert.throws(() => gates.submit(root, id, 'directions', { ...ok, error_checks: [...ok.error_checks.slice(1), { id: ok.error_checks[0].id, result: 'n/a' }] }), /needs a note/);
  assert.throws(() => gates.submit(root, id, 'directions', { ...ok, items: [{ path: '../../../etc/passwd' }] }), /outside|doesn't exist/);
  symlinkSync(process.execPath, join(work, 'out', 'sneaky.png')); // a file that's there on every system, outside the project
  assert.throws(() => gates.submit(root, id, 'directions', { ...ok, items: [{ path: 'out/sneaky.png' }] }), /outside/);
  assert.throws(() => gates.submit(root, id, 'final', ok), /can't start yet/);

  const r = gates.submit(root, id, 'directions', ok);
  assert.equal(r.version, 1);
  assert.equal(loadProject(root, id).state, 'waiting');
  // What was submitted is a copy: changing the working file doesn't change the review.
  writeFileSync(join(work, 'out', 'a.png'), 'changed');
  const sub = gates.submissions(root, id)[0];
  assert.equal(readFileSync(join(projectPaths(root, id).state, sub.items[0].file), 'utf8'), 'png');
  assert.throws(() => gates.submit(root, id, 'directions', ok), /already waiting/);
});

test('only the reviewer approves; internal steps need their checks', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Bikes', answers: { topic: 'city bikes' } });
  startProject(root, p.id);
  assert.throws(() => gates.stepDone(root, p.id, 'brief', []), /only your approval/);
  assert.throws(() => gates.stepDone(root, p.id, 'build', checksFor(root, p.id, 'build')), /can't finish yet/);
  assert.throws(() => gates.status(root, p.id, 'made-up'), /no status line/);
  assert.equal(gates.status(root, p.id, 'brief').text, 'Reading your brief');
});

test('every note is answered in the next version', async (t) => {
  const root = tempStudio(t);
  const { id } = await stingProject(root);
  const sub = { note: 'v', items: [{ path: 'out/a.png', label: 'A' }], error_checks: checksFor(root, id, 'directions'), questions: [{ id: 'pick', text: 'Which?', choices: ['A', 'B'], default: 'A' }, { id: 'name', text: 'Name on it?' }] };
  gates.submit(root, id, 'directions', sub);
  assert.throws(() => gates.respond(root, id, 'directions', 1, { verdict: 'changes', notes: [{ text: 'warmer', item: 0, x: 0.5, y: 0.2 }] }), /needs an answer/);
  gates.respond(root, id, 'directions', 1, { verdict: 'changes', notes: [{ text: 'warmer', item: 0, x: 0.5, y: 0.2 }, { text: 'slower' }], answers: { name: 'Acme' } });
  const p = loadProject(root, id);
  assert.equal(p.state, 'queued');
  assert.ok(existsSync(join(projectPaths(root, id).work, 'feedback', 'directions-v1.json')));

  assert.throws(() => gates.submit(root, id, 'directions', sub), /note 1 .* has no answer/);
  assert.throws(() => gates.submit(root, id, 'directions', { ...sub, pin_changes: [{ note: 1, change: 'warmed', status: 'done' }] }), /note 2/);
  const r = gates.submit(root, id, 'directions', { ...sub, pin_changes: [{ note: 1, change: 'Warmed the light', status: 'done' }, { note: 2, change: 'Slowed to 4 s', status: 'partly' }] });
  assert.equal(r.version, 2);
  gates.respond(root, id, 'directions', 2, { verdict: 'approve', answers: { name: 'Acme' } });
  assert.equal(loadProject(root, id).steps.directions.state, 'approved');
  assert.throws(() => gates.submit(root, id, 'directions', sub), /already approved/);
});

test('questions pause the project until answered', async (t) => {
  const root = tempStudio(t);
  const { id } = await stingProject(root);
  gates.ask(root, id, 'directions', 'Should the logo spin?', { default: 'No' });
  assert.equal(loadProject(root, id).state, 'waiting');
  gates.answerQuestion(root, id, 'q1', null);
  const p = loadProject(root, id);
  assert.equal(p.state, 'queued');
  assert.equal(p.questions[0].answer, 'No');
  assert.equal(p.questions[0].used_default, true);
});

test('proposed checks join the checklist once approved', async (t) => {
  const root = tempStudio(t);
  const { id } = await stingProject(root);
  const before = gates.stepChecks(root, id, 'directions').length;
  const { id: cid } = gates.proposeCheck(root, id, { title: 'No widow words', how: 'No single word alone on a line', work: 'stills' });
  assert.equal(gates.stepChecks(root, id, 'directions').length, before);
  gates.decideCheck(root, cid, true);
  assert.equal(gates.stepChecks(root, id, 'directions').length, before + 1);
  assert.throws(() => gates.proposeCheck(root, id, { title: 'x', how: 'y', work: 'colour' }), /isn't one of/);
});
