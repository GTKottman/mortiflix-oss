// Readers for the files a pack can hold, for the asset pool (svc/pool.mjs): picture sizes, SVG icons, documents (text and the
// pictures inside them) and 3D models (one still). Owner, 2026-11-01: packs hold "textures, pictures, 3D models, even PDFs or
// Word documents ... whatever they want to put in there". Everything here is local and free: no AI, no network.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzip } from '../zip.mjs';

// ---- picture sizes (png, jpeg, gif, webp, svg) ----
export function imageSize(file) {
  try {
    const ext = extname(file).toLowerCase();
    if (ext === '.svg') {
      const s = readFileSync(file, 'utf8').slice(0, 4000);
      const vb = s.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if (vb) return { w: Math.round(Number(vb[1])), h: Math.round(Number(vb[2])) };
      const w = s.match(/\bwidth\s*=\s*["']([\d.]+)/i), h = s.match(/\bheight\s*=\s*["']([\d.]+)/i);
      return w && h ? { w: Math.round(Number(w[1])), h: Math.round(Number(h[1])) } : null;
    }
    const b = readFileSync(file).subarray(0, 64 * 1024);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const t = b.toString('ascii', 12, 16);
      if (t === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (t === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) { p++; continue; }
        const m = b[p + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
        p += 2 + b.readUInt16BE(p + 2);
      }
    }
  } catch { /* unreadable: no size */ }
  return null;
}

// ---- SVG icons: the drawable shapes, kept as data so Icon can draw them in any colour (no text, no filters) ----
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const ATTRS = new Set(['d', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'opacity', 'transform']);
const camel = (a) => a.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
export function parseIcon(svg) {
  const open = svg.match(/<svg\b[^>]*>/i)?.[0] || '';
  const vb = open.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  let box = vb ? vb.trim().split(/[\s,]+/).map(Number) : null;
  if (!box || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    const w = Number(open.match(/\bwidth\s*=\s*["']([\d.]+)/i)?.[1]), h = Number(open.match(/\bheight\s*=\s*["']([\d.]+)/i)?.[1]);
    box = w && h ? [0, 0, w, h] : [0, 0, 24, 24];
  }
  const shapes = [];
  for (const m of svg.matchAll(/<([a-z]+)\b([^>]*?)\/?>/gi)) {
    const tag = m[1].toLowerCase();
    if (!SHAPES.has(tag)) continue;
    const attrs = {};
    for (const a of m[2].matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) { const k = a[1].toLowerCase(); if (ATTRS.has(k)) attrs[camel(k)] = a[2] ?? a[3]; }
    shapes.push({ tag, attrs });
    if (shapes.length >= 200) break;
  }
  return { viewBox: box.join(' '), shapes, hasText: /<text\b/i.test(svg), filters: /<filter\b|filter\s*=/.test(svg) };
}

// ---- documents ----
const TEXT_EXT = new Set(['.txt', '.md', '.csv']);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlText = (xml, breaks) => decode(xml.replace(new RegExp(`</(?:${breaks})>`, 'g'), '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const MEDIA = /^(?:word\/media|Pictures|ppt\/media)\/[^/]+\.(png|jpe?g|gif|webp|svg)$/i;

// {text, images: [{name, data}], note?} for a document file. Never throws: an unreadable file says why in `note`.
export function readDocument(file, { run = spawnSync, maxText = 20_000, maxImages = 12, minImage = 4000 } = {}) {
  const ext = extname(file).toLowerCase();
  try {
    if (TEXT_EXT.has(ext)) return { text: readFileSync(file, 'utf8').slice(0, maxText), images: [] };
    if (ext === '.html' || ext === '.htm') return { text: decode(readFileSync(file, 'utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, maxText), images: [] };
    if (ext === '.rtf') return { text: readFileSync(file, 'latin1').replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}/g, '').replace(/\\'[0-9a-f]{2}/gi, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').replace(/\n\s*\n+/g, '\n').trim().slice(0, maxText), images: [] };
    if (['.docx', '.odt', '.pptx'].includes(ext)) {
      const entries = unzip(readFileSync(file), { maxBytes: 120 * 1024 * 1024 });
      let text = '';
      if (ext === '.docx') text = xmlText(entries.find((e) => e.name === 'word/document.xml')?.data.toString('utf8') || '', 'w:p');
      else if (ext === '.odt') text = xmlText(entries.find((e) => e.name === 'content.xml')?.data.toString('utf8') || '', 'text:p|text:h');
      else text = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((e) => xmlText(e.data.toString('utf8'), 'a:p')).join('\n\n');
      const images = entries.filter((e) => MEDIA.test(e.name) && e.data.length >= minImage).slice(0, maxImages).map((e) => ({ name: basename(e.name), data: e.data }));
      return { text: text.slice(0, maxText), images };
    }
    if (ext === '.pdf') {
      const t = run('pdftotext', ['-layout', '-l', '30', file, '-'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
      if (t.error || t.status !== 0) return { text: '', images: [], note: 'text not read (install poppler-utils for pdftotext)' };
      return { text: String(t.stdout).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxText), images: [], pdf: true };
    }
    return { text: '', images: [], note: `no reader for ${ext || 'this file'}` };
  } catch (e) { return { text: '', images: [], note: `could not read: ${String(e.message).slice(0, 120)}` }; }
}

// The pictures inside a PDF (first pages), written to `dir`: [{name, file}] (poppler's pdfimages; none without it).
export function pdfPictures(file, dir, { run = spawnSync, maxImages = 8, minImage = 8000 } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    const r = run('pdfimages', ['-png', '-l', '12', file, join(dir, 'p')], { timeout: 90_000 });
    if (r.error || r.status !== 0) return [];
    return readdirSync(dir).filter((f) => /^p-\d+\.png$/.test(f)).map((f) => ({ name: f, file: join(dir, f) })).filter((x) => statSync(x.file).size >= minImage).slice(0, maxImages);
  } catch { return []; }
}

// ---- 3D models: one still each, drawn by Blender in the background (the studio's own `blender`, never the owner's window) ----
export const MODEL_STILL_PY = `import bpy, sys, math
from mathutils import Vector
src, out = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
ext = src.lower().rsplit('.', 1)[-1]
if ext in ('glb', 'gltf'): bpy.ops.import_scene.gltf(filepath=src)
elif ext == 'obj': bpy.ops.wm.obj_import(filepath=src)
elif ext == 'fbx': bpy.ops.import_scene.fbx(filepath=src)
elif ext == 'stl': bpy.ops.wm.stl_import(filepath=src)
elif ext == 'ply': bpy.ops.wm.ply_import(filepath=src)
elif ext == 'blend': bpy.ops.wm.open_mainfile(filepath=src)
else: raise SystemExit('no importer for ' + ext)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes: raise SystemExit('no mesh in the model')
pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
mid = (lo + hi) / 2
size = max((hi - lo).length, 0.001)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
bpy.context.scene.collection.objects.link(cam)
cam.location = mid + Vector((size * 0.9, -size * 1.1, size * 0.7))
cam.rotation_euler = (mid - cam.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3
sun.rotation_euler = (math.radians(50), 0, math.radians(35))
bpy.context.scene.collection.objects.link(sun)
w = bpy.data.worlds.new('w'); w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
bpy.context.scene.world = w
sc = bpy.context.scene
sc.render.resolution_x = 1024; sc.render.resolution_y = 1024
sc.render.film_transparent = True
sc.render.filepath = out
for e in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
    try: sc.render.engine = e; break
    except TypeError: pass
bpy.ops.render.render(write_still=True)
`;

// modelStill(file, outPng, {run, blender}) -> {ok, error?}. `run` (tests) replaces the Blender process.
export function modelStill(file, out, { run = spawnSync, blender = process.env.MFX_BLENDER || 'blender', scriptDir } = {}) {
  try {
    mkdirSync(join(out, '..'), { recursive: true });
    const py = join(scriptDir || join(out, '..'), '.model-still.py');
    writeFileSync(py, MODEL_STILL_PY);
    const r = run(blender, ['-b', '--factory-startup', '-P', py, '--', file, out], { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    if (r.error) return { ok: false, error: r.error.code === 'ENOENT' ? 'Blender is not installed: this 3D model has no still' : String(r.error.message).slice(0, 160) };
    if (r.status !== 0 || !existsSync(out)) return { ok: false, error: `Blender could not draw it: ${String(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 160) }; }
}
