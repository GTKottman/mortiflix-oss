// files.reveal: shows a studio file in the file manager; paths outside the studio are refused before anything runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { revealCommand } from '../src/svc/reveal.mjs';

function harness(t, root) {
  const out = [];
  const ran = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0, reveal: (cmd) => ran.push(cmd) });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    return out.find((m) => m.id === id);
  };
  return { call, ran };
}

test('revealCommand per platform', () => {
  assert.deepEqual(revealCommand('/s/p/final.mp4', { platform: 'linux' }).args, ['/s/p']);
  assert.deepEqual(revealCommand('/s/p', { platform: 'linux', isDir: true }).args, ['/s/p']);
  const w = revealCommand('C:\\My Studio\\final.mp4', { platform: 'win32' });
  assert.equal(w.file, 'explorer.exe');
  assert.deepEqual(w.args, ['/select,"C:\\My Studio\\final.mp4"']);
  assert.equal(w.options.windowsVerbatimArguments, true);
  assert.deepEqual(revealCommand('/s/p/a.png', { platform: 'darwin' }).args, ['-R', '/s/p/a.png']);
});

test('files.reveal opens the folder of a studio file', async (t) => {
  const root = tempStudio(t);
  const file = join(root, 'projects', 'p1', 'final.mp4');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x');
  const { call, ran } = harness(t, root);
  const r = await call('files.reveal', { path: file });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.revealed, realpathSync(file));
  assert.equal(ran.length, 1);
  if (process.platform === 'linux') assert.deepEqual(ran[0], { file: 'xdg-open', args: [realpathSync(dirname(file))], options: {} });
  // a path relative to the studio works too
  assert.equal((await call('files.reveal', { path: 'projects/p1/final.mp4' })).ok, true);
});

test('files.reveal refuses paths outside the studio, escapes, links out and missing files', async (t) => {
  const root = tempStudio(t);
  const away = mkdtempSync(join(tmpdir(), 'mfx-away-'));
  t.after(() => rmSync(away, { recursive: true, force: true }));
  writeFileSync(join(away, 'secret.txt'), 'x');
  symlinkSync(away, join(root, 'link-out'));
  const { call, ran } = harness(t, root);
  for (const path of [join(away, 'secret.txt'), '../', join(root, '..'), 'link-out/secret.txt', join(root, 'nope.mp4'), '', `${root}-other`]) {
    const r = await call('files.reveal', { path });
    assert.equal(r.ok, false, `should refuse ${path}`);
    assert.equal(r.error.code, 'bad_request');
  }
  assert.equal(ran.length, 0);
});
