// Director 2 (2026-11-02): style frames failed 4x, "no such file: src/index.ts". The asset pool writes video/src/pool.ts
// before the frames step and setup.mjs only copied the template into an empty video/src. ensureVideoScaffold adds every
// template file that is missing and overwrites none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureVideoScaffold, ensureVideoModules, missingModules, TEMPLATE } from '../src/svc/videoscaffold.mjs';
import { poolTs } from '../src/svc/pool.mjs';
import { writeFormat, writeIndex, writeRoot, STUDIO_FILES } from '../src/quickframes.mjs';

test('a video/src made by the pool first still gets index.ts and the rest of the template; nothing is overwritten', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'mfx-scaffold-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'video', 'src'), { recursive: true });
  writeFileSync(join(work, 'video', 'src', 'pool.ts'), 'export const POOL = {};\n');
  writeFileSync(join(work, 'video', 'src', 'Root.tsx'), '// the frames step wrote this\n');
  const added = ensureVideoScaffold(work);
  assert.ok(added.includes(join('src', 'index.ts')));
  assert.ok(!added.includes(join('src', 'Main.tsx')), 'Main is the animatic\'s');
  assert.ok(added.includes('package.json') && added.includes('tsconfig.json'));
  assert.ok(!added.includes(join('src', 'Root.tsx')));
  assert.match(readFileSync(join(work, 'video', 'src', 'index.ts'), 'utf8'), /registerRoot\(Root\)/);
  assert.equal(readFileSync(join(work, 'video', 'src', 'Root.tsx'), 'utf8'), '// the frames step wrote this\n');
  assert.equal(readFileSync(join(work, 'video', 'src', 'pool.ts'), 'utf8'), 'export const POOL = {};\n');
  assert.deepEqual(ensureVideoScaffold(work), [], 'a second call adds nothing');
  assert.ok(!existsSync(join(work, 'video', 'src', 'video.ts')), 'video.ts is the AI\'s look');
});

test('the studio writes format.ts from the project and the voice, and a Root that never reads video.ts for size or length', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'mfx-root-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'video', 'src', 'scenes'), { recursive: true });
  writeFileSync(join(work, 'video', 'src', 'scenes', 'sf01.tsx'), 'export const SF01 = () => null;\n');
  writeFormat(work, { w: 1920, h: 1080, seconds: 61.5 });
  assert.match(readFileSync(join(work, 'video', 'src', 'format.ts'), 'utf8'), /width: 1920, height: 1080, fps: 30, seconds: 61.5, durationInFrames: 1845/);
  writeFormat(work, { w: 1080, h: 1920, seconds: null });
  assert.match(readFileSync(join(work, 'video', 'src', 'format.ts'), 'utf8'), /durationInFrames: 30/);
  // the template's Main is not registered; the animatic's is
  writeFileSync(join(work, 'video', 'src', 'Main.tsx'), '<Title text="Replace me with beat one" />');
  writeIndex(work, { frames: [{ id: 'sf01', composition: 'SF01' }] });
  const root = readFileSync(join(work, 'video', 'src', 'Root.tsx'), 'utf8');
  assert.doesNotMatch(root, /Main|video/);
  assert.match(root, /from '.\/format'/);
  writeFileSync(join(work, 'video', 'src', 'Main.tsx'), 'export const Main = () => null;');
  writeRoot(work);
  assert.match(readFileSync(join(work, 'video', 'src', 'Root.tsx'), 'utf8'), /id="Main" component=\{Main\}[^\n]*durationInFrames=\{format.durationInFrames\}/);
  assert.ok(STUDIO_FILES.includes('src/Root.tsx') && STUDIO_FILES.includes('src/index.ts'));
});

test('every package the studio-written files import is in the template (pool.ts and the transitions import @remotion/fonts)', () => {
  const tpl = JSON.parse(readFileSync(join(TEMPLATE, 'package.json'), 'utf8'));
  for (const dep of ['remotion', 'react', '@remotion/fonts', '@remotion/google-fonts', '@remotion/transitions']) assert.ok(tpl.dependencies[dep], dep);
  assert.equal(tpl.dependencies['@remotion/fonts'], tpl.dependencies.remotion, 'same version as remotion');
  assert.match(poolTs([]), /from '@remotion\/fonts'/);
});

test('a project linked to an older shared install without a package gets the current one before the type check (d4fd)', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'vm-')); t.after(() => rmSync(work, { recursive: true, force: true }));
  const tpl = mkdtempSync(join(tmpdir(), 'tpl-')); t.after(() => rmSync(tpl, { recursive: true, force: true }));
  mkdirSync(join(tpl, 'template'));
  writeFileSync(join(tpl, 'template', 'package.json'), JSON.stringify({ dependencies: { remotion: '1', '@remotion/fonts': '1' } }));
  const has = (dep) => { mkdirSync(join(work, 'video', 'node_modules', dep), { recursive: true }); writeFileSync(join(work, 'video', 'node_modules', dep, 'package.json'), '{}'); };
  has('remotion');
  assert.deepEqual(missingModules(work, { template: join(tpl, 'template') }), ['@remotion/fonts']);
  const calls = [];
  const run = async (cmd, args, o) => { calls.push({ args, shared: o.env.MFX_SHARED }); has('@remotion/fonts'); return { status: 0, stdout: 'moved', stderr: '' }; };
  const r = await ensureVideoModules(work, { shared: '/s/run/shared', template: join(tpl, 'template'), run });
  assert.deepEqual(r.added, ['@remotion/fonts']); assert.equal(r.ok, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].args[0], join(tpl, 'setup.mjs')); assert.equal(calls[0].shared, '/s/run/shared');
  // nothing missing: no setup run
  assert.equal((await ensureVideoModules(work, { template: join(tpl, 'template'), run })).added.length, 0); assert.equal(calls.length, 1);
});
