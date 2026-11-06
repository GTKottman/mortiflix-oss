// The asset pool (style frames v3, plan 90 §1.1). Built once when a project's packs are known or change:
//   video/src/public/pool/…   a copy of every drawable file of the picked packs (Kinetograph's staticFile() looks in the
//                             public folder BESIDE the entry file, so src/public: checked by a real render), no remote URLs
//   design/pool.json          one row per asset with a stable id: color:accent · font:heading · icon:arrow · tex:grain ·
//                             img:skyline · layout:hero-left · model:chair · doc:brand
//   video/src/pool.ts         asset(id) · tex(id, opts) · font(id) · color(id) · Icon · POOL, so Claude refers to assets by id
//                             ONLY, and "no missing assets" is a lookup (checkAssetRefs), not a guess
// The picked packs are the project's style pack and its asset packs, plus the small default texture pack that ships with
// Mortiflix (pooldefaults.mjs). A pack may hold ANY file: documents give text (and the pictures inside them), 3D models give a
// still (Blender, in the background), pictures/textures/icons/fonts are drawn as they are. Nothing here calls an AI.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { listAllPacks, FILE_KINDS } from './packs.mjs';
import { projectPacks } from './projectpacks.mjs';
import { projectPaths } from '../projects.mjs';
import { DEFAULT_TEXTURES, GRAIN_TILES, grainPng } from './pooldefaults.mjs';
import { imageSize, parseIcon, readDocument, pdfPictures, modelStill } from './poolfiles.mjs';

export const MAX_FILE = 60 * 1024 * 1024; // a pack file bigger than this is not copied into a project
export const POOL_LINES_MAX = 150;
const slug = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'x';
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const words = (s) => [...new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
const WEIGHTS = [['thin', 100], ['extralight', 200], ['ultralight', 200], ['light', 300], ['regular', 400], ['medium', 500], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800], ['black', 900], ['heavy', 900], ['bold', 700]];
const weightOf = (name) => { const n = name.toLowerCase().replace(/[^a-z]/g, ''); return (WEIGHTS.find(([w]) => n.includes(w)) || [null, 400])[1]; };
const familyOf = (name) => name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_ ]?(thin|extralight|ultralight|light|regular|medium|semibold|demibold|extrabold|ultrabold|black|heavy|bold|italic|oblique)\b/gi, '').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || name;

const validFont = (file) => { try { const m = readFileSync(file).subarray(0, 4).toString('latin1'); return ['\x00\x01\x00\x00', 'true', 'OTTO', 'wOFF', 'wOF2', 'ttcf'].includes(m); } catch { return false; } };

// ids that stay unique: icon:arrow, icon:arrow-2, …
function ids() {
  const seen = new Set();
  return (base) => { let id = base, n = 2; while (seen.has(id)) id = `${base}-${n++}`; seen.add(id); return id; };
}

// The packs a project's pool is made of: its style pack, its asset packs. [{kind, id, name, dir, pack}]
export function pickedPacks(root, id) {
  const picks = projectPacks(root, id);
  const all = listAllPacks(root);
  const out = [];
  const style = picks.style?.id;
  if (style) { const p = all.find((x) => x.kind === 'style' && x.id === style); if (p) out.push(p); }
  for (const a of picks.assets || []) { const p = all.find((x) => x.kind === 'assets' && x.id === a.id); if (p) out.push(p); }
  return out;
}

const copy = (src, dest) => { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest); };

// Builds the pool rows (and copies the files) for `packs` into `pub` (…/video/src/public/pool). Pure on disk: no project needed.
// opts: {modelStill, docRun, brief}: injectable for tests. Returns {assets, skipped}.
export function buildRows(packs, pub, { modelStill: still = modelStill, brief = null, docOpts = {} } = {}) {
  const uid = ids();
  const assets = [];
  const skipped = [];
  const add = (row) => { assets.push(row); return row; };

  // colours: the style pack's jobs and rules, else the plain palette, else the look brief's own colours
  const stylePack = packs.find((p) => p.kind === 'style');
  const pal = stylePack?.style?.palette?.length ? stylePack.style.palette : (stylePack?.palette || brief?.palette || []).map((hex, i) => ({ hex, job: `c${i + 1}`, rule: '' }));
  for (const c of pal) add({ id: uid(`color:${slug(c.job || 'colour')}`), kind: 'color', hex: c.hex, job: c.job || '', rule: c.rule || '', pack: stylePack?.id || null });

  // fonts: the heading and body faces, matched to a font file the pack ships; every font file is also its own row
  for (const p of packs) {
    const files = p.asset_files.filter((f) => f.kind === 'font');
    const fileRows = files.map((f) => {
      const name = basename(f.rel);
      const dest = `fonts/${p.id}-${name}`;
      if (f.size > MAX_FILE) { skipped.push({ pack: p.id, file: f.rel, why: 'too big to copy' }); return null; }
      // a broken font file stops the whole render ("contains no usable font"), so it never reaches pool.ts
      if (!validFont(join(p.dir, f.rel))) { skipped.push({ pack: p.id, file: f.rel, why: 'not a usable font file' }); return null; }
      copy(join(p.dir, f.rel), join(pub, dest));
      return { name, file: `pool/${dest}`, family: familyOf(name), weight: weightOf(name), italic: /italic|oblique/i.test(name) };
    }).filter(Boolean);
    for (const r of fileRows) add({ id: uid(`font:${slug(r.family)}-${r.weight}${r.italic ? '-italic' : ''}`), kind: 'font', family: r.family, weight: r.weight, italic: r.italic, file: r.file, pack: p.id, source: 'file' });
    if (p.kind === 'style' && p.style?.type) {
      for (const role of ['heading', 'body']) {
        const t = p.style.type[role];
        if (!t?.font) continue;
        const key = t.font.toLowerCase().replace(/[^a-z0-9]/g, '');
        const cand = fileRows.filter((r) => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(key));
        const best = cand.sort((a, b) => Math.abs(a.weight - (t.weight || 400)) - Math.abs(b.weight - (t.weight || 400)))[0];
        add(best
          ? { id: uid(`font:${role}`), kind: 'font', role, family: t.font, weight: best.weight, file: best.file, pack: p.id, source: 'file', shape: t.shape || '' }
          // no file shipped: the AI loads it with @remotion/google-fonts (as before); pool.ts font() just returns the family
          : { id: uid(`font:${role}`), kind: 'font', role, family: t.font, weight: t.weight || 400, file: null, pack: p.id, source: 'google-fonts', shape: t.shape || '' });
      }
    }
  }

  // every other file of every pack, by kind
  for (const p of packs) {
    const meta = { ...readMeta(p.dir, 'textures.json'), ...readMeta(p.dir, 'images.json') };
    for (const f of p.asset_files) {
      if (f.kind === 'font' || f.kind === 'other' || f.kind === 'audio' || f.kind === 'video') { if (f.kind !== 'font') skipped.push({ pack: p.id, file: f.rel, why: f.kind === 'other' ? 'unknown file type' : `${f.kind} is not drawn in a still` }); continue; }
      const src = join(p.dir, f.rel);
      const name = basename(f.rel);
      const m = meta[f.rel] || meta[name] || {};
      const tags = [...new Set([...words(slug(name)), ...words(m.use || '')])].slice(0, 12);
      if (f.size > MAX_FILE) { skipped.push({ pack: p.id, file: f.rel, why: 'too big to copy' }); continue; }
      try {
        if (f.kind === 'icon' && f.ext === '.svg') {
          const ic = parseIcon(readFileSync(src, 'utf8'));
          if (!ic.shapes.length) { skipped.push({ pack: p.id, file: f.rel, why: ic.hasText ? 'an icon made of text is not drawn: use paths' : 'no shapes in this svg' }); continue; }
          add({ id: uid(`icon:${slug(name)}`), kind: 'icon', tags, viewBox: ic.viewBox, shapes: ic.shapes, pack: p.id, ...(ic.filters ? { warn: 'has filters: the renderer does not draw them inside an svg' } : {}) });
        } else if (f.kind === 'icon' || f.kind === 'texture' || f.kind === 'picture') {
          const dest = `${f.kind === 'texture' ? 'textures' : f.kind === 'icon' ? 'icons' : 'images'}/${p.id}-${name}`;
          copy(src, join(pub, dest));
          const sz = imageSize(src);
          const base = f.kind === 'texture' ? 'tex' : f.kind === 'icon' ? 'icon' : 'img';
          add({ id: uid(`${base}:${slug(name)}`), kind: f.kind === 'picture' ? 'image' : f.kind, file: `pool/${dest}`, w: sz?.w || null, h: sz?.h || null, tags, use: m.use || '', pack: p.id,
            ...(f.kind === 'texture' ? { tile: m.tile !== false, opacity: Number(m.opacity) || 1 } : {}), ...(m.credit ? { credit: String(m.credit).slice(0, 120) } : {}) });
        } else if (f.kind === 'layout') {
          const j = readJson(src, null);
          const regions = Array.isArray(j?.regions) ? j.regions.slice(0, 40).filter((r) => r && typeof r === 'object').map((r) => ({ id: String(r.id || ''), role: String(r.role || ''), x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w) || 0, h: Number(r.h) || 0 })) : [];
          if (!regions.length) { skipped.push({ pack: p.id, file: f.rel, why: 'a layout needs regions [{id, role, x, y, w, h}]' }); continue; }
          add({ id: uid(`layout:${slug(j.name || name)}`), kind: 'layout', use: String(j.use || '').slice(0, 200), regions, tags, pack: p.id });
        } else if (f.kind === 'model') {
          const out = `models/${p.id}-${slug(name)}.png`;
          const r = still(src, join(pub, out));
          add({ id: uid(`model:${slug(name)}`), kind: 'model', file: r.ok ? `pool/${out}` : null, w: r.ok ? 1024 : null, h: r.ok ? 1024 : null, tags, pack: p.id, source: `pool/models/${basename(name)}`, ...(r.ok ? {} : { note: r.error }) });
          if (r.ok) copy(src, join(pub, 'models', `${p.id}-${basename(name)}`));
        } else if (f.kind === 'document') {
          const d = readDocument(src, docOpts);
          const row = add({ id: uid(`doc:${slug(name)}`), kind: 'document', text: d.text.slice(0, 2000), chars: d.text.length, tags, pack: p.id, images: [], ...(d.note ? { note: d.note } : {}) });
          const pics = d.pdf ? pdfPictures(src, join(pub, 'docs', `${p.id}-${slug(name)}`), docOpts).map((x) => ({ name: x.name, from: x.file })) : d.images.map((x) => ({ name: x.name, data: x.data }));
          pics.forEach((x, i) => {
            const dest = d.pdf ? x.from : join(pub, 'docs', `${p.id}-${slug(name)}`, x.name);
            if (!d.pdf) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, x.data); }
            const sz = imageSize(dest);
            const rel = `pool/docs/${p.id}-${slug(name)}/${basename(dest)}`;
            const im = add({ id: uid(`img:${slug(name)}-${i + 1}`), kind: 'image', file: rel, w: sz?.w || null, h: sz?.h || null, tags, use: `from ${name}`, pack: p.id });
            row.images.push(im.id);
          });
        }
      } catch (e) { skipped.push({ pack: p.id, file: f.rel, why: String(e.message).slice(0, 120) }); }
    }
  }

  // the default textures that ship with Mortiflix: CSS ones (no file) and two grain tiles made by code
  for (const t of DEFAULT_TEXTURES) {
    const row = { id: `tex:${t.id}`, kind: 'texture', default: true, name: t.name, use: t.use, tags: t.tags, params: t.params, scaled: t.scaled, layers: t.layers, tile: true, pack: 'default-textures' };
    if (t.tile) {
      const g = GRAIN_TILES[t.tile];
      mkdirSync(join(pub, 'textures'), { recursive: true });
      writeFileSync(join(pub, 'textures', g.file), grainPng(g.opts));
      row.file = `pool/textures/${g.file}`; row.w = g.opts.size; row.h = g.opts.size;
    }
    add(row);
  }
  return { assets, skipped };
}

function readMeta(dir, name) {
  const j = readJson(join(dir, name), null) || readJson(join(dir, name.replace('.json', ''), name), null);
  const list = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [];
  return Object.fromEntries(list.filter((x) => x && x.file).flatMap((x) => [[String(x.file), x], [basename(String(x.file)), x]]));
}

// ---- video/src/pool.ts: the runtime Claude's frame code imports ----
export const POOL_TS_RUNTIME = `
const byId = (id: string): Row => {
  const r = POOL.find((a) => a.id === id);
  if (!r) throw new Error('Unknown asset "' + id + '": it is not in design/pool.json. Use only ids from the pool list.');
  return r;
};
// Fonts: every font FILE in the pool is loaded here, once, so font(id) only returns the family name to use.
const loaded = new Set<string>();
for (const r of POOL) {
  if (r.kind === 'font' && r.file && !loaded.has(r.family + '|' + r.file)) {
    loaded.add(r.family + '|' + r.file);
    loadFont({ family: r.family, url: staticFile(r.file), weight: String(r.weight || 400), style: r.italic ? 'italic' : 'normal' });
  }
}
export const font = (id: string): string => byId(id).family as string;
export const color = (id: string): string => byId(id).hex as string;
// The picture file of an image, texture picture, model still or icon picture, as a URL for <Img src> / backgroundImage.
export const asset = (id: string): string => {
  const r = byId(id);
  if (!r.file) throw new Error('Asset "' + id + '" has no picture' + (r.note ? ': ' + r.note : ''));
  return staticFile(r.file);
};
// A texture as style props: <AbsoluteFill style={tex('halftone-dots', { color: '#ffffff22', scale: 1.5 })} />
export function tex(id: string, o: Record<string, any> = {}): React.CSSProperties {
  const r = byId(id.startsWith('tex:') ? id : 'tex:' + id);
  const op = o.opacity === undefined ? 1 : Number(o.opacity);
  if (r.file && !r.layers) {
    const px = Number(o.size || r.w || 256) * Number(o.scale || 1);
    return { backgroundImage: 'url(' + staticFile(r.file) + ')', backgroundSize: r.tile === false ? 'cover' : px + 'px ' + px + 'px', backgroundRepeat: r.tile === false ? 'no-repeat' : 'repeat', opacity: op };
  }
  const p: Record<string, any> = { ...(r.params || {}), ...o };
  for (const k of r.scaled || []) p[k] = Number(p[k]) * Number(o.scale || 1);
  p.r2 = Number(p.r) + 0.6; p.h = Number(p.s) / 2; p.hs = Number(p.s) / 2;
  const fill = (s: string) => String(s).replace(/\\{(\\w+)\\}/g, (_, k) => String(p[k]));
  if (r.file) {
    const px = Number(o.size || r.w || 256) * Number(o.scale || 1);
    return { backgroundImage: 'url(' + staticFile(r.file) + ')', backgroundSize: px + 'px ' + px + 'px', backgroundRepeat: 'repeat', opacity: op };
  }
  const L = (r.layers || []) as any[];
  const style: Record<string, any> = { backgroundImage: L.map((l) => fill(l.image)).join(', '), opacity: op };
  if (L.some((l) => l.size)) style.backgroundSize = L.map((l) => (l.size ? fill(l.size) : 'auto')).join(', ');
  if (L.some((l) => l.position)) style.backgroundPosition = L.map((l) => (l.position ? fill(l.position) : '0 0')).join(', ');
  return style as React.CSSProperties;
}
// An icon in any colour: <Icon id="icon:arrow" color={color('color:accent')} size={96} />
export const Icon: React.FC<{ id: string; color?: string; size?: number; style?: React.CSSProperties }> = ({ id, color: c = '#000', size = 64, style }) => {
  const r = byId(id.startsWith('icon:') ? id : 'icon:' + id);
  if (r.shapes) {
    return React.createElement('svg', { viewBox: r.viewBox as string, width: size, height: size, style },
      (r.shapes as any[]).map((s, i) => {
        const a: Record<string, any> = { ...s.attrs };
        if (a.fill !== 'none') a.fill = c;
        if (a.stroke && a.stroke !== 'none') a.stroke = c;
        return React.createElement(s.tag, { key: i, ...a });
      }));
  }
  return React.createElement(Img, { src: staticFile(r.file as string), style: { width: size, height: size, objectFit: 'contain', ...style } });
};
`;

export function poolTs(assets) {
  // the data is inlined: no JSON import, so nothing depends on how the bundler resolves it
  const slim = assets.map((a) => (a.kind === 'document' ? { id: a.id, kind: a.kind } : a));
  return `// Written by the studio (svc/pool.mjs) from the packs the project picked. Do not edit: it is rebuilt when the packs change.
// Refer to assets by ID ONLY: asset('img:skyline'), tex('halftone-dots'), font('font:heading'), color('color:accent'), <Icon id="icon:arrow" />.
import React from 'react';
import { staticFile, Img } from 'remotion';
import { loadFont } from '@remotion/fonts';

type Row = { id: string; kind: string; [k: string]: any };
export const POOL: Row[] = ${JSON.stringify(slim)};
${POOL_TS_RUNTIME}`;
}

// Everything that decides the pool: the packs' files (name, size, time) and the look brief's colours. Same hash = nothing to do.
function hashOf(packs, brief) {
  const h = createHash('sha1');
  for (const p of packs) { h.update(`${p.kind}/${p.id}/${p.version}`); for (const f of p.asset_files) { let t = 0; try { t = statSync(join(p.dir, f.rel)).mtimeMs; } catch { /* gone */ } h.update(`${f.rel}|${f.size}|${t}`); } h.update(JSON.stringify(p.style || p.palette || null)); }
  h.update(JSON.stringify(brief?.palette || []));
  h.update(`pool-v1|${DEFAULT_TEXTURES.length}`);
  return h.digest('hex').slice(0, 16);
}

// design/pool.json + video/src/public/pool + video/src/pool.ts for a project. `force` rebuilds even when nothing changed.
export function buildPool(root, id, { force = false, modelStill: ms = modelStill, docOpts = {} } = {}) {
  const pp = projectPaths(root, id);
  const work = pp.work;
  const packs = pickedPacks(root, id);
  const brief = readJson(join(work, 'design', 'look-brief.json'), null);
  const hash = hashOf(packs, brief);
  const jf = join(work, 'design', 'pool.json');
  const ts = join(work, 'video', 'src', 'pool.ts');
  const cur = readJson(jf, null);
  if (!force && cur?.hash === hash && existsSync(ts)) return { ...cur, rebuilt: false };
  const pub = join(work, 'video', 'src', 'public', 'pool');
  rmSync(pub, { recursive: true, force: true });
  mkdirSync(pub, { recursive: true });
  const { assets, skipped } = buildRows(packs, pub, { modelStill: ms, brief, docOpts });
  const doc = { built_at: new Date().toISOString(), hash, packs: packs.map((p) => ({ kind: p.kind, id: p.id, name: p.name, share: p.share })), assets, skipped };
  mkdirSync(join(work, 'design'), { recursive: true });
  writeFileSync(jf, JSON.stringify(doc, null, 1));
  mkdirSync(dirname(ts), { recursive: true });
  writeFileSync(ts, poolTs(assets));
  return { ...doc, rebuilt: true };
}

export const readPool = (root, id) => readJson(join(projectPaths(root, id).work, 'design', 'pool.json'), { assets: [], skipped: [], packs: [] });

// One short line per asset for the prompt (never the files). Over POOL_LINES_MAX rows: every colour, font and layout, then the
// others whose tags match the scene words (`sceneWords`), then the rest in order up to the cap.
export function poolLines(pool, { sceneWords = '', max = POOL_LINES_MAX } = {}) {
  const line = (a) => {
    if (a.kind === 'color') return `${a.id} · ${a.hex}${a.job ? ` · ${a.job}` : ''}${a.rule ? `: ${a.rule}` : ''}`;
    if (a.kind === 'font') return `${a.id} · ${a.family} ${a.weight}${a.role ? ` (${a.role})` : ''}${a.source === 'google-fonts' ? ' · no file: load with @remotion/google-fonts' : ''}`;
    if (a.kind === 'layout') return `${a.id} · ${a.use || ''} · regions ${a.regions.map((r) => r.id || r.role).join(', ')}`;
    if (a.kind === 'texture') return `${a.id} · texture${a.use ? ` · ${a.use}` : ''}${a.default ? ' · default pack' : ''}${a.params ? ` · options ${Object.keys(a.params).join(', ')}` : ''}`;
    if (a.kind === 'icon') return `${a.id} · icon${a.tags?.length ? ` · ${a.tags.join(', ')}` : ''}`;
    if (a.kind === 'image') return `${a.id} · picture${a.w ? ` ${a.w}x${a.h}` : ''}${a.use ? ` · ${a.use}` : ''}${a.tags?.length ? ` · ${a.tags.join(', ')}` : ''}`;
    if (a.kind === 'model') return `${a.id} · 3D model${a.file ? ' (a still of it: use asset())' : ' (no still: ' + (a.note || 'not drawn') + ')'}`;
    if (a.kind === 'document') return `${a.id} · document · ${a.chars} characters of text${a.images?.length ? `, pictures ${a.images.join(', ')}` : ''}${a.text ? ` · starts: ${a.text.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
    return `${a.id} · ${a.kind}`;
  };
  const rows = pool.assets || [];
  if (rows.length <= max) return rows.map(line);
  const must = rows.filter((a) => ['color', 'font', 'layout'].includes(a.kind));
  const want = new Set(words(sceneWords));
  const rest = rows.filter((a) => !must.includes(a));
  const scored = rest.map((a, i) => ({ a, i, s: (a.tags || []).filter((t) => want.has(t)).length })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.a);
  return [...must, ...scored].slice(0, max).map(line);
}

// The ids a code file uses, and which are not in the pool (or whose file is missing from the project's public folder).
export function checkAssetRefs(code, pool, { work = null } = {}) {
  const used = new Map();
  const note = (kind, v) => { const id = kind === 'tex' ? (v.startsWith('tex:') ? v : `tex:${v}`) : kind === 'icon' ? (v.startsWith('icon:') ? v : `icon:${v}`) : v; used.set(id, kind); };
  for (const m of String(code).matchAll(/\b(asset|tex|font|color)\(\s*['"`]([^'"`]+)['"`]/g)) note(m[1], m[2]);
  for (const m of String(code).matchAll(/<Icon\b[^>]*?\bid\s*=\s*(?:\{\s*)?['"`]([^'"`]+)['"`]/g)) note('icon', m[1]);
  const byId = new Map((pool.assets || []).map((a) => [a.id, a]));
  const missing = [], noFile = [];
  for (const id of used.keys()) {
    const a = byId.get(id);
    if (!a) { missing.push(id); continue; }
    if (a.file && work && !existsSync(join(work, 'video', 'src', 'public', a.file.replace(/^\//, '')))) noFile.push(id);
  }
  return { used: [...used.keys()], missing, noFile, ok: !missing.length && !noFile.length };
}
