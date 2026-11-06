// review.respond: the owner's verdict over the WebSocket, the same gates.respond path as the HTTP review route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { createProject, startProject, addIntakeFile, projectPaths, loadProject } from '../src/projects.mjs';
import * as gates from '../src/gates.mjs';

function harness(t, root) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  return async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    const r = out.find((m) => m.id === id);
    if (!r.ok) { const e = new Error(`${type}: ${r.error.code}: ${r.error.message}`); e.code = r.error.code; throw e; }
    return r.result;
  };
}

async function inReview(root) {
  const p = createProject(root, { pipeline: 'logo-sting', title: 'Acme sting', answers: { mood: 'calm' } });
  await addIntakeFile(root, p.id, { field: 'logo', name: 'logo.svg', buffer: Buffer.from('<svg/>') });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'out'), { recursive: true });
  writeFileSync(join(work, 'out', 'a.png'), 'png');
  const checks = gates.stepChecks(root, p.id, 'directions').map((c) => ({ id: c.id, result: 'pass' }));
  const sub = (extra = {}) => gates.submit(root, p.id, 'directions', { note: 'Three directions', items: [{ path: 'out/a.png', label: 'A' }], error_checks: checks, ...extra });
  return { id: p.id, sub };
}

test('review.respond: changes with notes sends the step back; ok approves; bad input is refused', async (t) => {
  const root = tempStudio(t);
  const call = harness(t, root);
  const { id, sub } = await inReview(root);
  sub();

  await assert.rejects(call('review.respond', { project: id, step: 'directions', verdict: 'maybe' }), /bad_request: verdict/);
  await assert.rejects(call('review.respond', { project: id, step: 'directions', verdict: 'changes' }), /bad_request: say what to change/);
  await assert.rejects(call('review.respond', { project: id, step: 'directions', version: 2, verdict: 'ok' }), /bad_request/);

  const r = await call('review.respond', { project: id, step: 'directions', version: 1, verdict: 'changes', notes: 'Bigger logo' });
  assert.equal(r.verdict, 'changes');
  assert.equal(loadProject(root, id).steps.directions.state, 'changes');
  assert.ok(existsSync(join(projectPaths(root, id).work, 'feedback', 'directions-v1.json')));
  await assert.rejects(call('review.respond', { project: id, step: 'directions', version: 1, verdict: 'ok' }), /isn't waiting for review/);

  // the note reached the next version: it must be answered there
  assert.throws(() => sub(), /note 1 from directions v1 has no answer/);
  sub({ pin_changes: [{ note: 1, change: 'Logo twice the size', status: 'done' }] });
  // no version: the one waiting now
  const ok = await call('review.respond', { project: id, step: 'directions', verdict: 'ok' });
  assert.equal(ok.version, 2);
  assert.equal(loadProject(root, id).steps.directions.state, 'approved');
});

test('review.submission: the whole note past the 300 characters the event keeps; null when nothing was submitted', async (t) => {
  const root = tempStudio(t);
  const call = harness(t, root);
  const { id, sub } = await inReview(root);
  assert.equal(await call('review.submission', { project: id, step: 'directions' }), null);
  const long = `For whom: ${'smart general viewers '.repeat(30)}end.`;
  sub({ note: long });
  const r = await call('review.submission', { project: id, step: 'directions' });
  assert.equal(r.note, long);
  assert.equal(r.version, 1);
  assert.equal(r.items[0].label, 'A');
  assert.equal((await call('review.submission', { project: id, step: 'directions', version: 1 })).note, long);
  assert.equal(await call('review.submission', { project: id, step: 'directions', version: 9 }), null);
  await assert.rejects(call('review.submission', { project: id }), /bad_request: review.submission needs a step/);
});
