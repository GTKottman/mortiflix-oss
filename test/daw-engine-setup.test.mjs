// `mortiflix setup daw-engine` (doc 16 E7): the setup part sits after "Your DAW", the status says what's there (and
// runs the engine's own self-test), and without --build it says how to get one (there is no release build yet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { PARTS, TOOLS, dawEngineBin, dawEngineStatus, installTool, setupStatus } from '../src/setup.mjs';

const REAL = [process.env.MFX_DAW_ENGINE, join(homedir(), '.cache/mortiflix/engine-build/mortiflix-engine_artefacts/Release/mortiflix-engine')].find((f) => f && existsSync(f));

test('the sound engine is a setup part after "Your DAW", with its own tool', () => {
  const ids = PARTS.map((p) => p.id);
  assert.equal(ids.indexOf('daw-engine'), ids.indexOf('daw') + 1);
  assert.deepEqual(PARTS.find((p) => p.id === 'daw-engine').tools, ['daw-engine']);
  assert.ok(TOOLS.includes('daw-engine'));
});

test('not installed: the status says so, and installing without --build says how', async (t) => {
  const root = tempStudio(t);
  assert.deepEqual(dawEngineStatus(root), { ok: false, detail: 'not installed', path: null });
  assert.equal((await setupStatus(root))['daw-engine'].ok, false);
  await assert.rejects(installTool(root, 'daw-engine'), /no release build.*mortiflix setup daw-engine --build/);
});

test('installed: its version and a passing self-test', { skip: !REAL && 'the engine is not built on this machine' }, (t) => {
  const root = tempStudio(t);
  const bin = dawEngineBin(root);
  mkdirSync(dirname(bin), { recursive: true });
  copyFileSync(REAL, bin);
  const st = dawEngineStatus(root);
  assert.equal(st.ok, true, st.detail);
  assert.match(st.detail, /self-test passed/);
  assert.equal(st.version.name, 'mortiflix-engine');
  assert.equal(st.path, bin);
});
