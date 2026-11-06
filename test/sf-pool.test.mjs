// Style frames v3, version 4: the asset pool. Packs hold any file; the pool reads each by kind and writes ids, files and pool.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { cleanPacks, setProjectPacks } from '../src/svc/projectpacks.mjs';
import { buildPool, readPool, poolLines, checkAssetRefs, poolTs } from '../src/svc/pool.mjs';
import { grainPng, DEFAULT_TEXTURES } from '../src/svc/pooldefaults.mjs';
import { parseIcon, imageSize, readDocument } from '../src/svc/poolfiles.mjs';
import { zip } from '../src/zip.mjs';

const w = (root, rel, data = 'x') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), data); };
const png = grainPng({ size: 8 });
const ARROW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 12h12m-5-5 5 5-5 5" stroke="#000" stroke-width="3" fill="none"/></svg>';
const TEXTICON = '<svg viewBox="0 0 24 24"><text x="1" y="10">hi</text></svg>';
const docx = () => Buffer.from(zip([{ name: 'word/document.xml', data: Buffer.from('<w:document><w:body><w:p><w:r><w:t>Black October</w:t></w:r></w:p><w:p><w:r><w:t>Four bugs &amp; a patch</w:t></w:r></w:p></w:body></w:document>') },
  { name: 'word/media/image1.png', data: Buffer.concat([grainPng({ size: 64 }), Buffer.alloc(5000)]) }]));

function setup(t) {
  const root = tempStudio(t);
  w(root, 'packs/style/aig/pack.json', JSON.stringify({ kind: 'style', name: 'Aig', fonts: ['Urbanist'], palette: ['#fafafa', '#fd3a25'],
    style: { palette: [{ hex: '#fafafa', job: 'ground', rule: 'background' }, { hex: '#fd3a25', job: 'accent', rule: 'one word' }, { hex: '#09090b', job: 'ground', rule: 'dark panels' }],
      type: { heading: { font: 'Urbanist', weight: 700 }, body: { font: 'Roboto', weight: 400 } } } }));
  w(root, 'packs/style/aig/fonts/Urbanist-Bold.ttf', Buffer.from('\x00\x01\x00\x00fake-but-headered', 'latin1'));
  w(root, 'packs/style/aig/fonts/Urbanist-Regular.ttf', Buffer.from('\x00\x01\x00\x00fake-but-headered', 'latin1'));
  w(root, 'packs/style/aig/fonts/Broken.ttf', 'not a font');
  w(root, 'packs/assets/city/pack.json', JSON.stringify({ kind: 'assets', name: 'City', spec: 2 }));
  w(root, 'packs/assets/city/icons/arrow-right.svg', ARROW);
  w(root, 'packs/assets/city/icons/label.svg', TEXTICON);
  w(root, 'packs/assets/city/textures/paper.png', png);
  w(root, 'packs/assets/city/textures.json', JSON.stringify([{ file: 'textures/paper.png', use: 'quiet grounds', tile: true, opacity: 0.5 }]));
  w(root, 'packs/assets/city/images/skyline.png', png);
  w(root, 'packs/assets/city/layouts/hero.json', JSON.stringify({ name: 'hero-left', use: 'big headline left', regions: [{ id: 'h', role: 'headline', x: 0.05, y: 0.2, w: 0.5, h: 0.5 }] }));
  w(root, 'packs/assets/city/models/chair.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  w(root, 'packs/assets/city/brief.docx', docx());
  w(root, 'packs/assets/city/notes.txt', 'Remember: red only on one word.');
  w(root, 'packs/assets/city/clip.mp4', 'v');
  w(root, 'packs/assets/city/weird.xyz', 'q');
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x' } });
  setProjectPacks(root, p.id, cleanPacks(root, { style: 'aig', assets: ['city'] }));
  return { root, id: p.id, work: projectPaths(root, p.id).work };
}

test('the pool reads every kind of file in the picked packs and writes pool.json, the public copy and pool.ts', (t) => {
  const { root, id, work } = setup(t);
  const still = (src, out) => { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, png); return { ok: true }; };
  const pool = buildPool(root, id, { modelStill: still });
  const by = Object.fromEntries(pool.assets.map((a) => [a.id, a]));
  // colours with their jobs and rules; two "ground" colours get unique ids
  assert.equal(by['color:accent'].rule, 'one word');
  assert.equal(by['color:ground'].hex, '#fafafa'); assert.equal(by['color:ground-2'].hex, '#09090b');
  // fonts: the heading is matched to its file; the body has none shipped (google-fonts)
  assert.equal(by['font:heading'].file, 'pool/fonts/aig-Urbanist-Bold.ttf'); assert.equal(by['font:heading'].source, 'file');
  assert.equal(by['font:body'].source, 'google-fonts'); assert.equal(by['font:body'].file, null);
  assert.ok(by['font:urbanist-400'] && by['font:urbanist-700']);
  assert.ok(!Object.keys(by).some((k) => /broken/.test(k)) && pool.skipped.some((s) => /Broken\.ttf/.test(s.file) && /usable font/.test(s.why)));
  assert.ok(existsSync(join(work, 'video', 'src', 'public', 'pool', 'fonts', 'aig-Urbanist-Bold.ttf')));
  // icons are data (paths), the text one is refused with a reason
  assert.equal(by['icon:arrow-right'].shapes[0].tag, 'path'); assert.equal(by['icon:arrow-right'].viewBox, '0 0 24 24');
  assert.ok(!by['icon:label']); assert.ok(pool.skipped.some((s) => /label\.svg/.test(s.file) && /text/.test(s.why)));
  // textures + images keep their file, size and notes
  assert.equal(by['tex:paper'].file, 'pool/textures/city-paper.png'); assert.equal(by['tex:paper'].use, 'quiet grounds'); assert.equal(by['tex:paper'].w, 8);
  assert.equal(by['img:skyline'].w, 8);
  assert.equal(by['layout:hero-left'].regions[0].role, 'headline');
  // a 3D model: a still
  assert.equal(by['model:chair'].file, 'pool/models/aig-chair.png'.replace('aig', 'city'));
  // documents: text read, the picture inside kept as its own asset
  assert.match(by['doc:brief'].text, /Black October\nFour bugs & a patch/);
  assert.equal(by['doc:brief'].images.length, 1); assert.ok(by[by['doc:brief'].images[0]].file.startsWith('pool/docs/'));
  assert.match(by['doc:notes'].text, /red only on one word/);
  // not drawn in a still / unknown: listed, not silently dropped
  assert.ok(pool.skipped.some((s) => /clip\.mp4/.test(s.file))); assert.ok(pool.skipped.some((s) => /weird\.xyz/.test(s.file) && /unknown/.test(s.why)));
  // the small default pack ships: halftones, gradients, grain
  assert.ok(by['tex:halftone-dots'].default && by['tex:gradient-linear'] && by['tex:grain'].file);
  assert.ok(existsSync(join(work, 'video', 'src', 'public', 'pool', 'textures', 'grain.png')));
  assert.ok(DEFAULT_TEXTURES.length >= 8 && DEFAULT_TEXTURES.length <= 16, 'a small pack, not a huge one');
  // the files the studio writes
  assert.equal(readPool(root, id).assets.length, pool.assets.length);
  const ts = readFileSync(join(work, 'video', 'src', 'pool.ts'), 'utf8');
  assert.match(ts, /export const POOL: Row\[\] = \[/); assert.match(ts, /export function tex\(/); assert.match(ts, /export const Icon/); assert.match(ts, /loadFont/);
  assert.ok(!/"text":/.test(ts), 'document text is not inlined into pool.ts');
});

test('the pool is built once: unchanged packs do nothing, a changed pack rebuilds', (t) => {
  const { root, id, work } = setup(t);
  const still = () => ({ ok: false, error: 'no Blender in this test' });
  const a = buildPool(root, id, { modelStill: still });
  assert.equal(a.rebuilt, true);
  assert.equal(buildPool(root, id, { modelStill: still }).rebuilt, false);
  w(root, 'packs/assets/city/images/second.png', png);
  const c = buildPool(root, id, { modelStill: still });
  assert.equal(c.rebuilt, true); assert.ok(c.assets.some((x) => x.id === 'img:second'));
  // a model Blender could not draw is kept with its reason, never dropped
  assert.match(c.assets.find((x) => x.id === 'model:chair').note, /no Blender/);
  assert.equal(buildPool(root, id, { force: true, modelStill: still }).rebuilt, true);
  assert.ok(existsSync(join(work, 'design', 'pool.json')));
});

test('the prompt gets one short line per asset (never the files); over 150 the scene words pick', (t) => {
  const { root, id } = setup(t);
  const pool = buildPool(root, id, { modelStill: () => ({ ok: false, error: 'x' }) });
  const lines = poolLines(pool);
  assert.ok(lines.includes('color:accent · #fd3a25 · accent: one word'));
  assert.ok(lines.some((l) => l.startsWith('icon:arrow-right · icon')));
  assert.ok(lines.some((l) => /^doc:brief · document/.test(l)));
  const many = { assets: [...pool.assets.filter((a) => a.kind === 'color'), ...Array.from({ length: 300 }, (_, i) => ({ id: `img:p${i}`, kind: 'image', tags: i === 250 ? ['skyline'] : ['x'], w: 1, h: 1 }))] };
  const cut = poolLines(many, { sceneWords: 'the skyline at night', max: 20 });
  assert.equal(cut.length, 20); assert.ok(cut.some((l) => l.startsWith('color:accent'))); assert.ok(cut.some((l) => l.startsWith('img:p250')));
});

test('missing assets: a lookup in the pool, ids only', (t) => {
  const { root, id, work } = setup(t);
  const pool = buildPool(root, id, { modelStill: () => ({ ok: false, error: 'x' }) });
  const code = `const a = asset('img:skyline'); const b = tex('halftone-dots', {}); <Icon id="icon:arrow-right" color={color('color:accent')} />
    <Icon id="arrow-nope"/> const c = asset('img:ghost'); font('font:heading')`;
  const r = checkAssetRefs(code, pool, { work });
  assert.deepEqual(r.missing.sort(), ['icon:arrow-nope', 'img:ghost']);
  assert.equal(r.ok, false);
  assert.equal(checkAssetRefs("asset('img:skyline')", pool, { work }).ok, true);
  // a row whose file was deleted from the public folder is flagged
  writeFileSync(join(work, 'x'), '');
  mkdirSync(join(work, 'video', 'src', 'public', 'pool', 'images'), { recursive: true });
  assert.deepEqual(checkAssetRefs("asset('img:skyline')", pool, { work: join(work, 'nowhere') }).noFile, ['img:skyline']);
});

test('file readers: sizes, icons, documents', () => {
  assert.equal(parseIcon(ARROW).shapes.length, 1);
  assert.equal(parseIcon(TEXTICON).hasText, true);
  assert.equal(poolTs([{ id: 'doc:x', kind: 'document', text: 'long' }]).includes('"long"'), false);
  const dir = join(process.env.TMPDIR || '/tmp', `pf-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.png'), grainPng({ size: 40 })); writeFileSync(join(dir, 'b.svg'), '<svg viewBox="0 0 30 20"></svg>'); writeFileSync(join(dir, 'c.bin'), 'zz'); writeFileSync(join(dir, 'd.docx'), docx());
  assert.deepEqual(imageSize(join(dir, 'a.png')), { w: 40, h: 40 });
  assert.deepEqual(imageSize(join(dir, 'b.svg')), { w: 30, h: 20 });
  assert.match(readDocument(join(dir, 'c.bin')).note, /no reader/);
  assert.equal(readDocument(join(dir, 'd.docx')).images.length, 1);
  assert.match(readDocument(join(dir, 'a.pdf')).note || '', /could not read|not read/); // missing file: a note, no throw
});

// The real check (plan 90 §4.2, the main risk): a pack font, an icon, a texture, an image and a default halftone all draw in
// Kinetograph with no "not drawn" warning. Needs the studio's Kinetograph and a render queue: MFX_REAL_RENDER=1 node --test ...
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { kgStill } from '../src/kinetograph.mjs';
import { homedir } from 'node:os';
test('REAL: the pool draws in Kinetograph with no warnings', { skip: !process.env.MFX_REAL_RENDER }, (t) => {
  const { root, id, work } = setup(t);
  mkdirSync(join(root, 'packs/style/aig/fonts'), { recursive: true });
  for (const n of ['Bold', 'Regular']) copyFileSync('/usr/share/fonts/TTF/DejaVuSerif-Bold.ttf', join(root, `packs/style/aig/fonts/Urbanist-${n}.ttf`));
  const pool = buildPool(root, id, { modelStill: () => ({ ok: false, error: 'x' }), force: true });
  const src = join(work, 'video', 'src');
  writeFileSync(join(src, 'index.ts'), "import { registerRoot } from 'remotion';\nimport { Root } from './Root';\nregisterRoot(Root);\n");
  writeFileSync(join(src, 'Root.tsx'), `import React from 'react';
import { Composition, AbsoluteFill, Img } from 'remotion';
import { asset, tex, font, color, Icon } from './pool';
const F: React.FC = () => (<AbsoluteFill style={{ background: color('color:ground'), fontFamily: font('font:heading') }}>
  <AbsoluteFill style={tex('paper')} /><AbsoluteFill style={tex('halftone-dots')} /><AbsoluteFill style={tex('gradient-glow')} />
  <div style={{ fontSize: 120, fontWeight: 700 }}>Pool frame</div><Img src={asset('img:skyline')} style={{ width: 300 }} /><Icon id="icon:arrow-right" color="#f00" size={200} /></AbsoluteFill>);
export const Root = () => <Composition id="F" component={F} width={1920} height={1080} fps={30} durationInFrames={30} />;
`);
  const cmd = kgStill({ root: join(homedir(), 'Mortiflix'), entry: 'src/index.ts', composition: 'F', output: join(work, 'out-real.png') });
  const r = spawnSync('render-queue', ['-l', 'sf pool real test', '--', 'bash', '-c', cmd], { cwd: join(work, 'video'), encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(work, 'out-real.png')));
  assert.ok(!/warning|not loaded|not drawn/i.test(r.stdout + r.stderr), r.stdout);
  assert.ok(pool.assets.length > 10);
});

import { harness } from './sf-helpers.mjs';
test('service: pool.get builds the pool, project.packs.assets changes the asset packs and rebuilds it, packs.files lists a pack', async (t) => {
  const { root, id } = setup(t);
  const h = harness(t, root);
  await h.call('project.open', { id });
  const g = await h.call('pool.get');
  assert.ok(g.assets.some((a) => a.id === 'color:accent') && g.assets.every((a) => !('text' in a) && !('shapes' in a)));
  assert.ok(g.lines.length > 5);
  assert.deepEqual(g.packs.map((p) => p.id), ['aig', 'city']);
  w(root, 'packs/assets/second/pack.json', JSON.stringify({ kind: 'assets', name: 'Second' }));
  w(root, 'packs/assets/second/images/moon.png', png);
  const r = await h.call('project.packs.assets', { assets: ['city', 'second'] });
  assert.deepEqual(r.assets.map((a) => a.id), ['city', 'second']);
  assert.ok((await h.call('pool.get')).assets.some((a) => a.id === 'img:moon'));
  await assert.rejects(h.call('project.packs.assets', { assets: ['nope'] }), /no assets pack/);
  const f = await h.call('packs.files', { kind: 'assets', id: 'second' });
  assert.equal(f.files[0].kind, 'picture');
  assert.ok(h.events('pool.changed').length >= 1);
  const list = await h.call('packs.list', { kind: 'assets' });
  assert.ok(list.every((p) => !('asset_files' in p)) && list[0].brings);
});
