// Setup downloads over the service (setup.download / install / cancel): progress, size and SHA-256 checks, cancel.
// fake: downloads only (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { downloadFiles } from '../src/service-setup.mjs';

function svc(root) {
  const sent = [];
  const s = createService({ root, send: (m) => sent.push(m) });
  const call = async (type, params = {}) => {
    const id = sent.length + 1000;
    await s.handle({ id, type, params });
    return sent.find((m) => m.id === id);
  };
  const progress = () => sent.filter((m) => m.event === 'setup.progress').map((m) => m.data);
  const until = async (job, ms = 10_000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const end = progress().find((d) => d.job === job && d.state !== 'running');
      if (end) return end;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`job ${job} never finished: ${JSON.stringify(progress())}`);
  };
  return { call, progress, until };
}

test('setup.backend also takes where claude is (absolute or `claude`); setup.status shows the sound engine', async (t) => {
  const root = tempStudio(t);
  const { call } = svc(root);
  assert.deepEqual((await call('setup.backend', { claudeBin: '/opt/claude/bin/claude' })).result, { backend: 'demo', claudeBin: '/opt/claude/bin/claude' });
  assert.equal((await call('setup.backend', { backend: 'claude-code', claudeBin: '' })).result.claudeBin, 'claude');
  assert.equal((await call('setup.backend', { claudeBin: 'relative/claude' })).ok, false);
  assert.equal((await call('setup.backend', { claudeBin: '/a\nb' })).ok, false);
  assert.equal((await call('setup.backend', {})).ok, false);
  const st = await call('setup.status');
  assert.equal(typeof st.result.tools.engine.ok, 'boolean');
});

test('setup.download fetches what was asked, with progress, and checks size and SHA-256', async (t) => {
  const root = tempStudio(t);
  const dir = mkdtempSync(join(tmpdir(), 'mfx-dl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.MFX_FAKE_DOWNLOADS = '1';
  t.after(() => { delete process.env.MFX_FAKE_DOWNLOADS; });
  const { call, until, progress } = svc(root);
  const dest = join(dir, 'model', 'weights.bin');
  const zeros = createHash('sha256').update(Buffer.alloc(40_000)).digest('hex');
  const r = await call('setup.download', { label: 'Test model', files: [{ url: 'fake:40000', dest, size: 40_000, sha256: zeros }] });
  assert.equal(r.ok, true);
  const end = await until(r.result.job);
  assert.equal(end.state, 'done', JSON.stringify(end));
  assert.equal(statSync(dest).size, 40_000);
  assert.ok(progress().some((d) => d.job === r.result.job && d.total === 40_000));
  // a wrong checksum leaves nothing behind
  const dest2 = join(dir, 'bad.bin');
  const r2 = await call('setup.download', { files: [{ url: 'fake:1000', dest: dest2, size: 1000, sha256: 'a'.repeat(64) }] });
  assert.match((await until(r2.result.job)).line, /SHA-256/);
  assert.ok(!existsSync(dest2) && !existsSync(`${dest2}.part`));
  // hostile requests
  for (const files of [[], [{ url: 'http://x/y', dest, size: 1, sha256: 'a'.repeat(64) }], [{ url: 'fake:1', dest: 'rel/x', size: 1 }],
    [{ url: 'fake:1', dest: `${dir}/../x`, size: 1 }], [{ url: 'fake:1', dest, size: -1 }], [{ url: 'https://h/x', dest, size: 1, sha256: 'zz' }]]) {
    assert.equal((await call('setup.download', { files })).error?.code, 'bad_request', JSON.stringify(files));
  }
  delete process.env.MFX_FAKE_DOWNLOADS;
  assert.equal((await call('setup.download', { files: [{ url: 'fake:1', dest, size: 1 }] })).error.code, 'bad_request');
});

test('setup.cancel stops a download and removes the part file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-dl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.MFX_FAKE_DOWNLOADS = '1';
  t.after(() => { delete process.env.MFX_FAKE_DOWNLOADS; });
  const root = tempStudio(t);
  const { call, until } = svc(root);
  const dest = join(dir, 'big.bin');
  const r = await call('setup.download', { files: [{ url: 'fake:5000000', dest, size: 5_000_000 }] });
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal((await call('setup.cancel', { job: r.result.job })).result.cancelled, true);
  assert.equal((await until(r.result.job)).state, 'cancelled');
  assert.ok(!existsSync(dest) && !existsSync(`${dest}.part`));
  assert.equal((await call('setup.cancel', { job: 999 })).result.cancelled, false);
});

test('setup.install takes any setup.mjs component and nothing else', async (t) => {
  process.env.MFX_FAKE_DOWNLOADS = '1';
  t.after(() => { delete process.env.MFX_FAKE_DOWNLOADS; });
  const root = tempStudio(t);
  const { call, until } = svc(root);
  for (const tool of ['chrome', 'blender', 'strudel']) {
    const r = await call('setup.install', { tool });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await until(r.result.job)).state, 'done');
  }
  assert.equal((await call('setup.status')).result.tools.studio.chrome.ok, true);
  for (const tool of ['', 'rm -rf', '__proto__', 'ffmpeg']) assert.equal((await call('setup.install', { tool })).error.code, 'bad_request');
});

test('downloadFiles skips files already there', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-dl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dest = join(dir, 'have.bin');
  writeFileSync(dest, Buffer.alloc(10));
  assert.equal(await downloadFiles([{ url: 'https://example.invalid/x', dest, size: 10, sha256: '' }]), 'Already here');
});
