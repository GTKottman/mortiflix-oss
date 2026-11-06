// Sessions across projects at once (owner, 2026-11-02: "If you have the space, use it"): sessions.parallel "auto" =
// min(4, floor(0.7 x free RAM / the measured peak, 1.5 GB until measured)); never an extra one under 4 GB free; one per project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { saveConfig } from '../src/studio.mjs';
import { createProject, update } from '../src/projects.mjs';
import { Runner } from '../src/runner.mjs';
import { sessionSlots, mayStartSession, recordPeak, loadPeak, SEED_PEAK } from '../src/svc/sessionslots.mjs';

const GB = 1024 ** 3;

test('auto slots: 0.7 x free RAM / peak, at most 4; a number is taken as it is', () => {
  assert.equal(sessionSlots({ available: 3 * GB }), 1);
  assert.equal(sessionSlots({ available: 5 * GB }), 2); // 3.5 / 1.5
  assert.equal(sessionSlots({ available: 64 * GB }), 4);
  assert.equal(sessionSlots({ available: 64 * GB, peak: 8 * GB }), 4);
  assert.equal(sessionSlots({ available: 20 * GB, peak: 6 * GB }), 2);
  assert.equal(sessionSlots({ setting: 6, available: 1 * GB }), 6);
  assert.equal(sessionSlots({ setting: 'nonsense', available: 64 * GB }), 4);
});

test('the first session always starts; an extra one needs a free slot and 4 GB free', () => {
  assert.equal(mayStartSession({ running: 0, available: 1 * GB }), null);
  assert.equal(mayStartSession({ running: 1, available: 3.9 * GB, setting: 3 }), 'memory');
  assert.equal(mayStartSession({ running: 1, available: 16 * GB }), null);
  assert.equal(mayStartSession({ running: 4, available: 64 * GB }), 'slot');
});

test('measured peaks: the highest of the last few, a tiny one is not trusted', (t) => {
  const root = tempStudio(t);
  const f = join(root, 'run', 'session-peaks.json');
  assert.equal(loadPeak(f), SEED_PEAK);
  recordPeak(f, 0.1 * GB);
  assert.equal(loadPeak(f), SEED_PEAK);
  recordPeak(f, 2 * GB); recordPeak(f, 1 * GB);
  assert.equal(loadPeak(f), 2 * GB);
});

test('the runner runs queued projects at once when there is room, one session per project', async (t) => {
  const root = tempStudio(t);
  saveConfig(root, { sessions: { parallel: 'auto' } });
  const ids = [0, 1, 2].map((i) => createProject(root, { pipeline: 'v3', title: `P${i}`, answers: { topic: `T${i}` } }).id);
  for (const id of ids) update(root, id, (p) => { p.state = 'queued'; p.queued_at = new Date(Date.now() + ids.indexOf(id)).toISOString(); });
  const runner = new Runner(root);
  runner.mem = () => 64 * GB;
  let live = 0; let most = 0; const seen = [];
  runner.runSession = async (id) => {
    runner.running.set(id, { projectId: id, abort: new AbortController() });
    live++; most = Math.max(most, live); seen.push(id);
    await new Promise((ok) => setTimeout(ok, 50));
    update(root, id, (p) => { p.state = 'waiting'; });
    live--;
  };
  await runner.loop();
  assert.equal(most, 3, 'all three at once');
  assert.deepEqual(seen, ids, 'oldest first');
  // with 6 GB free: two at most (0.7 x 6 / 1.5 = 2)
  for (const id of ids) update(root, id, (p) => { p.state = 'queued'; });
  runner.mem = () => 6 * GB; most = 0;
  await runner.loop();
  assert.equal(most, 2);
  // sessions.parallel 1: the old one-at-a-time
  saveConfig(root, { sessions: { parallel: 1 } });
  for (const id of ids) update(root, id, (p) => { p.state = 'queued'; });
  runner.mem = () => 64 * GB; most = 0;
  await runner.loop();
  assert.equal(most, 1);
});
