// Your assets (doc 32): files the owner hands over at the start or any time later. Each is copied into the project
// (input/assets/<id>/, so moving the original breaks nothing), gets an id for life (a01…), a kind, how the AI should
// use it (must | fits | reference), where (beats) and a note in the owner's words. Replacing keeps the old version;
// removing hides it (nothing is deleted). project.json `assets` holds the list; the session sees it in its brief.
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { projectPaths, projectPipeline, loadProject, update, event, safeName, now } from '../projects.mjs';
import { UserError } from '../studio.mjs';

export const USES = ['must', 'fits', 'reference'];
export const MAX_ASSET_BYTES = 8 * 1024 * 1024 * 1024;
const KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.tif', '.tiff', '.bmp', '.psd'],
  video: ['.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi', '.mxf'],
  audio: ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac', '.aif', '.aiff'],
  font: ['.ttf', '.otf', '.woff', '.woff2'],
  document: ['.pdf', '.md', '.txt', '.docx', '.doc', '.rtf', '.odt', '.pptx', '.key'],
};
export const assetKind = (name) => Object.entries(KINDS).find(([, l]) => l.includes(extname(name).toLowerCase()))?.[0] || 'file';

const cleanWhere = (w) => (Array.isArray(w) ? w.filter((b) => /^b\d{2,3}$/.test(String(b))).slice(0, 50) : null);
const cleanUse = (u) => (USES.includes(u) ? u : 'fits');

function source(path) {
  if (typeof path !== 'string' || !path.trim()) throw new UserError('a file path is needed');
  if (!existsSync(path)) throw new UserError(`no file ${basename(path)}`);
  const real = realpathSync(path);
  const st = statSync(real);
  if (!st.isFile()) throw new UserError(`${basename(path)} isn't a file (add the files inside a folder one by one)`);
  if (st.size > MAX_ASSET_BYTES) throw new UserError(`${basename(path)} is over 8 GB`);
  return { real, size: st.size };
}

// Copy with progress (large footage copies in the background, doc 32): onProgress({done, total}) at most 4 times a second.
async function copyWithProgress(from, to, total, onProgress) {
  let done = 0;
  let shown = 0;
  const count = new Transform({ transform(chunk, _enc, cb) { done += chunk.length; if (Date.now() - shown > 250) { shown = Date.now(); onProgress({ done, total }); } cb(null, chunk); } });
  await streamPipeline(createReadStream(from), count, createWriteStream(to, { flags: 'wx' }));
  onProgress({ done: total, total });
}

const nextId = (list) => `a${String(list.reduce((n, a) => Math.max(n, Number(a.id.slice(1)) || 0), 0) + 1).padStart(2, '0')}`;

// The file question the pipeline already has (brand, logo): assets count as its answer, so a preset that requires a
// logo starts once one is attached.
function filesField(root, id) {
  const pipeline = projectPipeline(root, id);
  return (pipeline.intake.find((q) => q.type === 'files' && q.required) || pipeline.intake.find((q) => q.type === 'files'))?.id || null;
}

export async function addAsset(root, id, { path, use = 'fits', where = null, note = '', onProgress = () => {} }) {
  const { real, size } = source(path);
  const pp = projectPaths(root, id);
  const name = safeName(basename(real));
  // Reserve the id under the lock, copy outside it, then record.
  const aid = update(root, id, (p) => { p.assets ||= []; const a = nextId([...p.assets, ...(p.assets_reserved || [])]); (p.assets_reserved ||= []).push({ id: a }); return a; });
  const dir = join(pp.work, 'input', 'assets', aid);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  try {
    await copyWithProgress(real, file, size, (pr) => onProgress({ asset: aid, name, ...pr }));
  } finally {
    update(root, id, (p) => { p.assets_reserved = (p.assets_reserved || []).filter((x) => x.id !== aid); if (!p.assets_reserved.length) delete p.assets_reserved; });
  }
  const rel = relative(pp.work, file).split('\\').join('/');
  const field = filesField(root, id);
  const asset = update(root, id, (p) => {
    const a = { id: aid, name, kind: assetKind(name), size, use: cleanUse(use), where: cleanWhere(where), note: String(note || '').slice(0, 2000),
      file: rel, version: 1, versions: [{ v: 1, file: rel, size, at: now() }], used_in: [], from: 'you', at: now() };
    p.assets.push(a);
    if (field) p.intake.files.push({ field, name, path: rel, asset: aid });
    return a;
  });
  event(root, id, { event: 'ASSET_ADDED', actor: 'you', details: `${aid} ${name} (${asset.use})` });
  return view(root, id, asset);
}

export function updateAsset(root, id, aid, { use, where, note } = {}) {
  const a = update(root, id, (p) => {
    const a = (p.assets || []).find((x) => x.id === aid);
    if (!a) throw new UserError(`no asset ${aid}`);
    if (use !== undefined) a.use = cleanUse(use);
    if (where !== undefined) a.where = cleanWhere(where);
    if (note !== undefined) a.note = String(note || '').slice(0, 2000);
    return a;
  });
  event(root, id, { event: 'ASSET_CHANGED', actor: 'you', details: `${aid}: ${a.use}${a.note ? `, "${a.note.slice(0, 120)}"` : ''}` });
  return view(root, id, a);
}

export async function replaceAsset(root, id, aid, { path, onProgress = () => {} }) {
  const { real, size } = source(path);
  const pp = projectPaths(root, id);
  const cur = (loadProject(root, id).assets || []).find((x) => x.id === aid);
  if (!cur) throw new UserError(`no asset ${aid}`);
  const v = cur.version + 1;
  const name = safeName(basename(real));
  const dir = join(pp.work, 'input', 'assets', aid, `v${v}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  await copyWithProgress(real, file, size, (pr) => onProgress({ asset: aid, name, ...pr }));
  const rel = relative(pp.work, file).split('\\').join('/');
  const a = update(root, id, (p) => {
    const a = p.assets.find((x) => x.id === aid);
    a.versions.push({ v, file: rel, size, at: now() });
    Object.assign(a, { version: v, file: rel, name, size, kind: assetKind(name) });
    for (const f of p.intake.files) if (f.asset === aid) Object.assign(f, { name, path: rel });
    return a;
  });
  event(root, id, { event: 'ASSET_REPLACED', actor: 'you', details: `${aid} v${v}: ${name} (the old version is kept)` });
  return view(root, id, a);
}

export function removeAsset(root, id, aid) {
  const a = update(root, id, (p) => {
    const a = (p.assets || []).find((x) => x.id === aid);
    if (!a) throw new UserError(`no asset ${aid}`);
    a.removed = now();
    p.intake.files = p.intake.files.filter((f) => f.asset !== aid);
    return a;
  });
  event(root, id, { event: 'ASSET_REMOVED', actor: 'you', details: `${aid} ${a.name} (the file is kept)` });
  return view(root, id, a);
}

// What a song asset sounds like (src/music/listen.mjs): tempo, key and chords, heard once it's copied in.
export function setAssetHeard(root, id, aid, heard) {
  const a = update(root, id, (p) => {
    const a = (p.assets || []).find((x) => x.id === aid);
    if (!a) throw new UserError(`no asset ${aid}`);
    a.heard = { ...heard, version: a.version };
    return a;
  });
  return view(root, id, a);
}

// The heard song in one line: "90 BPM, A minor, chords E Am Am G G F G Am Am".
export const heardLine = (h) => (h?.bpm ? `${h.bpm} BPM, ${h.key}, chords ${h.progression}` : 'no steady beat heard');

// "Used in": a shot (or any piece) uses an asset, with a short how. `remove` takes it back.
export function useAsset(root, id, aid, node, { how = '', remove = false } = {}) {
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(String(node || ''))) throw new UserError('use needs a node id like s01');
  const a = update(root, id, (p) => {
    const a = (p.assets || []).find((x) => x.id === aid);
    if (!a) throw new UserError(`no asset ${aid}`);
    a.used_in = a.used_in.filter((u) => u.node !== node);
    if (!remove) a.used_in.push({ node, how: String(how || '').slice(0, 300), at: now() });
    return a;
  });
  return view(root, id, a);
}

function view(root, id, a) {
  const work = projectPaths(root, id).work;
  return { ...a, path: join(work, a.file), versions: a.versions.map((v) => ({ ...v, path: join(work, v.file) })) };
}

// Every asset: yours, and what Mortiflix found on your asset sites (assets/found/, harness skill "assets").
export function listAssets(root, id) {
  const project = loadProject(root, id);
  const work = projectPaths(root, id).work;
  const yours = (project.assets || []).filter((a) => !a.removed).map((a) => view(root, id, a));
  const foundDir = join(work, 'assets', 'found');
  const found = existsSync(foundDir) ? readdirSync(foundDir).filter((n) => !n.startsWith('.') && statSync(join(foundDir, n)).isFile()).map((n) => ({ id: `found:${n}`, name: n, kind: assetKind(n), from: 'mortiflix', path: join(foundDir, n), file: `assets/found/${n}` })) : [];
  const removed = (project.assets || []).filter((a) => a.removed).map((a) => ({ id: a.id, name: a.name, removed: a.removed }));
  return { yours, found, removed };
}

// For the session's brief (torch.mjs): each asset with its use, where and the owner's note (direction), the file
// itself is data.
export function assetsBrief(root, id) {
  const list = (loadProject(root, id).assets || []).filter((a) => !a.removed);
  if (!list.length) return '';
  const use = { must: 'Must use', fits: 'Use if it fits', reference: 'Just for reference' };
  return list.map((a) => `- **${a.id}** \`${a.file}\` (${a.kind}): ${use[a.use]}${a.where?.length ? `, in ${a.where.map((b) => b.toUpperCase()).join(', ')}` : ''}${a.note ? `. The owner: "${a.note.replace(/\s+/g, ' ').slice(0, 400)}"` : ''}${a.heard ? `. Heard: ${heardLine(a.heard).slice(0, 400)}` : ''}${a.used_in.length ? `. Used in: ${a.used_in.map((u) => u.node.toUpperCase()).join(', ')}` : ''}`).join('\n');
}
