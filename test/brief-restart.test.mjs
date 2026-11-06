// The brief's OK after a service restart (2026-11-02, the ice project): the answers came in while the service had no
// open project, so the tick never looked at it and the brief stayed in review. The last answer approves the step
// for the project it names, and the app's closing review.respond OK is a no-op when that already happened, or
// approves with the chat's answers when it did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { createProject, startProject, loadProject, update } from '../src/projects.mjs';
import * as gates from '../src/gates.mjs';

function briefInReview(root, questions) {
  const p = createProject(root, { pipeline: 'explainer', title: 'Ice', answers: { topic: 'ice', length: '60 s' } });
  startProject(root, p.id);
  gates.submit(root, p.id, 'brief', { note: 'Ice, 60 s.', questions, items: [], error_checks: gates.stepChecks(root, p.id, 'brief').map((c) => ({ id: c.id, result: 'pass' })) });
  return p.id;
}

function service(t, root) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => { const id = n++; await svc.handle({ id, type, params }); const r = out.find((m) => m.id === id); if (!r.ok) throw new Error(r.error.message); return r.result; };
  return call;
}

test('after a restart, with no project open, the last chat answer approves the brief', async (t) => {
  const root = tempStudio(t);
  const id = briefInReview(root, [{ id: 'tone', text: 'Tone?', default: 'Warm' }, { id: 'look', text: 'Look?', default: null }]);
  const call = service(t, root); // a fresh service: nothing opened
  await call('chat.answer', { project: id, question: 'tone', value: 'Playful' });
  assert.equal(loadProject(root, id).steps.brief.state, 'in_review', 'one answer is not every answer');
  await call('chat.answer', { project: id, question: 'look', value: 'Chalk' });
  assert.equal(loadProject(root, id).steps.brief.state, 'approved');
  // The app's OK ends with an explicit review.respond: already approved, so nothing changes and nothing fails.
  const r = await call('review.respond', { project: id, step: 'brief', verdict: 'ok', version: 1 });
  assert.equal(r.already, true);
  const fb = gates.feedbackFor(root, id, 'brief');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].answers.find((a) => a.id === 'look').answer, 'Chalk');
});

test('review.respond OK approves with the answers given in the chat, even when no policy ran', async (t) => {
  const root = tempStudio(t);
  const id = briefInReview(root, [{ id: 'look', text: 'Look?', default: null }]);
  // the answer is on record (as chat.answer keeps it) but the step was never approved
  update(root, id, (p) => { p.mfx = { ...(p.mfx || {}), answers: { look: { step: 'brief', text: 'Look?', answer: 'Chalk', at: new Date().toISOString() } } }; });
  const call = service(t, root);
  const r = await call('review.respond', { project: id, step: 'brief', verdict: 'ok', version: 1 });
  assert.equal(r.verdict, 'approve');
  assert.equal(loadProject(root, id).steps.brief.state, 'approved');
  assert.equal(gates.feedbackFor(root, id, 'brief')[0].answers[0].answer, 'Chalk');
});
