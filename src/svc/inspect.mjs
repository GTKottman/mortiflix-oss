// Measured checks for one rendered frame (plan 90 §1.5, layer 1): free, exact, and a hard gate: the AI cannot pass a frame
// that fails these. Used by the style frames and the stills.
//   text-safe-area      every text box lies at least 5% inside each edge (from `kinetograph inspect`, the real boxes)
//   no-collisions       text boxes that overlap each other; a text box that sticks out of the panel or picture behind it, or
//                       is covered by something painted after it
//   text-contrast       the contrast of the RENDERED PIXELS behind each text box against the text's own colour (4.5:1, 3:1
//                       from 36 px up). The AI's own list of colour pairs is gone.
//   no-missing-assets   every asset id in the frame's code is in the pool and its file is there (svc/pool.mjs)
//   no-layout-errors    Kinetograph's "not drawn" warnings for the render are empty
//   key-words           (stills) each line's key word is in the frame's text
// What this build of Kinetograph does NOT give: `inspect` reports every text box and its place, but its `text.text` is empty
// and it has no text colour or font size. So the words come from the frame's code (basis "code"), the colour comes from the
// pixels, and the size from the box height; a build whose inspect fills `text.text` is used as it is (basis "inspect").
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { decodePng } from './png.mjs';
import { checkAssetRefs } from './pool.mjs';
import { probeKinetograph } from '../motiondata.mjs';

export const SAFE = 0.05;
const r2 = (n) => Math.round(n * 100) / 100;

// ---- run inspect ----
export async function inspectFrame({ root, work, comp, entry = 'src/index.ts', frame = 0, probe = null, save = null }) {
  const p = probe || probeKinetograph({ root, work, comp, entry });
  const result = await p(frame);
  if (save) { mkdirSync(dirname(save), { recursive: true }); writeFileSync(save, JSON.stringify(result)); }
  return result;
}

// ---- the layers, in paint order, with their opacity and where they really are ----
export function flatLayers(result) {
  const out = [];
  const W = result.width, H = result.height;
  const walk = (layers, parent) => (layers || []).forEach((l) => {
    const op = parent * (Number.isFinite(l.opacity) ? l.opacity : 1);
    if (l.children?.length) return walk(l.children, op);
    // a layer clipped to a frame-sized region (a texture tile) counts by its clip
    const b = l.clipBounds && l.clip ? l.clipBounds : l.bounds;
    if (!b) return;
    // m (matrix [a,b,c,d,e,f]) and box (the layer's own, unrotated rectangle) let two layers turned the same way be compared in
    // their own frame: the axis-aligned bounds of a turned card overlap where the lines on it do not (d4fd SF02's tilted tags)
    const m = Array.isArray(l.matrix) && l.matrix.length === 6 && l.box && !(l.clipBounds && l.clip) ? l.matrix : null;
    out.push({ id: String(l.id ?? out.length), type: l.type, op, x: b.x, y: b.y, w: b.width, h: b.height, full: b.width >= W * 0.9 && b.height >= H * 0.9, text: l.type === 'text' ? l.text || {} : null, order: out.length, m, box: m ? l.box : null });
  });
  walk(result.layers, 1);
  return out;
}
export const textBoxes = (result) => flatLayers(result).filter((l) => l.type === 'text' && l.op >= 0.5 && l.w > 1 && l.h > 1);

const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const contains = (o, t, tol = 3) => o.x <= t.x + tol && o.y <= t.y + tol && o.x + o.w >= t.x + t.w - tol && o.y + o.h >= t.y + t.h - tol;

// Where a text's ink really is, from the picture: the box of its glyph pixels (1.5:1 or more from the box's median), in the
// frame's px. A centred line in a box as wide as its card has its words well inside the edge its box touches (d4fd SF02's tags).
export function inkBox(t, img, result) {
  const { w: W, h: H, data } = img;
  const sx = W / result.width, sy = H / result.height;
  const x0 = Math.max(0, Math.floor(t.x * sx)), y0 = Math.max(0, Math.floor(t.y * sy)), x1 = Math.min(W, Math.ceil((t.x + t.w) * sx)), y1 = Math.min(H, Math.ceil((t.y + t.h) * sy));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const ls = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ls.push(lumOf(data, (y * W + x) * 4));
  const med = [...ls].sort((a, b) => a - b)[Math.floor(ls.length / 2)];
  let ax = Infinity, ay = Infinity, bx = -1, by = -1, n = 0;
  for (let y = y0, i = 0; y < y1; y++) for (let x = x0; x < x1; x++, i++) if (ratio(ls[i], med) >= 1.5) { n++; if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y; }
  if (n < 4) return null;
  return { x: ax / sx, y: ay / sy, w: (bx - ax + 1) / sx, h: (by - ay + 1) / sy };
}

export function safeArea(result, img = null) {
  const W = result.width, H = result.height;
  const bad = [];
  for (const t0 of textBoxes(result)) {
    const ink = img ? inkBox(t0, img, result) : null;
    const t = ink ? { ...t0, ...ink } : t0;
    const sides = [];
    if (t.x < SAFE * W) sides.push('left'); if (t.y < SAFE * H) sides.push('top');
    if (t.x + t.w > (1 - SAFE) * W) sides.push('right'); if (t.y + t.h > (1 - SAFE) * H) sides.push('bottom');
    if (sides.length) bad.push({ id: t.id, text: t.text?.text || '', sides, box: { x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.w), h: Math.round(t.h) } });
  }
  return { pass: !bad.length, items: bad, note: bad.length ? `${bad.length} text box${bad.length === 1 ? ' is' : 'es are'} closer than 5% to an edge (${bad.map((b) => b.sides.join('+')).join(', ')})` : `every text box is at least 5% inside every edge (${textBoxes(result).length} checked)` };
}

// One text block can come back from `kinetograph inspect` as several layers: a <span> inside a line ("Probably <span>not</span> for…")
// is reported as `id`, `id~2`, `id~3`, all with the block's box. They are ONE text: merged here, never "two texts overlap"
// (261102-why-ice-is-slippery-61dc, 2026-11-02: SF01 failed 4 renders and 3 fixes on its own caption's runs).
const baseId = (id) => String(id).replace(/~\d+$/, '');
const turned = (l) => l.m && (Math.abs(l.m[1]) > 1e-4 || Math.abs(l.m[2]) > 1e-4 || Math.abs(l.m[0] - l.m[3]) > 1e-4);
// Two layers in the frame both share: when both are turned the same way (same matrix but for the move), their own rectangles in
// that turned frame; otherwise their bounds as they are.
export function sameFrame(a, b) {
  if (!turned(a) && !turned(b)) return [a, b];
  if (!a.m || !b.m || [0, 1, 2, 3].some((i) => Math.abs(a.m[i] - b.m[i]) > 1e-3)) return [a, b];
  const [p, q, r, t] = a.m; const det = p * t - r * q;
  if (Math.abs(det) < 1e-9) return [a, b];
  const local = (l) => { const ex = l.m[4], ey = l.m[5]; const x = (t * ex - r * ey) / det, y = (-q * ex + p * ey) / det; return { ...l, x: x + (l.box.x || 0), y: y + (l.box.y || 0), w: l.box.width, h: l.box.height }; };
  return [local(a), local(b)];
}
export function mergedTexts(all) {
  const by = new Map();
  for (const l of all) {
    if (l.type !== 'text' || l.op < 0.5 || l.w <= 1 || l.h <= 1) continue;
    const k = baseId(l.id);
    const m = by.get(k);
    if (!m) { by.set(k, { ...l, id: k, last: l.order }); continue; }
    const x = Math.min(m.x, l.x), y = Math.min(m.y, l.y);
    Object.assign(m, { x, y, w: Math.max(m.x + m.w, l.x + l.w) - x, h: Math.max(m.y + m.h, l.y + l.h) - y, last: Math.max(m.last, l.order), m: null, box: null });
  }
  return [...by.values()];
}
const box = (l) => `${Math.round(l.w)}×${Math.round(l.h)} at ${Math.round(l.x)},${Math.round(l.y)}`;
const overlapOf = (a, b) => ({ w: Math.round(Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))), h: Math.round(Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))) });
// how far text t reaches past each side of o, in px (only the sides it crosses)
const outBy = (o, t, tol = 3) => {
  const s = {};
  if (t.x < o.x - tol) s.left = Math.round(o.x - t.x);
  if (t.y < o.y - tol) s.top = Math.round(o.y - t.y);
  if (t.x + t.w > o.x + o.w + tol) s.right = Math.round(t.x + t.w - o.x - o.w);
  if (t.y + t.h > o.y + o.h + tol) s.bottom = Math.round(t.y + t.h - o.y - o.h);
  return s;
};
// Is the panel's edge on that side visible in the rendered picture? A "panel" painted in the ground's own colour, or a texture
// that fades out before its edge (the frost corner of the same frame), has no edge to stick out of. Compares the mean colour
// just inside the edge (and on it, for a border) with the mean just outside, along the whole side, away from every text box.
export function edgeVisible(img, scale, o, side, texts, { min = 12 } = {}) {
  const { w: W, h: H, data } = img;
  const vertical = side === 'left' || side === 'right';
  const edge = side === 'left' ? o.x : side === 'right' ? o.x + o.w : side === 'top' ? o.y : o.y + o.h;
  const into = side === 'left' || side === 'top' ? 1 : -1; // the direction that goes into the panel
  const from = vertical ? o.y : o.x, to = vertical ? o.y + o.h : o.x + o.w;
  const inText = (x, y) => texts.some((t) => x >= t.x - 4 && x <= t.x + t.w + 4 && y >= t.y - 4 && y <= t.y + t.h + 4);
  const band = (d0, d1) => {
    const sum = [0, 0, 0]; let n = 0;
    for (let a = from; a < to; a += 2) for (let d = d0; d <= d1; d++) {
      const p = edge + into * d;
      const x = vertical ? p : a, y = vertical ? a : p;
      if (inText(x, y)) continue;
      const px = Math.floor(x * scale.x), py = Math.floor(y * scale.y);
      if (px < 0 || py < 0 || px >= W || py >= H) return null; // the side is the frame's own edge: not a panel edge
      const k = (py * W + px) * 4; sum[0] += data[k]; sum[1] += data[k + 1]; sum[2] += data[k + 2]; n++;
    }
    return n ? sum.map((v) => v / n) : null;
  };
  const inside = band(2, 8), on = band(-1, 1), outside = band(-8, -2);
  if (!inside || !on || !outside) return { visible: false, diff: 0 };
  const dist = (p, q) => Math.max(...[0, 1, 2].map((i) => Math.abs(p[i] - q[i])));
  const diff = Math.round(Math.max(dist(inside, outside), dist(on, outside)));
  return { visible: diff >= min, diff };
}

// A thin line across a text's own span (an underline, a strike-through, a rule under a label) is drawn on it on purpose.
const lineOn = (o, t) => (o.h <= Math.max(12, 0.3 * t.h) && o.x >= t.x - 0.1 * t.w && o.x + o.w <= t.x + t.w * 1.1 + 4) || (o.w <= Math.max(12, 0.3 * t.w) && o.y >= t.y - 0.1 * t.h && o.y + o.h <= t.y + t.h * 1.1 + 4);

// no-collisions. `img` (the decoded render, optional): a text that sticks out of a panel only counts when that panel's edge shows.
// Every item carries the boxes and by how much they overlap, so the fixer and the owner read "by 62 px left", not just "overlaps".
export function collisions(result, img = null) {
  const all = flatLayers(result);
  const texts = mergedTexts(all);
  const scale = img ? { x: img.w / result.width, y: img.h / result.height } : null;
  const bad = [];
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const [a, b] = sameFrame(texts[i], texts[j]);
    const o = inter(a, b);
    if (o > 0.04 * Math.min(a.w * a.h, b.w * b.h)) { const by = overlapOf(a, b); bad.push({ a: a.id, b: b.id, why: 'two texts overlap', a_box: box(a), b_box: box(b), by, words: `text ${a.id} (${box(a)}) and text ${b.id} (${box(b)}) overlap by ${by.w}×${by.h} px` }); }
  }
  for (const t0 of texts) {
    for (const o0 of all) {
      if (o0.type === 'text' || o0.op < 0.05 || o0.full || o0.w < 4 || o0.h < 4) continue;
      const [t, o] = sameFrame(t0, o0);
      const area = inter(o, t);
      if (area <= 0.04 * t.w * t.h) continue;
      if (o.order < t.order) {
        if (contains(o, t)) continue;
        const sides = outBy(o, t);
        // the edge test reads the picture, so it needs the panel's on-screen bounds: only for a panel that is not turned
        const shown = img && !turned(o0) ? Object.keys(sides).filter((sd) => edgeVisible(img, scale, o0, sd, texts).visible) : Object.keys(sides);
        if (!shown.length) continue;
        const by = Object.fromEntries(shown.map((sd) => [sd, sides[sd]]));
        bad.push({ a: t.id, b: o.id, why: 'a text sticks out of the panel or picture behind it', a_box: box(t), b_box: box(o), by, words: `text ${t.id} (${box(t)}) sticks out of ${o.type} ${o.id} (${box(o)}) by ${shown.map((sd) => `${by[sd]} px ${sd}`).join(', ')}` });
      } else if (o.order > t.last && !lineOn(o, t)) { const by = overlapOf(o, t); bad.push({ a: t.id, b: o.id, why: 'something painted over a text', a_box: box(t), b_box: box(o), by, words: `${o.type} ${o.id} (${box(o)}) is painted over text ${t.id} (${box(t)}), ${by.w}×${by.h} px` }); }
    }
  }
  return { pass: !bad.length, items: bad, note: bad.length ? `${bad.length} overlap${bad.length === 1 ? '' : 's'}: ${bad.slice(0, 4).map((b) => b.words).join('; ')}${bad.length > 4 ? `; and ${bad.length - 4} more` : ''}` : `no text overlaps another text, and none sticks out of or is covered by a shape or picture (${texts.length} texts, ${all.length} layers)` };
}

// ---- contrast from the rendered pixels ----
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lumOf = (d, o) => 0.2126 * lin(d[o]) + 0.7152 * lin(d[o + 1]) + 0.0722 * lin(d[o + 2]);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const hex = (d, o) => `#${[0, 1, 2].map((i) => d[o + i].toString(16).padStart(2, '0')).join('')}`;
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))];

export function readability(result, png) {
  const img = png.data ? png : decodePng(png);
  const { w: W, h: H, data } = img;
  const sx = W / result.width, sy = H / result.height; // a scaled render
  const items = [];
  for (const t of textBoxes(result)) {
    const x0 = Math.max(0, Math.floor(t.x * sx)), y0 = Math.max(0, Math.floor(t.y * sy)), x1 = Math.min(W, Math.ceil((t.x + t.w) * sx)), y1 = Math.min(H, Math.ceil((t.y + t.h) * sy));
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    // the ring is sampled sparsely; the inside at every pixel, so the thin strokes of a short word are never stepped over
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 5000)));
    const ring = [], inside = [];
    const pad = 8;
    for (let y = Math.max(0, y0 - pad); y < Math.min(H, y1 + pad); y++) for (let x = Math.max(0, x0 - pad); x < Math.min(W, x1 + pad); x++) {
      const o = (y * W + x) * 4;
      const inBox = x >= x0 && x < x1 && y >= y0 && y < y1;
      if (inBox) inside.push(o); else if ((x - x0) % step === 0 && (y - y0) % step === 0) ring.push(o);
    }
    // What is behind the glyphs is read INSIDE the box: its pixels that are not glyphs. A ring around the box reads whatever is
    // next to it (the page around a tilted tag, d4fd SF02: "#15161a on #131314"), so the ring is used only when the box has no
    // background pixels of its own. Glyphs: the inside pixels 1.5:1 or more from the inside's median (contrast is symmetric, so a
    // heavy word that covers most of its box swaps the two sides and measures the same).
    const px = inside.map((o) => ({ o, l: lumOf(data, o) }));
    const med = pct([...px].sort((a, b) => a.l - b.l), 0.5);
    const glyphs = px.filter((p) => ratio(p.l, med.l) >= 1.5).sort((a, b) => ratio(b.l, med.l) - ratio(a.l, med.l));
    const behind = px.filter((p) => ratio(p.l, med.l) < 1.5);
    let fg, bgSet;
    if (glyphs.length >= 4 && behind.length >= 8) {
      // the text colour: the glyph pixel at the 30th percentile from the far end (antialiasing and noise do not decide it).
      // A short word in a wide box covers far less than 10% of it: a percentile over the whole box read the background as the
      // text colour, "#ede6d6 on #ede6d6 = 1:1" (261102-mortiflix-v3-video-d4fd SF01, 2026-11-02).
      fg = pct(glyphs, 0.3);
      bgSet = behind.sort((a, b) => a.l - b.l);
    } else {
      // no glyph stands out from the box (the text is the colour of what is behind it, or not drawn): the whole box against the ring
      bgSet = (ring.length >= 8 ? ring : inside).map((o) => ({ o, l: lumOf(data, o) })).sort((a, b) => a.l - b.l);
      const bgMed = pct(bgSet, 0.5);
      fg = pct(px.sort((a, b) => ratio(b.l, bgMed.l) - ratio(a.l, bgMed.l)), 0.1);
    }
    // worst case over the background: its lightest or darkest pixel (5th / 95th percentile) closest to the text
    const lo = pct(bgSet, 0.05), hi = pct(bgSet, 0.95);
    const worst = Math.abs(lo.l - fg.l) < Math.abs(hi.l - fg.l) ? lo : hi;
    const lines = Math.max(1, t.text?.lines?.length || 1);
    const size = Math.round(t.h / lines / 1.2);
    const need = size >= 36 ? 3 : 4.5;
    const rt = r2(ratio(fg.l, worst.l));
    items.push({ id: t.id, text: t.text?.text || '', px: size, need, ratio: rt, fg: hex(data, fg.o), bg: hex(data, worst.o), ok: rt >= need });
  }
  const bad = items.filter((i) => !i.ok);
  return { pass: !bad.length, items, note: bad.length ? `${bad.length} of ${items.length} text boxes fail contrast: ${bad.slice(0, 4).map((i) => `${i.fg} on ${i.bg} = ${i.ratio}:1 (needs ${i.need})`).join('; ')}` : `${items.length} text boxes measured on the rendered pixels, lowest ${items.length ? Math.min(...items.map((i) => i.ratio)) : '-'}:1 (needs 4.5, or 3 from 36 px)` };
}

// ---- Kinetograph's "not drawn" warnings for a render (its stderr, or the render job's output tail) ----
export function renderWarnings(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let on = false;
  for (const l of lines) {
    if (/^warning:/.test(l)) { on = true; continue; }
    if (on && /^\s+\S/.test(l)) out.push(l.trim());
    else if (on) on = false;
  }
  return out;
}

// ---- words on the frame ----
// The text the frame's code puts on screen: JSX text and string literals. A guess, used only when `inspect` gives no text.
export function declaredTexts(code) {
  const out = new Set();
  for (const m of String(code).matchAll(/>\s*([^<>{}\n][^<>{}]*?)\s*</g)) if (m[1].trim().length > 1) out.add(m[1].trim());
  for (const m of String(code).matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.){2,})\1/g)) if (/[\p{L}\p{N}]/u.test(m[2]) && !/^[./#@\w:-]*(\.[a-z]{2,4}|\/)[\w./-]*$/i.test(m[2]) && !/^#[0-9a-f]{3,8}$/i.test(m[2]) && !/^[\w-]+:[\w-]+$/.test(m[2])) out.add(m[2]);
  return [...out];
}
export const keyWordsOnFrame = (keys, texts) => {
  // letters and digits only: the script's written form matches however the frame sets it ("Character.AI", "CHARACTER.AI")
  const squash = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const hay = squash(texts.join(' '));
  const missing = keys.filter((k) => k && !hay.includes(squash(k)));
  return { pass: !missing.length, missing };
};

// ---- everything, for one frame ----
// {inspect (the result), png (Buffer), pool, code (the frame's source files joined), work, warnings (render output text),
//  keys: [key words] (stills only), declared}: -> {ok, checks: {id: {pass, note, items}}, problems: [plain words], texts: {basis, list}}
export function measureFrame({ inspect, png = null, pool = { assets: [] }, code = '', work = null, warnings = '', keys = null }) {
  const checks = {};
  let img = null;
  try { img = png ? (png.data ? png : decodePng(png)) : null; } catch { img = null; }
  checks['text-safe-area'] = safeArea(inspect, img);
  checks['no-collisions'] = collisions(inspect, img);
  checks['text-contrast'] = img ? readability(inspect, img) : { pass: false, items: [], note: 'the rendered picture could not be read, so contrast was not measured' };
  const refs = checkAssetRefs(code, pool, { work });
  checks['no-missing-assets'] = { pass: refs.ok, items: [...refs.missing.map((id) => ({ id, why: 'not in the asset pool' })), ...refs.noFile.map((id) => ({ id, why: 'its file is missing' }))], note: refs.ok ? `${refs.used.length} asset id${refs.used.length === 1 ? '' : 's'} used, all in the pool with their files` : `missing: ${[...refs.missing, ...refs.noFile].join(', ')}` };
  const warn = renderWarnings(warnings);
  checks['no-layout-errors'] = { pass: !warn.length, items: warn.map((w) => ({ why: w })), note: warn.length ? `The renderer did not draw: ${warn.slice(0, 3).join(' | ')}` : 'The renderer drew everything (no "not drawn" warnings)' };
  const fromInspect = textBoxes(inspect).map((t) => t.text?.text).filter(Boolean);
  const texts = fromInspect.length ? { basis: 'inspect', list: fromInspect } : { basis: 'code', list: declaredTexts(code) };
  if (keys) {
    const k = keyWordsOnFrame(keys, texts.list);
    checks['key-words'] = { pass: k.pass, items: k.missing.map((m) => ({ word: m })), note: k.pass ? `every key word is on the picture (read from ${texts.basis === 'inspect' ? 'the frame\'s text layer' : 'the frame\'s code: this renderer build\'s inspect gives no text'})` : `key word${k.missing.length === 1 ? '' : 's'} not on the picture: ${k.missing.join(', ')}` };
  }
  const problems = Object.entries(checks).filter(([, c]) => !c.pass).map(([id, c]) => `${id}: ${c.note}`);
  return { ok: !problems.length, checks, problems, texts };
}

export const pass = (m) => m.ok;
