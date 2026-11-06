// Parallel renders: as many at once as the CPU and the free RAM allow (owner, 2026-11-02), fair between projects, with the
// RAM per render measured. Fake CPU and RAM; app renders (addExternal) need no processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RenderQueue, autoSlots, renderThreads, renderKind, treeRss, SEED_PEAK } from '../src/renderq.mjs';

const GB = 1024 ** 3;
const temp = (t) => { const d = mkdtempSync(join(tmpdir(), 'mfx-rqs-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const queue = (t, o = {}) => new RenderQueue({ logDir: temp(t), sweepMs: 0, sampleMs: 0, cpus: () => 16, mem: () => 30 * GB, table: () => null, ...o });
const states = (q) => q.list().map((v) => v.state);

test('auto slots: min(CPU threads / threads per render, floor(0.7 x available / peak)), never below 1', () => {
  assert.equal(renderThreads(16), 4, 'Kinetograph\'s default: half the cores, at most 4');
  assert.equal(renderThreads(4), 2);
  assert.equal(autoSlots({ cpus: 16, available: 32 * GB, peak: SEED_PEAK }), 4, 'CPU-bound on a 16-thread, 32 GB machine');
  assert.equal(autoSlots({ cpus: 16, available: 13 * GB, peak: SEED_PEAK }), 2, 'RAM-bound at 13 GB available');
  assert.equal(autoSlots({ cpus: 16, available: 13 * GB, peak: 1.5 * GB }), 4, 'a measured small render fits more');
  assert.equal(autoSlots({ cpus: 16, available: 2 * GB, peak: SEED_PEAK }), 1);
  assert.equal(autoSlots({ cpus: 2, available: 64 * GB, peak: GB }), 2);
});

test('auto: renders run side by side up to the CPU slots; the rest wait with a true count ahead', (t) => {
  const q = queue(t);
  const v = Array.from({ length: 6 }, (_, i) => q.addExternal({ projectId: 'p', label: `Export ${i}` }));
  assert.deepEqual(states(q), ['running', 'running', 'running', 'running', 'waiting', 'waiting']);
  const w = q.list().slice(4);
  assert.deepEqual(w.map((x) => [x.renders_ahead, x.renders_running]), [[0, 4], [1, 4]]);
  q.finish(v[1].id, { ok: true });
  assert.deepEqual(states(q), ['running', 'done', 'running', 'running', 'running', 'waiting'], 'a freed slot is filled at once');
  assert.equal(q.list()[5].renders_ahead, 0);
  assert.equal(q.slots(), 4);
});

test('auto backs off when RAM is low: a second render never starts under 4 GB available or 0.7 x free < its peak; the first always does', (t) => {
  let mem = 5 * GB;
  const q = queue(t, { mem: () => mem });
  q.addExternal({ projectId: 'p', label: 'A' });
  const b = q.addExternal({ projectId: 'p', label: 'B' });
  assert.deepEqual(states(q), ['running', 'waiting']);
  assert.equal(q.list()[1].waiting_for, 'memory');
  // 12 GB available, but the running one is counted at its peak (4.5 GB seed, nothing measured yet): 7.5 GB free, 0.7 x 7.5 >= 4.5.
  mem = 12 * GB; q.pump();
  assert.deepEqual(states(q), ['running', 'running']);
  // 3 GB free after both reserves: a third waits.
  q.addExternal({ projectId: 'p', label: 'C' });
  assert.equal(q.list()[2].waiting_for, 'memory');
  q.finish(b.id, { ok: true });
  assert.deepEqual(states(q), ['running', 'done', 'running']);
  mem = 2 * GB;
  assert.equal(q.slots(), 1);
});

test('renders.parallel as a number caps the slots (still never under 4 GB free); read on every decision', (t) => {
  let parallel = 2;
  const q = queue(t, { parallel: () => parallel });
  for (const l of ['a', 'b', 'c', 'd']) q.addExternal({ projectId: 'p', label: l });
  assert.deepEqual(states(q), ['running', 'running', 'waiting', 'waiting']);
  assert.equal(q.list()[2].waiting_for, undefined, 'waiting for a slot, not memory');
  parallel = 3; q.pump();
  assert.deepEqual(states(q), ['running', 'running', 'running', 'waiting']);
  parallel = 'auto'; q.pump();
  assert.deepEqual(states(q), ['running', 'running', 'running', 'running']);
});

test('fair: a project with fewer renders running goes first, then the one that started longest ago; nobody starves', (t) => {
  const q = queue(t, { parallel: 2 });
  const a = ['A1', 'A2', 'A3', 'A4'].map((l) => q.addExternal({ projectId: 'A', label: l }));
  const b1 = q.addExternal({ projectId: 'B', label: 'B1' });
  const c1 = q.addExternal({ projectId: 'C', label: 'C1' });
  // A1 and A2 run; B1 and C1 (no render running) start before A3 although A3 was queued first.
  const ahead = Object.fromEntries(q.list().filter((v) => v.state === 'waiting').map((v) => [v.label, v.renders_ahead]));
  assert.deepEqual(ahead, { B1: 0, C1: 1, A3: 2, A4: 3 });
  q.finish(a[0].id, { ok: true });
  assert.equal(q.list().find((v) => v.id === b1.id).state, 'running');
  q.finish(a[1].id, { ok: true });
  assert.equal(q.list().find((v) => v.id === c1.id).state, 'running');
  q.finish(b1.id, { ok: true });
  assert.equal(q.list().find((v) => v.id === a[2].id).state, 'running', 'then A again');
});

test('app renders still start, report and finish beside command renders', async (t) => {
  const dir = temp(t);
  const q = new RenderQueue({ logDir: dir, sweepMs: 0, sampleMs: 0, cpus: () => 16, mem: () => 30 * GB, table: () => null });
  const cmd = q.add({ projectId: 'p', sessionId: 's', label: 'Animatic', argv: ['sh', '-c', 'sleep 0.3'], cwd: dir, env: process.env });
  const app = q.addExternal({ projectId: 'p', label: 'Final export' });
  assert.deepEqual([cmd.state, app.state], ['running', 'running']);
  assert.equal(q.report(app.id, { done: 5, total: 10 }).progress.percent, 50);
  assert.equal(q.finish(app.id, { ok: true }).state, 'done');
  assert.equal((await q.wait(cmd.id, 'p', 5)).state, 'done');
});

test('the peak RAM of a render\'s process tree is measured, kept per kind in peaks.json, and used for the next decision', async (t) => {
  const dir = temp(t);
  let q;
  // A fake /proc: the render's group leader at 1 GB, one child of it at 1.5 GB, an unrelated process ignored.
  const table = () => {
    const j = [...q.jobs.values()].find((x) => x.state === 'running' && x.proc);
    if (!j) return [];
    const pid = j.proc.pid;
    return [{ pid, ppid: 1, pgrp: pid, rss: 1 * GB }, { pid: pid + 100000, ppid: pid, pgrp: pid + 100000, rss: 1.5 * GB }, { pid: 2, ppid: 1, pgrp: 2, rss: 9 * GB }];
  };
  q = new RenderQueue({ logDir: dir, sweepMs: 0, sampleMs: 20, cpus: () => 16, mem: () => 13 * GB, table });
  assert.equal(q.slots(), 2, 'seeded: 0.7 x 13 / 4.5');
  const job = q.add({ projectId: 'p', sessionId: 's', label: 'style frames (3)', argv: ['sh', '-c', 'sleep 0.3'], cwd: dir, env: process.env });
  assert.equal((await q.wait(job.id, 'p', 5)).state, 'done');
  const kind = renderKind('style frames (5)');
  assert.equal(kind, 'style frames');
  assert.equal(q.peakOf(kind), 2.5 * GB);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'peaks.json'), 'utf8'))[kind], [2.5 * GB]);
  // A new queue (the service restarted) reads it back; an unmeasured kind still uses the seed.
  const again = new RenderQueue({ logDir: dir, sweepMs: 0, sampleMs: 0, cpus: () => 16, mem: () => 13 * GB, table: () => null });
  assert.equal(again.peakOf(kind), 2.5 * GB);
  assert.equal(again.peakOf('transition board'), SEED_PEAK);
  assert.equal(again.slots(), 3, 'measured 2.5 GB: 0.7 x 13 / 2.5');
});

test('treeRss sums a process, its descendants and its process group', () => {
  const rows = [{ pid: 10, ppid: 1, pgrp: 10, rss: 100 }, { pid: 11, ppid: 10, pgrp: 10, rss: 20 }, { pid: 12, ppid: 11, pgrp: 12, rss: 3 }, { pid: 13, ppid: 1, pgrp: 10, rss: 4 }, { pid: 14, ppid: 1, pgrp: 14, rss: 1000 }];
  assert.equal(treeRss(rows, { pid: 10, group: 10 }), 127);
  assert.equal(treeRss(rows, { pid: 11 }), 23);
});
