// Style frames v3, version 15: "Add pack…" (packs.add): a folder or .zip becomes a pack, any files, a pack.json written when there is none,
// a suggested palette measured from the poster that the owner confirms, private by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { harness } from './sf-helpers.mjs';
import { zip } from '../src/zip.mjs';
import { encodePng } from '../src/svc/png.mjs';
import { addPack, confirmPack, suggestPalette, fontFamilyOf } from '../src/svc/packadd.mjs';
import { listAllPacks } from '../src/svc/packs.mjs';
import { cleanPacks } from '../src/svc/projectpacks.mjs';

const DEJAVU = '/usr/share/fonts/TTF/DejaVuSerif-Bold.ttf';
const w = (base, rel, data = 'x') => { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), data); };
// a poster: 60% cream, 25% dark ink, 15% hot red
function poster() {
  const W = 100, H = 100, d = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { const c = i < 6000 ? [250, 245, 230] : i < 8500 ? [20, 22, 30] : [250, 58, 37]; d.set([...c, 255], i * 4); }
  return encodePng(W, H, d);
}
function src(t) { const d = mkdtempSync(join(tmpdir(), 'addsrc-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test('a folder with no pack.json: copied, any file kept, fonts named, palette suggested from the poster, private by default, owner confirms', (t) => {
  const root = tempStudio(t);
  const d = src(t);
  w(d, 'poster.png', poster());
  w(d, 'brand.pdf', '%PDF-1.1'); w(d, 'notes/brief.docx', 'zipish'); w(d, 'models/chair.glb', 'glb'); w(d, 'weird.xyz', 'q');
  if (existsSync(DEJAVU)) { mkdirSync(join(d, 'fonts')); copyFileSync(DEJAVU, join(d, 'fonts', 'Anything-Bold.ttf')); }
  w(d, '.hidden/secret.txt', 'no');
  const p = addPack(root, { path: d, kind: 'style', name: 'Black Ink' });
  assert.equal(p.kind, 'style'); assert.equal(p.id, 'black-ink'); assert.equal(p.name, 'Black Ink');
  assert.equal(p.share, false); assert.match(p.license, /never share/i); assert.equal(p.needs_confirm, true);
  assert.ok(p.suggested_palette.includes('#faf5e6') && p.suggested_palette.some((c) => c === '#fa3a25' || c.startsWith('#f')), p.suggested_palette.join());
  assert.equal(p.suggested_palette.length, 3);
  if (existsSync(DEJAVU)) assert.deepEqual(p.fonts, ['DejaVu Serif']); // read from the font file, not its file name
  assert.ok(existsSync(join(root, 'packs/style/black-ink/brand.pdf')) && existsSync(join(root, 'packs/style/black-ink/weird.xyz')) && existsSync(join(root, 'packs/style/black-ink/models/chair.glb')));
  assert.ok(!existsSync(join(root, 'packs/style/black-ink/.hidden')));
  assert.match(p.brings, /1 picture/); assert.match(p.brings, /1 3D model/); assert.match(p.brings, /2 documents/);
  const j = JSON.parse(readFileSync(join(root, 'packs/style/black-ink/pack.json'), 'utf8'));
  assert.equal(j.spec, 2); assert.equal(j.confirmed, false); assert.deepEqual(j.palette, []); // nothing is used until the owner confirms
  // the owner confirms (or edits) the palette
  assert.throws(() => cleanPacks(root, { style: 'black-ink' }), /confirm its colours first/); // not used before the owner confirms
  const c = confirmPack(root, { kind: 'style', id: 'black-ink', palette: [{ hex: '#faf5e6', job: 'ground', rule: 'background' }, '#14161e', { hex: '#fa3a25', job: 'accent', rule: 'one word' }] });
  assert.deepEqual(c.palette, ['#faf5e6', '#14161e', '#fa3a25']); assert.equal(c.style.palette[1].job, 'c2'); assert.equal(c.style.palette[2].rule, 'one word');
  assert.equal(JSON.parse(readFileSync(join(root, 'packs/style/black-ink/pack.json'), 'utf8')).confirmed, true);
  assert.equal(cleanPacks(root, { style: 'black-ink' }).style.id, 'black-ink'); // confirmed: it can be picked
  assert.throws(() => confirmPack(root, { kind: 'style', id: 'black-ink', palette: ['red'] }), /at least one colour/);
  assert.throws(() => confirmPack(root, { kind: 'style', id: 'nope' }), /no style pack/);
});

test('a .zip (one top folder is flattened), a name that is taken gets -2, a pack.json of its own is kept with its licence', (t) => {
  const root = tempStudio(t);
  const d = src(t);
  const z = join(d, 'city.zip');
  writeFileSync(z, Buffer.from(zip([{ name: 'City Pack/pack.json', data: Buffer.from(JSON.stringify({ kind: 'assets', name: 'City', license: 'CC0', share: true })) }, { name: 'City Pack/images/sky.png', data: poster() }, { name: '__MACOSX/x', data: Buffer.from('m') }])));
  const a = addPack(root, { path: z });
  assert.equal(a.kind, 'assets'); assert.equal(a.id, 'city'); assert.equal(a.license, 'CC0'); assert.equal(a.share, true); assert.equal(a.counts.picture, 1);
  assert.equal(a.needs_confirm, false);
  assert.ok(!existsSync(join(root, 'packs/assets/city/__MACOSX')));
  const b = addPack(root, { path: z });
  assert.equal(b.id, 'city-2');
  // an own pack.json with no licence gets the private default
  const d2 = src(t); w(d2, 'pack.json', JSON.stringify({ kind: 'assets', name: 'Mine' })); w(d2, 'a.txt');
  const m = addPack(root, { path: d2 });
  assert.equal(m.share, false); assert.match(m.license, /never share/i);
  assert.equal(listAllPacks(root, 'assets').length, 3);
});

test('refusals: nothing there, a non-zip file, a zip that leaves its folder, a kind the studio does not know', (t) => {
  const root = tempStudio(t);
  const d = src(t);
  assert.throws(() => addPack(root, { path: join(d, 'nope') }), /No file or folder/);
  w(d, 'a.txt'); assert.throws(() => addPack(root, { path: join(d, 'a.txt') }), /folder or a \.zip/);
  const bad = join(d, 'bad.zip');
  writeFileSync(bad, Buffer.from(zip([{ name: '../evil.txt', data: Buffer.from('x') }])));
  assert.throws(() => addPack(root, { path: bad }), /leaves its folder/);
  assert.ok(!existsSync(join(tmpdir(), 'evil.txt')));
  const d3 = src(t); w(d3, 'pack.json', JSON.stringify({ kind: 'weirdkind', name: 'W' }));
  assert.throws(() => addPack(root, { path: d3 }), /does not know the pack kind/);
  assert.equal(listAllPacks(root, 'assets').length, 0);
});

test('palette from a picture and font family names', () => {
  assert.deepEqual(suggestPalette(poster()).slice(0, 1), ['#faf5e6']);
  assert.equal(fontFamilyOf('/no/such/Some-Bold.ttf'), 'Some');
  if (existsSync(DEJAVU)) assert.equal(fontFamilyOf(DEJAVU), 'DejaVu Serif');
});

test('service: packs.add then packs.confirm, then the pack is a card with what it brings', async (t) => {
  const root = tempStudio(t);
  const d = src(t); w(d, 'poster.png', poster()); w(d, 'icons/a.svg', '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
  const h = harness(t, root);
  const r = await h.call('packs.add', { path: d, kind: 'style', name: 'Added' });
  assert.equal(r.needs_confirm, true); assert.ok(r.suggested_palette.length);
  const c = await h.call('packs.confirm', { kind: 'style', id: r.id, palette: r.suggested_palette });
  assert.equal(c.palette.length, r.suggested_palette.length);
  const list = await h.call('packs.list', { kind: 'style' });
  assert.equal(list[0].id, r.id); assert.match(list[0].brings, /icon/); assert.ok(h.events('packs.changed').length >= 2);
  await assert.rejects(h.call('packs.add', { path: '/no/where' }), /No file or folder/);
});
