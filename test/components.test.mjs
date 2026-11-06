// The installers' components step (packaging): which tools, their defaults, install order, failures that never stop
// the rest, the checksum checks, and the protocol calls first-run setup uses. No downloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { COMPONENTS, DEFAULT_IDS, parseComponents, installComponents, componentsStatus } from '../src/components.mjs';
import { checkFileSha256, checkSha256, ADDONS } from '../src/setup.mjs';
import { createService } from '../src/service.mjs';

test('everything is on by default, no local AI models are offered, and the toolkits come after Blender', () => {
  assert.deepEqual(DEFAULT_IDS, ['kinetograph', 'blender', 'blender-addons', 'chrome', 'strudel', 'transitions', 'uv']);
  // local generation is bloat (owner, 2026-11-01): no local voice, no ComfyUI
  for (const id of ['qwen-tts', 'comfyui']) assert.equal(COMPONENTS.find((c) => c.id === id), undefined, id);
  assert.throws(() => parseComponents('qwen-tts'), /unknown component qwen-tts/);
  assert.deepEqual(parseComponents('strudel, blender'), ['blender', 'strudel']);
  assert.deepEqual(parseComponents('none'), []);
  assert.equal(parseComponents('all').length, COMPONENTS.length);
  assert.throws(() => parseComponents('blendr'), /unknown component blendr/);
});

test('a failed component never stops the others; the toolkits are skipped without Blender', async (t) => {
  const root = tempStudio(t);
  const events = [];
  const results = await installComponents(root, ['blender', 'blender-addons', 'strudel'], {
    onEvent: (e) => events.push(e),
    install: async (_root, id, { log }) => {
      log(`working on ${id}`);
      if (id === 'blender') throw new Error('no network');
      return { ok: true, detail: `${id} here` };
    },
  });
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [['blender', false], ['blender-addons', false], ['strudel', true]]);
  assert.match(results[1].error, /skipped: blender/);
  assert.deepEqual(events.filter((e) => e.phase !== 'line').map((e) => `${e.id}:${e.phase}`),
    ['blender:start', 'blender:failed', 'blender-addons:skipped', 'strudel:start', 'strudel:done']);
});

test('downloads are checked against their sha256 and deleted when they differ', async (t) => {
  const root = tempStudio(t);
  const f = join(root, 'x.bin');
  writeFileSync(f, 'hello\n');
  const good = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
  await checkFileSha256(f, good, 'x.bin');
  const sums = { ok: true, text: async () => `${good}  x.bin\n0000  other.tar.xz\n` };
  await checkSha256(f, 'https://example.invalid/sums', 'x.bin', () => {}, { fetchImpl: async () => sums });
  await assert.rejects(checkFileSha256(f, '0'.repeat(64), 'x.bin'), /doesn't match/);
  assert.equal(existsSync(f), false);
});

test('Nova FX comes from its public repository, pinned to a checked commit', () => {
  const nova = ADDONS.find((a) => a.id === 'nova_fx');
  assert.equal(nova.repo, 'GTKottman/nova-fx');
  assert.match(nova.commit, /^[0-9a-f]{40}$/);
  assert.match(nova.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!nova.vendored);
});

test('components.status lists every component with its size and state; components.install runs in the background', async (t) => {
  const root = tempStudio(t);
  const list = await componentsStatus(root);
  assert.deepEqual(list.map((c) => c.id), COMPONENTS.map((c) => c.id));
  for (const c of list) assert.ok(c.name && c.size && c.for, c.id);
  assert.equal(list.find((c) => c.id === 'transitions').installed, false);

  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  await svc.handle({ id: 1, type: 'components.status', params: {} });
  const st = out.find((m) => m.id === 1);
  assert.equal(st.ok, true);
  assert.equal(st.result.components.length, COMPONENTS.length);
  assert.equal(st.result.installing, null);
  await svc.handle({ id: 2, type: 'components.install', params: { ids: ['blendr'] } });
  assert.equal(out.find((m) => m.id === 2).error.code, 'bad_request');
});

test('the installer entry lists the components as JSON with the bundled-style command line', (t) => {
  const root = tempStudio(t);
  const bin = join(import.meta.dirname, '..', 'bin', 'mortiflix-components.mjs');
  const r = spawnSync(process.execPath, [bin, 'list', '--json'], { encoding: 'utf8', env: { ...process.env, MORTIFLIX_STUDIO: root } });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.studio, root);
  assert.equal(j.components.length, COMPONENTS.length);
  const none = spawnSync(process.execPath, [bin, 'install', 'none'], { encoding: 'utf8', env: { ...process.env, MORTIFLIX_STUDIO: root } });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No components chosen/);
  assert.equal(spawnSync(process.execPath, [bin, 'install', 'blendr'], { encoding: 'utf8' }).status, 2);
});

test('a headless Chrome folder with @puppeteer/browsers\' .metadata file is still found', async (t) => {
  const { mkdirSync, chmodSync } = await import('node:fs');
  const { setupStatusSync } = await import('../src/setup.mjs');
  const root = tempStudio(t);
  const base = join(root, 'tools', 'browsers', 'chrome-headless-shell');
  const dir = join(base, 'linux-150.0.0.0', 'chrome-headless-shell-linux64');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(base, '.metadata'), '{}');
  const bin = join(dir, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  assert.equal(setupStatusSync(root).chrome.path, bin);
});
