// Several app tabs, each on its own project (RUN-BUGS Dir1): a call that names its project acts on that project even
// when another tab opened a different one last, and every opened project keeps getting its own status events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { createProject, loadProject } from '../src/projects.mjs';
import { mfxView } from '../src/svc/stages.mjs';

function harness(t, root) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    const r = out.find((m) => m.id === id);
    if (!r.ok) throw new Error(`${type}: ${r.error.code}: ${r.error.message}`);
    return r.result;
  };
  return { call, out };
}

const make = (root, title) => createProject(root, { pipeline: 'logo-sting', title, answers: { mood: 'calm' } }).id;

test('a call with project acts on that project, not the one opened last', async (t) => {
  const root = tempStudio(t);
  const { call, out } = harness(t, root);
  const a = make(root, 'Tab A');
  const b = make(root, 'Tab B');
  await call('project.open', { id: a });
  await call('project.open', { id: b });

  out.length = 0;
  await call('chat.action', { project: a, text: 'pressed OK' });
  const row = out.find((m) => m.event === 'chat.message');
  assert.equal(row.data.project, a, 'chat.message names its project');

  await call('stage.set', { project: a, stage: 2 });
  assert.equal(mfxView(loadProject(root, a)).stage, 2);
  assert.notEqual(mfxView(loadProject(root, b)).stage, 2, 'the other project did not move');
  assert.equal((await call('state.get')).project.id, b, 'the open project stays the other tab\'s');
});

test('every opened project gets its own status event', async (t) => {
  const root = tempStudio(t);
  const { call, out } = harness(t, root);
  const a = make(root, 'Tab A');
  const b = make(root, 'Tab B');
  await call('project.open', { id: a });
  await call('project.open', { id: b });
  out.length = 0;
  await call('stage.set', { project: b, stage: 1 });
  const projects = out.filter((m) => m.event === 'status').map((m) => m.data.project);
  assert.ok(projects.includes(a) && projects.includes(b), `status for both: ${projects}`);
  const forA = out.find((m) => m.event === 'status' && m.data.project === a);
  assert.equal(forA.data.title, 'Tab A');
});
