// The live view's render bar: progress read from the render's own output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RenderQueue } from '../src/renderq.mjs';

// kinetograph's own progress lines, on stderr: "renderer: <backend>", then "rendering frame N/M" every tenth of the
// frames (packages/cli/src/commands/render.ts), "mixing audio" before the end. (Merger: align with s6's renderq parser.)
test('render queue: kinetograph\'s "rendering frame N/M" lines on stderr become percent and time left while it runs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-rq-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = new RenderQueue({ logDir: dir });
  const job = q.add({ projectId: 'p1', sessionId: 's', label: 'Animatic', argv: ['sh', '-c', 'echo "renderer: vulkan" >&2; echo "rendering frame 10/100" >&2; echo "rendering frame 25/100" >&2; sleep 0.6; echo "mixing audio" >&2; echo "wrote ../out/animatic.mp4 (1920x1080, 100 frames 0..=99 at 30 fps, h264 by libx264, yuv420p, with audio, 1.20 ms/frame in the encoder, 900 ms in all)"'], cwd: dir, env: process.env });
  await new Promise((ok) => setTimeout(ok, 300));
  const mid = q.activeFor('p1')[0];
  assert.equal(mid.state, 'running');
  assert.deepEqual([mid.progress.phase, mid.progress.done, mid.progress.total, mid.progress.percent], ['rendering', 25, 100, 25]);
  assert.ok(Number.isInteger(mid.progress.seconds_left));
  const end = await q.wait(job.id, 'p1', 5);
  assert.equal(end.state, 'done');
  assert.equal(end.progress, undefined, 'no progress once it is done');
});

test('render queue: a render keeps its temp files on disk beside the logs (not a RAM /tmp) and they go when it ends', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'mfx-rq-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = new RenderQueue({ logDir: dir });
  const job = q.add({ projectId: 'p1', sessionId: 's', label: 'Temp', argv: ['sh', '-c', 'echo "tmp=$TMPDIR"; touch "$TMPDIR/frame.png"'], cwd: dir, env: process.env });
  const end = await q.wait(job.id, 'p1', 5);
  assert.equal(end.state, 'done');
  assert.match(readFileSync(join(dir, `render-${job.id}.log`), 'utf8'), new RegExp(`tmp=${join(dir, 'tmp', String(job.id))}`));
  assert.equal(existsSync(join(dir, 'tmp', String(job.id))), false);
});

test('render queue: render-stop ends a running render and its children by its process group, and a waiting one never starts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-rq-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = new RenderQueue({ logDir: dir, parallel: 1 });
  const a = q.add({ projectId: 'p1', sessionId: 's', label: 'Long', argv: ['sh', '-c', 'sleep 30 & echo "child $!"; wait'], cwd: dir, env: process.env });
  const b = q.add({ projectId: 'p1', sessionId: 's', label: 'Next', argv: ['sh', '-c', 'echo never'], cwd: dir, env: process.env });
  await new Promise((ok) => setTimeout(ok, 300));
  const { readFileSync } = await import('node:fs');
  const child = Number(readFileSync(join(dir, `render-${a.id}.log`), 'utf8').match(/child (\d+)/)[1]);
  assert.equal(q.stop(b.id, 'p1').state, 'failed', 'the waiting one is dropped');
  q.stop(a.id, 'p1', 500);
  const end = await q.wait(a.id, 'p1', 5);
  assert.equal(end.state, 'failed');
  await new Promise((ok) => setTimeout(ok, 200));
  assert.throws(() => process.kill(child, 0), /ESRCH/, 'the render\'s own child is gone too');
  assert.throws(() => q.stop(a.id, 'other'), /no render/);
});

// Status truth: 'running' only while the process is alive; a gone process settles from its real exit code; a quiet live one is never failed.
test('render queue: a running job whose process vanished is settled by reconcile, never left running', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-rq-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = new RenderQueue({ logDir: dir, sweepMs: 0, graceMs: 0 });
  const job = q.add({ projectId: 'p1', sessionId: 's', label: 'Gone', argv: ['sh', '-c', 'sleep 30'], cwd: dir, env: process.env });
  assert.equal(q.list()[0].state, 'running');
  // Simulate the 'close' event never arriving: take the listeners away, then kill the whole group.
  const pid = q.jobs.get(job.id).proc.pid;
  q.jobs.get(job.id).proc.removeAllListeners('close');
  process.kill(-pid, 'SIGKILL');
  await new Promise((ok) => setTimeout(ok, 200));
  const v = q.list()[0];
  assert.equal(v.state, 'failed');
  assert.notEqual(v.exit_code, 0);
});

test('render queue: a quiet render with a live process stays running (never failed for silence)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-rq-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = new RenderQueue({ logDir: dir, sweepMs: 0, graceMs: 0 });
  const job = q.add({ projectId: 'p1', sessionId: 's', label: 'Quiet', argv: ['sh', '-c', 'sleep 30'], cwd: dir, env: process.env });
  await new Promise((ok) => setTimeout(ok, 1200));
  q.reconcile();
  assert.equal(q.list()[0].state, 'running');
  q.stop(job.id, 'p1', 500);
  const end = await q.wait(job.id, 'p1', 5);
  assert.equal(end.state, 'failed');
});

test('render queue: a normal exit still gives its real exit code (3 fails with 3, 0 is done)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-rq-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = new RenderQueue({ logDir: dir, sweepMs: 0 });
  const a = q.add({ projectId: 'p1', sessionId: 's', label: 'Bad', argv: ['sh', '-c', 'exit 3'], cwd: dir, env: process.env });
  const ea = await q.wait(a.id, 'p1', 5);
  assert.deepEqual([ea.state, ea.exit_code], ['failed', 3]);
});

test('render queue: an app render that gave its pid fails when that process dies, and stays running while it lives', async (t) => {
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'mfx-rq-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = new RenderQueue({ logDir: dir, sweepMs: 0 });
  const app = spawn('sleep', ['30']);
  t.after(() => { try { app.kill('SIGKILL'); } catch { /* gone */ } });
  const j = q.addExternal({ projectId: 'p1', label: 'Export', pid: app.pid });
  assert.equal(q.list()[0].state, 'running');
  q.report(j.id, { done: 1, total: 10 });
  assert.equal(q.list()[0].state, 'running', 'alive app, quiet or not');
  const gone = new Promise((ok) => app.on('exit', ok));
  app.kill('SIGKILL'); await gone;
  const v = q.list()[0];
  assert.equal(v.state, 'failed');
  assert.match(v.error, /process is gone/);
  // an app render without a pid is only the app's word: left as reported
  const k = q.addExternal({ projectId: 'p1', label: 'NoPid' });
  assert.equal(q.list().find((x) => x.id === k.id).state, 'running');
});
