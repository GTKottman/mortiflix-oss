// Style frames v3, version 3: packs hold any file; the `assets` kind; several asset packs per project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, loadProject } from '../src/projects.mjs';
import { listAllPacks, fileKind, packFiles, brings, packKinds } from '../src/svc/packs.mjs';
import { cleanPacks, setProjectPacks } from '../src/svc/projectpacks.mjs';

const w = (root, rel, data = 'x') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), data); };

test('file kinds: folder first, extension second; any extension is kept', () => {
  assert.equal(fileKind('textures/paper.png'), 'texture');
  assert.equal(fileKind('textures/dots.svg'), 'texture');
  assert.equal(fileKind('icons/arrow.svg'), 'icon');
  assert.equal(fileKind('images/sky.jpg'), 'picture');
  assert.equal(fileKind('sky.jpg'), 'picture');
  assert.equal(fileKind('fonts/U.ttf'), 'font');
  assert.equal(fileKind('models/chair.glb'), 'model');
  assert.equal(fileKind('brand.pdf'), 'document');
  assert.equal(fileKind('notes/brief.docx'), 'document');
  assert.equal(fileKind('layouts/hero.json'), 'layout');
  assert.equal(fileKind('data.xyz'), 'other');
});

test('an asset pack: every file listed with its kind, counted on its card', (t) => {
  const root = tempStudio(t);
  w(root, 'packs/assets/city/pack.json', JSON.stringify({ kind: 'assets', name: 'City', spec: 2, share: false }));
  for (const f of ['fonts/A.ttf', 'fonts/B.otf', 'icons/a.svg', 'textures/g.png', 'images/sky.jpg', 'models/b.glb', 'brief.pdf', 'copy.docx', 'layouts/hero.json', 'weird.bin']) w(root, `packs/assets/city/${f}`);
  w(root, 'packs/assets/city/.hidden/x.png');
  const p = listAllPacks(root, 'assets')[0];
  assert.equal(p.kind, 'assets'); assert.equal(p.spec, 2); assert.equal(p.share, false);
  assert.deepEqual(p.counts, { font: 2, icon: 1, texture: 1, picture: 1, model: 1, document: 2, layout: 1, other: 1 });
  assert.equal(p.asset_files.length, 10);
  assert.equal(p.brings, '2 fonts · 1 icon · 1 texture · 1 picture · 1 3D model · 2 documents · 1 layout');
  assert.ok(packKinds(root).some((k) => k.kind === 'assets'));
  assert.equal(packFiles(join(root, 'packs/assets/city'), { max: 3 }).length, 3);
  assert.equal(brings({ counts: {}, style: { palette: [1, 2] } }), '2 colours');
});

test('a project picks one style pack and several asset packs', (t) => {
  const root = tempStudio(t);
  w(root, 'packs/style/s/pack.json', JSON.stringify({ kind: 'style', name: 'S', palette: ['#111111', '#ffffff'] }));
  w(root, 'packs/assets/a/pack.json', JSON.stringify({ kind: 'assets', name: 'A' }));
  w(root, 'packs/assets/b/pack.json', JSON.stringify({ kind: 'assets', name: 'B' }));
  assert.throws(() => cleanPacks(root, { assets: ['a', 'nope'] }), /no assets pack "nope"/);
  const picked = cleanPacks(root, { style: 's', assets: ['a', 'b', 'a'] });
  assert.deepEqual(picked.assets.map((x) => x.id), ['a', 'b']);
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x' } });
  setProjectPacks(root, p.id, picked);
  assert.deepEqual(loadProject(root, p.id).mfx.packs.assets, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  assert.deepEqual(loadProject(root, p.id).mfx.packs.style, { id: 's', name: 'S' });
});
