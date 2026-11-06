// "Add pack…" (plan 90 §1.1): the owner hands over a folder or a .zip and the studio makes it a pack.
//   1. copies it to <studio>/packs/<kind>/<id>/ (a .zip is unpacked with src/zip.mjs; one top folder is flattened; nothing leaves the folder);
//   2. with no pack.json it writes one from what it finds: the font names read from the font files, and a SUGGESTED palette measured from
//      the poster by code (a PNG poster/preview or the first PNG picture); the owner confirms or edits it before first use (packs.confirm);
//   3. the card counts what it brings ("2 fonts · 14 icons · 3 textures"), from svc/packs.mjs;
//   4. the licence defaults to "own projects only, never share": share:false, so the pack never leaves this PC and is never offered to
//      mortiflix.com.
// Packs hold ANY file (textures, pictures, 3D models, PDF, DOCX...): nothing is refused by type.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { join, basename, extname, resolve, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { unzip } from '../zip.mjs';
import { UserError } from '../studio.mjs';
import { listAllPacks, KINDS, packsRoot, PACK_FORMAT } from './packs.mjs';
import { decodePng } from './png.mjs';

const MAX_TOTAL = 1.5 * 1024 ** 3;
const slug = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'pack';
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
export const DEFAULT_LICENSE = 'Own projects only, never share';

// ---- fonts: the family name inside a TTF/OTF (the name table), else the file name ----
export function fontFamilyOf(file) {
  try {
    const b = readFileSync(file);
    const tag = b.toString('latin1', 0, 4);
    if (!['\x00\x01\x00\x00', 'true', 'OTTO'].includes(tag)) throw new Error('not sfnt');
    const n = b.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      if (b.toString('latin1', o, o + 4) !== 'name') continue;
      const off = b.readUInt32BE(o + 8);
      const count = b.readUInt16BE(off + 2), str = off + b.readUInt16BE(off + 4);
      const names = {};
      for (let k = 0; k < count; k++) {
        const r = off + 6 + k * 12;
        const [plat, , , id, len, so] = [b.readUInt16BE(r), b.readUInt16BE(r + 2), b.readUInt16BE(r + 4), b.readUInt16BE(r + 6), b.readUInt16BE(r + 8), b.readUInt16BE(r + 10)];
        if (id !== 1 && id !== 16) continue;
        const raw = b.subarray(str + so, str + so + len);
        const text = plat === 3 || plat === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
        if (text.trim() && (!names[id] || plat === 3)) names[id] = text.trim();
      }
      if (names[16] || names[1]) return names[16] || names[1];
    }
  } catch { /* fall back to the file name */ }
  return basename(file).replace(/\.[a-z0-9]+$/i, '').replace(/[-_ ]?(thin|extralight|light|regular|medium|semibold|extrabold|black|bold|italic|oblique)\b/gi, '').replace(/[-_]+/g, ' ').trim() || basename(file);
}

// ---- a suggested palette measured from a picture (PNG only: the studio has no other decoder) ----
const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function suggestPalette(pngBuf, { colours = 6 } = {}) {
  const { w, h, data } = decodePng(pngBuf);
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40_000)));
  const bins = new Map();
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const o = (y * w + x) * 4;
    if (data[o + 3] < 200) continue;
    const k = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
    const e = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += data[o]; e.g += data[o + 1]; e.b += data[o + 2];
    bins.set(k, e);
  }
  const ranked = [...bins.values()].sort((a, b) => b.n - a.n).map((e) => ({ n: e.n, c: [e.r / e.n, e.g / e.n, e.b / e.n] }));
  const out = [];
  for (const e of ranked) { if (out.every((o) => dist(o.c, e.c) > 48)) out.push(e); if (out.length >= colours) break; }
  return out.map((e) => hex(...e.c));
}
function posterOf(dir) {
  const names = readdirSync(dir).sort();
  const pick = names.find((n) => /^poster\.png$/i.test(n)) || names.find((n) => /^preview.*\.png$/i.test(n)) || names.find((n) => /\.png$/i.test(n));
  return pick ? join(dir, pick) : null;
}

// ---- unpack / copy ----
function unpackZip(file, into) {
  const entries = unzip(readFileSync(file), { maxBytes: MAX_TOTAL });
  const root = resolve(into);
  for (const e of entries) {
    const dest = resolve(join(into, normalize(e.name)));
    if (!(dest === root || dest.startsWith(root + sep)) || /(^|[\\/])\.\.([\\/]|$)/.test(e.name)) throw new UserError(`the zip has a path that leaves its folder (${e.name.slice(0, 60)})`);
    if (/__MACOSX|\.DS_Store/.test(e.name)) continue;
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, e.data);
  }
  const top = readdirSync(into).filter((n) => !n.startsWith('.'));
  return top.length === 1 && statSync(join(into, top[0])).isDirectory() ? join(into, top[0]) : into;
}
function dirSize(d, limit) { let t = 0; const walk = (p) => { for (const e of readdirSync(p, { withFileTypes: true })) { if (t > limit) return; const f = join(p, e.name); if (e.isDirectory()) walk(f); else { try { t += statSync(f).size; } catch { /* gone */ } } } }; walk(d); return t; }

/**
 * packs.add {path, kind?, name?}: copies a folder or .zip into the studio's packs. kind: a pack.json's own, else `kind`, else "assets".
 * Returns the pack as the card shows it, plus `suggested_palette` and `needs_confirm` when the studio wrote the pack.json itself.
 */
export function addPack(root, { path: src, kind = null, name = null } = {}) {
  const from = String(src || '').replace(/^~(?=$|\/)/, process.env.HOME || '~');
  if (!from || !existsSync(from)) throw new UserError(`No file or folder at ${from || '(no path)'}.`);
  const tmp = mkdtempSync(join(tmpdir(), 'mfx-addpack-'));
  try {
    let dir = from;
    if (statSync(from).isFile()) {
      if (!/\.zip$/i.test(from)) throw new UserError('Add a folder or a .zip file.');
      dir = unpackZip(from, join(tmp, 'z'));
    }
    if (dirSize(dir, MAX_TOTAL) > MAX_TOTAL) throw new UserError('This pack is bigger than 1.5 GB: take the biggest files out.');
    const own = readJson(join(dir, 'pack.json'), null);
    const k = String(own?.kind || kind || 'assets').toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(k)) throw new UserError(`"${k}" is not a pack kind.`);
    if (k !== 'style' && k !== 'assets' && !KINDS[k]) throw new UserError(`The studio does not know the pack kind "${k}" (style and assets take any files).`);
    const title = String(name || own?.name || basename(from).replace(/\.zip$/i, '')).trim().slice(0, 80) || 'New pack';
    let id = slug(own?.id || title);
    const have = new Set(listAllPacks(root, k).map((p) => p.id));
    for (let n = 2; have.has(id); n++) id = `${slug(own?.id || title)}-${n}`;
    const dest = join(packsRoot(root), k, id);
    mkdirSync(dest, { recursive: true });
    cpSync(dir, dest, { recursive: true, filter: (s) => !/(^|[\\/])(\.|__MACOSX)/.test(basename(s)) || s === dir });
    let suggested = null, needs = false;
    if (!own) {
      const fonts = [...new Set(readdirSync(dest, { recursive: true }).filter((f) => /\.(ttf|otf)$/i.test(f)).slice(0, 40).map((f) => fontFamilyOf(join(dest, String(f)))))].slice(0, 6);
      const poster = posterOf(dest);
      let note = null;
      if (k === 'style') {
        if (poster) { try { suggested = suggestPalette(readFileSync(poster)); } catch (e) { note = `no palette suggested: ${String(e.message).slice(0, 80)}`; } } else note = 'no PNG poster to suggest a palette from';
        needs = true;
      }
      writeFileSync(join(dest, 'pack.json'), JSON.stringify({ format: PACK_FORMAT, spec: 2, id, kind: k, name: title, version: '1.0.0', description: '', author: '', license: DEFAULT_LICENSE, share: false, source: `added from ${basename(from)}`, tags: [], fonts, ...(k === 'style' ? { palette: [], suggested_palette: suggested || [], confirmed: false, ...(note ? { suggest_note: note } : {}) } : {}) }, null, 2));
    } else {
      // the pack brought its own pack.json: kept, but a missing licence defaults to the private one
      const fix = { ...own, id: own.id || id, spec: Number(own.spec) || 2 };
      if (!own.license) { fix.license = DEFAULT_LICENSE; fix.share = false; }
      if (own.share === undefined) fix.share = false;
      writeFileSync(join(dest, 'pack.json'), JSON.stringify(fix, null, 2));
    }
    const card = listAllPacks(root, k).find((p) => p.id === id);
    const { asset_files, ...rest } = card;
    return { ...rest, suggested_palette: suggested, needs_confirm: needs };
  } catch (e) {
    throw e;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * packs.confirm {kind: "style", id, palette: [hex | {hex, job, rule}], name?}: the owner's palette for a pack the studio made. A plain
 * hex gets the job "c1", "c2"...; jobs and rules are the owner's to add. Marks the pack confirmed.
 */
export function confirmPack(root, { kind = 'style', id, palette, name } = {}) {
  const pack = listAllPacks(root, kind).find((p) => p.id === id);
  if (!pack) throw new UserError(`no ${kind} pack "${id}"`);
  const f = join(pack.dir, 'pack.json');
  const d = readJson(f, {});
  const rows = (Array.isArray(palette) ? palette : d.suggested_palette || []).slice(0, 12).map((c, i) => (typeof c === 'string' ? { hex: c, job: `c${i + 1}`, rule: '' } : { hex: String(c?.hex || ''), job: String(c?.job || `c${i + 1}`).slice(0, 40), rule: String(c?.rule || '').slice(0, 300) })).filter((c) => /^#[0-9a-f]{6}$/i.test(c.hex));
  if (!rows.length) throw new UserError('Pick at least one colour (as #rrggbb).');
  const next = { ...d, ...(name ? { name: String(name).slice(0, 80) } : {}), palette: rows.map((c) => c.hex), style: { ...(d.style || {}), palette: rows }, confirmed: true };
  writeFileSync(f, JSON.stringify(next, null, 2));
  const card = listAllPacks(root, kind).find((p) => p.id === id);
  const { asset_files, ...rest } = card;
  return rest;
}
