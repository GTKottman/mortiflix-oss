// Runtime optimizations (R1-R6): the tool probes are cached and never block the service, read requests do not wait
// behind slow ones, project.changed does not flap, and the idle tick does not redo the whole look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createService, runStdio } from '../src/service.mjs';
import { createSetupCache } from '../src/svc/setup-cache.mjs';
import { run } from '../src/svc/run.mjs';
import { changeToken } from '../src/svc/change-token.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('run(): async spawnSync-shaped result, timeout kills, missing binary is an error', async () => {
  const ok = await run(process.execPath, ['-e', 'process.stdout.write("hi");process.stderr.write("e")']);
  assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, 'hi', 'e']);
  const slow = await run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeout: 200 });
  assert.equal(slow.error?.code, 'ETIMEDOUT');
  const none = await run('/no/such/bin', []);
  assert.ok(none.error);
  const buf = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([1,2,3]))'], { encoding: 'buffer' });
  assert.deepEqual([...buf.stdout], [1, 2, 3]);
  // the event loop keeps turning while a child runs
  let ticks = 0;
  const iv = setInterval(() => ticks++, 20);
  await run(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
  clearInterval(iv);
  assert.ok(ticks >= 8, `loop turned ${ticks} times`);
});

test('setup cache (R1): cold waits once, then answers at once; stale refreshes in the background; invalidate refreshes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-sc-'));
  const count = join(dir, 'count');
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(count)}, 'x');
await new Promise((r) => setTimeout(r, 300));
console.log(JSON.stringify({ n: readFileSync(${JSON.stringify(count)}, 'utf8').length, kind: process.argv[3] }));`);
  const runs = () => (existsSync(count) ? readFileSync(count, 'utf8').length : 0);
  const cache = createSetupCache(dir, { ttlMs: 400, worker });
  const t0 = Date.now();
  const [a, b] = await Promise.all([cache.get('heavy'), cache.get('heavy')]); // one child for both
  assert.equal(runs(), 1);
  assert.deepEqual([a.n, b.n, a.kind], [1, 1, 'heavy']);
  const t1 = Date.now();
  assert.equal((await cache.get('heavy')).n, 1);
  assert.ok(Date.now() - t1 < 20, 'warm answer is immediate');
  await sleep(450); // stale now: the old value at once, a refresh behind it
  const t2 = Date.now();
  assert.equal((await cache.get('heavy')).n, 1);
  assert.ok(Date.now() - t2 < 20);
  await sleep(500);
  assert.equal((await cache.get('heavy')).n, 2);
  assert.equal(runs(), 2);
  cache.invalidate();
  assert.equal((await cache.get('heavy')).n, 2); // still the old one at once
  await sleep(500);
  assert.equal((await cache.get('heavy')).n, 3);
  assert.equal((await cache.get('heavy', { force: true })).n, 4);
  void t0;
});

test('setup.status over the service: the second call is cached and project.list is never held up by the probes', async (t) => {
  const root = tempStudio(t);
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), tickMs: 0 });
  const call = async (type, params = {}) => { const t0 = Date.now(); await svc.handle({ id: 1, type, params }); return { ms: Date.now() - t0, m: out.at(-1) }; };
  const first = await call('setup.status');
  assert.equal(first.m.ok, true);
  assert.ok(first.m.result.claude && first.m.result.tools && first.m.result.keys && 'first_run' in first.m.result);
  const second = await call('setup.status');
  assert.ok(second.ms < 100, `cached setup.status took ${second.ms} ms`);
  assert.deepEqual(second.m.result.tools.studio, first.m.result.tools.studio);
  // a key change shows at once (the cheap part is live) while the probes refresh behind it
  await svc.handle({ id: 2, type: 'keys.set', params: { id: 'elevenlabs', value: 'abc123' } });
  const third = await call('setup.status');
  assert.equal(third.m.result.keys.find((k) => k.id === 'elevenlabs').set, true);
  await svc.close();
});

test('stdio (R3): a read answers in < 100 ms while a slow request runs; mutations keep their order', async (t) => {
  const root = tempStudio(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const oldLog = console.log;
  const svc = runStdio({ input, output, root, runner: false });
  t.after(() => { console.log = oldLog; });
  const log = [];
  svc.handlers['slow.test'] = async () => { await sleep(1500); log.push('slow'); return 'slow'; };
  svc.handlers['mut.test'] = async () => { log.push('mut'); return 'mut'; };
  const replies = new Map();
  let buf = '';
  output.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1); if (m.id) replies.set(m.id, { ...m, at: Date.now() }); } });
  const t0 = Date.now();
  input.write(`${JSON.stringify({ id: 1, type: 'slow.test' })}\n`);
  input.write(`${JSON.stringify({ id: 2, type: 'mut.test' })}\n`);
  await sleep(300);
  input.write(`${JSON.stringify({ id: 3, type: 'project.list' })}\n`);
  const t3 = Date.now();
  while (!replies.has(3) && Date.now() - t3 < 3000) await sleep(5);
  assert.equal(replies.get(3).ok, true);
  assert.ok(replies.get(3).at - t3 < 250, `project.list took ${replies.get(3).at - t3} ms behind a 1.5 s request`);
  assert.ok(!replies.has(1), 'the slow one is still running');
  while (!replies.has(2) && Date.now() - t0 < 5000) await sleep(10);
  assert.deepEqual(log, ['slow', 'mut'], 'the second mutation waited for the first');
  await svc.close(); // (not input.end(): the stdio service exits the process when its stdin ends)
});

test('project.changed does not flap (R2) and an idle tick does no work (R6); edits still arrive', async (t) => {
  const root = tempStudio(t);
  const events = [];
  const svc = createService({ root, send: (m) => { if (m.event) events.push(m); }, tickMs: 40 });
  const call = (type, params = {}) => svc.handle({ id: 1, type, params });
  const sent = [];
  const svc2 = createService({ root, send: (m) => sent.push(m), tickMs: 0 });
  await svc2.handle({ id: 1, type: 'project.new', params: { preset: 'explainer', title: 'Idle', idea: 'x', backend: 'demo', start: false } });
  const id = sent.find((m) => m.id === 1)?.result?.id || sent.find((m) => m.id === 1)?.result?.project?.id;
  assert.ok(id, JSON.stringify(sent.at(-1)).slice(0, 300));
  await svc2.close();
  await call('project.open', { id });
  await sleep(300);
  const n0 = events.filter((e) => e.event === 'project.changed').length;
  const full0 = svc.ticks.full;
  await sleep(700); // idle: ~17 ticks
  assert.equal(events.filter((e) => e.event === 'project.changed').length, n0, 'no project.changed while idle');
  assert.ok(svc.ticks.full === full0, `idle ticks did full work ${svc.ticks.full - full0} times`);
  assert.ok(svc.ticks.skipped >= 10);
  // re-opening the same project is not a change
  const before = events.filter((e) => e.event === 'project.changed').length;
  await call('project.open', { id });
  await sleep(300);
  assert.equal(events.filter((e) => e.event === 'project.changed').length, before);
  // an edit under the state dir reaches the tick without any poke
  const full1 = svc.ticks.full;
  appendFileSync(join(root, 'state', id, 'events.jsonl'), '');
  writeFileSync(join(root, 'state', id, 'touch.txt'), String(Date.now()));
  await sleep(250);
  assert.ok(svc.ticks.full > full1, 'a changed file wakes the tick');
  await svc.close();
});

test('changeToken: stable when nothing changes, changes with a file edit or a new file', async (t) => {
  const root = tempStudio(t);
  const dir = join(root, 'projects', 'p1');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'voice'), { recursive: true });
  writeFileSync(join(dir, 'voice', 'lines.json'), '[]');
  const a = changeToken(root, 'p1');
  assert.equal(changeToken(root, 'p1'), a);
  await sleep(15);
  writeFileSync(join(dir, 'voice', 'lines.json'), '[1]');
  const b = changeToken(root, 'p1');
  assert.notEqual(b, a);
  writeFileSync(join(dir, 'new.txt'), 'x');
  assert.notEqual(changeToken(root, 'p1'), b);
});
