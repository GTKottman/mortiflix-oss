// Style frames v3, version 5: measured checks (safe area, collisions, contrast from pixels, missing assets, layout warnings, key words).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng, decodePng } from '../src/svc/png.mjs';
import { safeArea, collisions, readability, renderWarnings, declaredTexts, measureFrame, flatLayers, textBoxes } from '../src/svc/inspect.mjs';

const W = 400, H = 200;
const L = (id, type, x, y, w, h, extra = {}) => ({ id, type, opacity: 1, bounds: { x, y, width: w, height: h }, ...extra });
const T = (id, x, y, w, h, text = '') => L(id, 'text', x, y, w, h, { text: { text, lines: [{ text }] } });
const insp = (layers) => ({ width: W, height: H, layers });
// a picture: background colour, then boxes of another colour where the text is
function pic(bg, boxes = []) {
  const d = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { d[i * 4] = bg[0]; d[i * 4 + 1] = bg[1]; d[i * 4 + 2] = bg[2]; d[i * 4 + 3] = 255; }
  for (const [x, y, w, h, c] of boxes) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx += 2) { const o = (yy * W + xx) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; }
  return encodePng(W, H, d);
}

test('png: written and read back exactly', () => {
  const d = new Uint8Array(4 * 4 * 4).map((_, i) => (i * 7) % 256);
  const back = decodePng(encodePng(4, 4, d));
  assert.equal(back.w, 4); assert.deepEqual([...back.data], [...d]);
  assert.throws(() => decodePng(Buffer.from('nope')), /not a PNG/);
});

test('safe area: a text box closer than 5% to an edge fails, naming the side', () => {
  assert.equal(safeArea(insp([T('a', 40, 40, 200, 40)])).pass, true);
  const r = safeArea(insp([T('a', 10, 40, 200, 40), T('b', 100, 156, 100, 40)]));
  assert.equal(r.pass, false); assert.deepEqual(r.items.map((i) => i.sides), [['left'], ['bottom']]);
  assert.equal(safeArea(insp([T('faded', 5, 5, 50, 20)].map((l) => ({ ...l, opacity: 0.2 })))).pass, true); // not shown: not checked
});

test('collisions: two texts overlap; a text out of its panel; a shape painted over a text; a panel that holds the text is fine', () => {
  const full = L('bg', 'shape', 0, 0, W, H);
  assert.equal(collisions(insp([full, L('panel', 'shape', 30, 30, 300, 100), T('t', 50, 50, 200, 40)])).pass, true);
  assert.equal(collisions(insp([full, T('a', 50, 50, 200, 40), T('b', 60, 60, 200, 40)])).pass, false);
  const out = collisions(insp([L('panel', 'shape', 30, 30, 100, 100), T('t', 50, 50, 200, 40)]));
  assert.equal(out.pass, false); assert.match(out.items[0].why, /sticks out/);
  const over = collisions(insp([T('t', 50, 50, 200, 40), L('shape', 'shape', 60, 40, 100, 100)]));
  assert.match(over.items[0].why, /painted over/);
  // a texture tile (small bounds, clipped to the frame) is a background, not a collision
  assert.equal(collisions(insp([L('tile', 'shape', 0, 0, 27, 27, { clip: 'polygon', clipBounds: { x: 0, y: 0, width: W, height: H } }), T('t', 50, 50, 200, 40)])).pass, true);
  // layers inside groups count, with their group's opacity
  assert.equal(flatLayers(insp([{ id: 'g', type: 'group', opacity: 0.5, children: [T('x', 50, 50, 100, 30)] }]))[0].op, 0.5);
});

test('readability: measured on the rendered pixels, 4.5:1 (3:1 from 36 px)', () => {
  const box = [50, 50, 200, 40];
  const good = readability(insp([T('t', ...box)]), pic([250, 250, 250], [[50, 50, 200, 40, [10, 10, 10]]]));
  assert.equal(good.pass, true); assert.ok(good.items[0].ratio > 15); assert.equal(good.items[0].fg, '#0a0a0a');
  const grey = readability(insp([T('t', ...box)]), pic([120, 120, 120], [[50, 50, 200, 40, [140, 140, 140]]]));
  assert.equal(grey.pass, false); assert.ok(grey.items[0].ratio < 2);
  // 3:1 is enough for big text: two lines of 144 px high = 60 px each = 50 px type
  const big = { ...T('t', 50, 50, 200, 120), text: { text: '', lines: [{}] } };
  const mid = readability(insp([big]), pic([255, 255, 255], [[50, 50, 200, 120, [140, 140, 140]]]));
  assert.equal(mid.items[0].need, 3); assert.equal(mid.items[0].ok, true); // 140 on white is about 3.4:1
  // a text that is not visible on its background fails
  assert.equal(readability(insp([T('t', ...box)]), pic([30, 30, 30])).pass, false);
});

test('render warnings and the words in the code', () => {
  const out = 'renderer: Skia\nwarning: 2 kinds of unsupported content in 1 frame, drawn without it (--strict fails instead):\n  div { filter: blur(4px) }: not drawn (frame 0)\n  div { font-family: X }: font not loaded (frame 0)\nwrote x.png\n';
  assert.deepEqual(renderWarnings(out).length, 2); assert.deepEqual(renderWarnings('wrote x.png'), []);
  const texts = declaredTexts(`const A = () => <div style={{ color: '#fff' }}><h1>Black October</h1><p>Four bugs are exploited.</p><Img src={asset('img:sky')} /></div>; const k = "Patch now";`);
  assert.ok(texts.includes('Black October') && texts.includes('Four bugs are exploited.') && texts.includes('Patch now'));
  assert.ok(!texts.includes('#fff') && !texts.includes('img:sky'));
});

test('measureFrame: all checks together; one failing check is a problem in plain words; key words read from the code when inspect gives no text', () => {
  const pool = { assets: [{ id: 'img:sky', kind: 'image', file: 'pool/images/sky.png' }] };
  const ok = measureFrame({ inspect: insp([T('t', 50, 50, 200, 40)]), png: pic([250, 250, 250], [[50, 50, 200, 40, [10, 10, 10]]]), pool, code: "<h1>Black October</h1> asset('img:sky')", warnings: '', keys: ['October'] });
  assert.equal(ok.ok, true, ok.problems.join('; ')); assert.equal(ok.texts.basis, 'code');
  const bad = measureFrame({ inspect: insp([T('t', 5, 50, 200, 40)]), png: pic([250, 250, 250]), pool, code: "<h1>Hi</h1> asset('img:ghost')", warnings: 'warning: x:\n  div: not drawn (frame 0)\n', keys: ['October'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.entries(bad.checks).filter(([, c]) => !c.pass).map(([k]) => k).sort(), ['key-words', 'no-layout-errors', 'no-missing-assets', 'text-contrast', 'text-safe-area']);
  assert.match(bad.problems.join(' '), /no-missing-assets: missing: img:ghost/);
  // inspect that does give the text is used as it is
  const fromInspect = measureFrame({ inspect: insp([T('t', 50, 50, 200, 40, 'October rises')]), png: pic([250, 250, 250], [[50, 50, 200, 40, [10, 10, 10]]]), keys: ['october'] });
  assert.equal(fromInspect.texts.basis, 'inspect'); assert.equal(fromInspect.checks['key-words'].pass, true);
  assert.equal(textBoxes(insp([T('t', 1, 1, 0, 0)])).length, 0);
});

import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { measureFrames } from '../src/quickframes.mjs';
test('quickframes measureFrames: reads the rendered PNG and the (mocked) inspect, saves sfNN.inspect.json, never throws', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'out', 'frames'), { recursive: true });
  writeFileSync(join(work, 'out', 'frames', 'sf01.png'), pic([250, 250, 250], [[50, 50, 200, 40, [10, 10, 10]]]));
  const probe = async (comp) => insp([T('t', 50, 50, 200, 40)]);
  const [a, b] = await measureFrames({ root, id: p.id, work, frames: [{ id: 'SF01', label: 'SF01 · Opening' }, { id: 'SF02', label: 'SF02' }], probe });
  assert.equal(a.ok, true, a.problems.join('; '));
  assert.ok(existsSync(join(work, 'out', 'frames', 'sf01.inspect.json')));
  assert.equal(b.ok, false); // no picture for sf02: contrast not measured, said plainly
  assert.match(b.problems.join(' '), /text-contrast/);
  const [c] = await measureFrames({ root, id: p.id, work, frames: [{ id: 'SF01' }], probe: async () => { throw new Error('inspect timed out'); } });
  assert.match(c.problems[0], /not measured: inspect timed out/);
});

// 261102-why-ice-is-slippery-61dc SF01 (2026-11-02): failed 4 renders on (1) its caption "Probably <span>not</span> for the reason
// you learned." reported as three text layers with one box, and (2) the big "Y" and "?" reaching past a frost-dot corner whose
// ground is the page's own colour (no edge on screen).
test('collisions: one text block split into runs (id, id~2, id~3) is ONE text, not three overlapping texts', () => {
  const full = L('bg', 'shape', 0, 0, W, H);
  const runs = [T('cap', 40, 150, 300, 24), T('cap~2', 40, 150, 300, 24), T('cap~3', 40, 150, 300, 24)];
  assert.equal(collisions(insp([full, ...runs])).pass, true);
  // a real second text over it still fails, with its boxes and by how much
  const r = collisions(insp([full, ...runs, T('other', 100, 160, 100, 24)]));
  assert.equal(r.pass, false); assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].by, { w: 100, h: 14 });
  assert.match(r.note, /text cap \(300×24 at 40,150\) and text other \(100×24 at 100,160\) overlap by 100×14 px/);
});

test('collisions: a text past a panel whose edge does not show (same colour as the ground) passes; a visible panel edge fails with the px', () => {
  const ground = [12, 20, 34];
  const corner = L('corner', 'shape', 200, 0, 200, 100); // a corner panel, painted in the ground's colour
  const big = T('Y', 180, 80, 60, 60); // reaches 20 px left of it and 40 px below it
  const flat = decodePng(pic(ground, [[180, 80, 60, 60, [240, 240, 240]]]));
  assert.equal(collisions(insp([corner, big]), flat).pass, true, 'no edge on screen: nothing to stick out of');
  const card = decodePng(pic(ground, [[200, 0, 200, 100, [60, 90, 140]], [180, 80, 60, 60, [240, 240, 240]]]));
  const r = collisions(insp([corner, big]), card);
  assert.equal(r.pass, false);
  assert.deepEqual(r.items[0].by, { left: 20, bottom: 40 });
  assert.match(r.note, /text Y \(60×60 at 180,80\) sticks out of shape corner \(200×100 at 200,0\) by 20 px left, 40 px bottom/);
  // without the picture the check stays strict
  assert.equal(collisions(insp([corner, big])).pass, false);
});

test('contrast: a short word in a wide box (glyphs under 10% of the box) is measured on its glyphs, not read as the background on itself', () => {
  // 261102-mortiflix-v3-video-d4fd SF01: "DEBTOR" in a 548 px box measured "#ede6d6 on #ede6d6 = 1:1"
  const cream = [237, 230, 214], ink = [40, 34, 30];
  const r = readability(insp([T('w', 40, 60, 300, 30)]), decodePng(pic(cream, [[44, 66, 20, 18, ink]])));
  assert.equal(r.pass, true, r.note); assert.ok(r.items[0].ratio > 10);
  // text truly the colour of what is behind it still fails
  assert.equal(readability(insp([T('w', 40, 60, 300, 30)]), decodePng(pic(cream, []))).pass, false);
});

test('collisions: lines on a turned card are compared in the card\'s own frame; a strike-through on a text is drawn on purpose', () => {
  // d4fd SF02: two lines of a tag turned 2°: their axis-aligned bounds overlap, the lines do not
  const c = Math.cos(0.035), s = Math.sin(0.035);
  const rot = (id, type, ex, ey, w, h) => ({ id, type, opacity: 1, matrix: [c, -s, s, c, ex, ey], box: { x: 0, y: 0, width: w, height: h }, bounds: { x: ex, y: ey - s * w, width: w * c + h * s, height: h * c + w * s }, ...(type === 'text' ? { text: { text: '', lines: [{}] } } : {}) });
  const l1 = rot('l1', 'text', 100, 100, 300, 30), l2 = { ...rot('l2', 'text', 100 - s * 32, 100 + c * 32, 300, 30) };
  assert.ok(l2.bounds.y < l1.bounds.y + l1.bounds.height, 'their bounds overlap');
  assert.equal(collisions(insp([l1, l2])).pass, true);
  // a strike-through line over the middle of a word is not "painted over" it; a block over it still is
  assert.equal(collisions(insp([T('w', 40, 60, 200, 40), L('strike', 'shape', 40, 78, 200, 4)])).pass, true);
  assert.equal(collisions(insp([T('w', 40, 60, 200, 40), L('block', 'shape', 40, 60, 100, 40)])).pass, false);
});

test('safe area: a centred line in a box as wide as its card counts by where its ink is; ink near the edge still fails', () => {
  const cream = [237, 230, 214], ink = [40, 34, 30];
  const box = T('w', 10, 80, 380, 30);
  assert.equal(safeArea(insp([box]), decodePng(pic(cream, [[150, 84, 100, 20, ink]]))).pass, true);
  assert.equal(safeArea(insp([box]), decodePng(pic(cream, [[12, 84, 100, 20, ink]]))).pass, false);
  assert.equal(safeArea(insp([box])).pass, false, 'without the picture the box decides');
});

test('contrast: what is behind the glyphs is read inside the box, not the page around a card the box fills', () => {
  const page = [19, 19, 20], tag = [230, 100, 77], ink = [21, 22, 26];
  // the text box fills a tag edge to edge; the ring around it is the dark page
  const img = decodePng(pic(page, [[100, 60, 200, 40, tag], [101, 60, 200, 40, tag], [150, 70, 60, 16, ink]]));
  const r = readability(insp([T('w', 100, 60, 200, 40)]), img);
  assert.equal(r.pass, true, r.note); assert.ok(r.items[0].ratio > 4.5);
});
