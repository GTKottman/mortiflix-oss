// Dir2 (2026-11-02): every service restart left the running project "Press Resume". A planned restart (the app closes
// the service's input, or service.restart) marks the sessions it stops; the next runner queues them again by itself with
// "Restarted the studio; picked up again". A crash (no mark) still pauses for the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStudio } from './helpers.mjs';
import { createProject, update, loadProject, readEvents } from '../src/projects.mjs';
import { Runner, markRestart, takeRestartMark } from '../src/runner.mjs';
import { createService } from '../src/service.mjs';

function twoRunning(t) {
  const root = tempStudio(t);
  const ids = ['A', 'B'].map((n) => createProject(root, { pipeline: 'v3', title: n, answers: { topic: n } }).id);
  for (const id of ids) update(root, id, (p) => { p.state = 'queued'; p.session = { running: true, id: 's1', started_at: new Date().toISOString() }; });
  return { root, ids };
}

test('a planned restart picks its sessions up again; an unplanned stop pauses for the owner', (t) => {
  const { root, ids: [planned, crashed] } = twoRunning(t);
  markRestart(root, [planned]);
  const runner = new Runner(root);
  runner.acquire(); t.after(() => runner.release());
  const a = loadProject(root, planned);
  assert.equal(a.state, 'queued'); assert.equal(a.session, null); assert.equal(a.needs_you, null);
  assert.ok(readEvents(root, planned, { limit: 50 }).some((e) => e.event === 'RESUMED' && /Restarted the studio; picked up again/.test(e.details)));
  const b = loadProject(root, crashed);
  assert.equal(b.state, 'paused'); assert.match(b.needs_you.text, /Press Resume/);
  assert.deepEqual(takeRestartMark(root), [], 'the mark is used once');
});

test('an old mark (over 30 min) is not trusted', (t) => {
  const { root, ids: [id] } = twoRunning(t);
  markRestart(root, [id]);
  assert.deepEqual(takeRestartMark(root, -1), []);
});

test('service.drain: no drain = {draining: false}', (t) => {
  const svc = createService({ root: tempStudio(t), send: () => {}, runner: false, tickMs: 0 });
  t.after(() => svc.close());
  assert.deepEqual(svc.handlers['service.drain'](), { draining: false });
});

test('service.restart {drain}: answers at once, starts no new session, waits for the running ones, then exits', async (t) => {
  const root = tempStudio(t);
  let exitedAt = null;
  const sent = [];
  const svc = createService({ root, send: (m) => sent.push(m), runner: true, exit: () => { exitedAt = Date.now(); } });
  t.after(() => svc.close());
  const runner = svc.runner;
  assert.ok(runner, 'the service runs its runner');
  runner.running.set('p1', { projectId: 'p1', abort: new AbortController() }); // a session still running
  const t0 = Date.now();
  const r = await svc.handlers['service.restart']({ drain: true, wait_min: 1 });
  assert.equal(r.restarting, true); assert.deepEqual(r.running, ['p1']);
  assert.ok(Date.now() - t0 < 500, 'answered at once');
  assert.equal(runner.draining, true, 'no new session starts');
  // the app sees the drain: what it waits for, since when, how long at most (Dir1 bdb9: "can't list the sounds yet")
  const d = svc.handlers['service.drain']();
  assert.deepEqual([d.draining, d.waiting_for, d.wait_min], [true, ['p1'], 1]);
  assert.ok(Date.parse(d.started_at) <= Date.now());
  assert.ok(sent.some((m) => m.event === 'service.drain' && m.data?.waiting_for?.[0] === 'p1'), 'pushed as an event');
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.equal(exitedAt, null, 'waits while a session runs');
  runner.running.clear();
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.ok(exitedAt, 'exits once the sessions ended');
});
