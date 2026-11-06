// state.get reports the open project's state and needs_you (it passed the project's record to loadProject, so both were
// always null and a paused project never showed as paused; found by the replay beta driver, 2026-11-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStudio } from './helpers.mjs';
import { createProject, update } from '../src/projects.mjs';
import { createService } from '../src/service.mjs';

test('state.get: the open project\'s state and needs_you', async (t) => {
  const root = tempStudio(t);
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => { const id = n++; await svc.handle({ id, type, params }); return out.find((m) => m.id === id); };
  const p = createProject(root, { pipeline: 'v3', title: 'Paused', answers: { topic: 'x' } });
  update(root, p.id, (x) => { x.state = 'paused'; x.needs_you = { text: 'Claude Code is signed out.', cause: 'login' }; });
  assert.equal((await call('project.open', { id: p.id })).ok, true);
  const r = (await call('state.get')).result;
  assert.equal(r.state, 'paused');
  assert.equal(r.needs_you.cause, 'login');
});
