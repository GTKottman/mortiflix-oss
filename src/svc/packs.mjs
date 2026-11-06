// Packs (owner, 2026-10-18): ready-made direction the owner picks per video, kept in the studio and, later, shared on
// mortiflix.com ("there are going to be many different packs. transitions packs, motion packs, ect."). Each pack is a
// folder: <studio>/packs/<kind>/<id>/ with a pack.json and anything it brings (pictures, fonts, RULES.md, MOTION.md…).
//
// pack.json, every kind:
//   { "format": "mortiflix.pack", "version": 1, "kind": "style", "name": "Noir receipts", "description": "…",
//     "author": "…", "license": "…", "source": "local" | "mortiflix.com" | "<where it came from>", "tags": [] }
// plus the kind's own fields (KINDS below). Any other folder under packs/ is a kind too, read with the common fields,
// so a new kind from mortiflix.com shows up before the app knows what to do with it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

export const PACK_FORMAT = 'mortiflix.pack';
const PICTURE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);
const HEX = /^#[0-9a-f]{6}$/i;
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const strs = (v, n, each) => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, n) : []);
const textFile = (dir, name, n = 20_000) => { try { const f = join(dir, name); return statSync(f).size <= 1024 * 1024 ? readFileSync(f, 'utf8').slice(0, n) : ''; } catch { return ''; } };

// The pack's `style` object (spec 1 packs): each palette colour with its job and rule, the
// heading and body type, the shapes, the mood and the words. The AI must see all of it (the jobs and rules are the point).
// Returns null for a pack with none.
const plain = (o, nKeys, nEach) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).slice(0, nKeys).map(([k, v]) => [str(k, 40), str(v, nEach)]).filter(([, v]) => v)) : {});
export function readStyle(s) {
  if (!s || typeof s !== 'object') return null;
  const face = (t) => (t && typeof t === 'object' ? { font: str(t.font, 60), weight: Number(t.weight) || null, case: str(t.case, 20), shape: str(t.shape, 300) } : null);
  const palette = (Array.isArray(s.palette) ? s.palette : []).slice(0, 16).map((c) => ({ hex: str(c?.hex, 7), job: str(c?.job, 40), rule: str(c?.rule, 300) })).filter((c) => HEX.test(c.hex));
  const out = { palette, type: { heading: face(s.type?.heading), body: face(s.type?.body) }, shapes: plain(s.shapes, 12, 300), mood: str(s.mood, 300), words: str(s.words, 3000) };
  return palette.length || out.type.heading || out.type.body || Object.keys(out.shapes).length || out.mood || out.words ? out : null;
}

// The style object as the lines a prompt carries: every colour with its job and rule, the type, the shapes, the mood.
export function styleText(st) {
  if (!st) return '';
  const face = (n, t) => (t ? `- ${n}: ${[t.font, t.weight, t.case && `${t.case} case`, t.shape].filter(Boolean).join(', ')}` : '');
  return [
    st.palette?.length ? `Colours (each has a job and a rule: keep to it):\n${st.palette.map((c) => `- ${c.hex} · ${c.job || 'colour'}${c.rule ? `: ${c.rule}` : ''}`).join('\n')}` : '',
    st.type?.heading || st.type?.body ? `Type:\n${[face('heading', st.type.heading), face('body', st.type.body)].filter(Boolean).join('\n')}` : '',
    st.shapes && Object.keys(st.shapes).length ? `Shapes:\n${Object.entries(st.shapes).map(([k, v]) => `- ${k}: ${v}`).join('\n')}` : '',
    st.mood ? `Mood: ${st.mood}` : '',
    st.words ? `In words: ${st.words}` : '',
  ].filter(Boolean).join('\n');
}

// The kinds the studio knows: where they're used and their own fields.
export const KINDS = {
  style: { used: 'Style frames: the look (fonts, colours with their jobs and rules, type, shapes, mood, words)',
    read: (d, dir) => ({ fonts: strs(d.fonts, 6, 60), palette: strs(d.palette, 8, 7).filter((c) => HEX.test(c)), vibe: str(d.vibe, 200), look: str(d.look, 200), words: str(d.words, 2000) || textFile(dir, 'STYLE.md', 4000),
      style: readStyle(d.style) }) },
  transition: { used: 'Transitions: the cuts the board picks from',
    read: (d, dir) => ({ transitions: (Array.isArray(d.transitions) ? d.transitions : []).slice(0, 200).map((t) => ({ name: str(t?.name, 80), sec: Number(t?.sec) || null, words: str(t?.words, 600) })).filter((t) => t.name), words: str(d.words, 2000) || textFile(dir, 'TRANSITIONS.md', 8000) }) },
  motion: { used: 'Animatic: how things move (moves, easing, pace)',
    read: (d, dir) => ({ moves: strs(d.moves, 60, 200), easing: str(d.easing, 200), pace: str(d.pace, 200), words: str(d.words, 4000) || textFile(dir, 'MOTION.md', 12_000) }) },
  rule: { used: 'Every step from the one it is picked on: rules the AI follows',
    read: (d, dir) => ({ rules: strs(d.rules, 200, 600), words: str(d.words, 4000) || textFile(dir, 'RULES.md', 12_000) }) },
  // Scoring packs (owner, 2026-10-23: "a scoring pack in Mortiflix that would tell the music step exactly how to score
  // the music"; it replaces the empty `music` kind). Each field locks a choice, limits it to a list the plan call picks
  // from, or (left out) leaves it to the AI. The music step reads them in src/quickmusic.mjs and src/music/compose.mjs.
  scoring: { used: 'Music: how the music step scores the picture (tempo, keys, chords, instruments, how each part plays)',
    read: (d, dir) => ({
      concept: str(d.concept, 600),
      tempo: { bpm_min: Number(d.tempo?.bpm_min) || null, bpm_max: Number(d.tempo?.bpm_max) || null },
      meters: strs(d.meters, 2, 8),
      modes: strs(d.modes, 8, 20),
      sevenths: d.sevenths === true,
      parts: strs(d.parts, 6, 20),
      hits: strs(d.hits, 4, 20),
      key_words: strs(d.key_words, 4, 20),
      play: d.play && typeof d.play === 'object' ? Object.fromEntries(Object.entries(d.play).map(([k, v]) => [str(k, 20), str(v, 40)])) : {},
      swing: Number(d.swing) > 0.5 && Number(d.swing) <= 0.75 ? Number(d.swing) : null,
      // an instrument pack's id (packs/instrument/<id>/), or the instruments written in the scoring pack itself
      instruments: typeof d.instruments === 'string' ? str(d.instruments, 120) : d.instruments && typeof d.instruments === 'object' ? d.instruments : null,
      kit: d.kit && typeof d.kit === 'object' ? d.kit : null,
      samples: strs(d.samples, 30, 60),
      how: str(d.how, 4000),
      words: str(d.words, 4000) || textFile(dir, 'SCORING.md', 12_000),
      // the researched genre (src/music/genre.mjs), cached here once so no video researches it again
      profile: (() => { try { return JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')); } catch { return null; } })(),
    }) },
  // Instrument packs (owner, 2026-10-23: "We'll make an instrument pack"): the sound of each part, which a scoring pack
  // plays with. parts: { bass|pad|melody|arp|bells: { source, sound, set, gain, character, why, patch? },
  // drums: { why, kit: { "<GM number>": { source, sound, set, gain } } } }. source: "vcsl" | "vsco2" (CC0 sample
  // libraries, fetched into the studio when used), "synth" (Strudel's own), "surge" (a Surge XT patch, played by the
  // engine; `sound` is its stand-in in Strudel).
  instrument: { used: 'Music: the sound of each part (a scoring pack names one)',
    read: (d, dir) => ({ concept: str(d.concept, 600), parts: d.parts && typeof d.parts === 'object' ? d.parts : {}, words: str(d.words, 4000) || textFile(dir, 'INSTRUMENTS.md', 8000) }) },
  // Asset packs (owner, 2026-11-01): anything a look can use, from any source: textures, pictures, icons, fonts, layouts,
  // 3D models, PDFs, Word files. No style object. A project picks several (like rule packs); the pool reads their files.
  assets: { used: 'Style frames and stills: files the AI may use (textures, pictures, icons, fonts, layouts, 3D models, documents)',
    read: (d, dir) => ({ words: str(d.words, 4000) || textFile(dir, 'ASSETS.md', 8000) }) },
  voice: { used: 'Voice: how the narration sounds', read: (d) => ({ words: str(d.words, 4000) }) },
};

// ---- what a pack brings (spec 2): ANY file (owner, 2026-11-01: "whatever they want to put in there should be able to") ----
// The pool (svc/pool.mjs) reads every file by its kind: fonts, textures, icons, pictures, 3D models, documents (PDF,
// Word, text), layouts. A file's kind comes from its folder first (textures/, icons/, ...) and its extension second.
export const FILE_KINDS = {
  font: ['.ttf', '.otf', '.woff', '.woff2'],
  picture: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp'],
  model: ['.glb', '.gltf', '.obj', '.fbx', '.stl', '.blend', '.dae', '.ply', '.usd', '.usdz'],
  document: ['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.html', '.htm', '.pptx', '.csv'],
  audio: ['.wav', '.mp3', '.flac', '.ogg', '.m4a'],
  video: ['.mp4', '.mov', '.webm', '.mkv'],
};
const FOLDER_KIND = { fonts: 'font', textures: 'texture', icons: 'icon', images: 'picture', pictures: 'picture', models: 'model', docs: 'document', documents: 'document', layouts: 'layout' };
const SKIP_NAMES = new Set(['pack.json', 'textures.json', 'images.json', '.DS_Store', 'Thumbs.db']);
export function fileKind(rel) {
  const parts = rel.split('/');
  const ext = extname(rel).toLowerCase();
  const byExt = Object.entries(FILE_KINDS).find(([, l]) => l.includes(ext))?.[0] || (ext === '.json' && FOLDER_KIND[parts[0]] === 'layout' ? 'layout' : 'other');
  const hint = parts.length > 1 ? FOLDER_KIND[parts[0].toLowerCase()] : null;
  if (hint === 'texture' || hint === 'icon') return byExt === 'picture' ? hint : byExt;
  if (hint === 'layout' && ext === '.json') return 'layout';
  return byExt;
}
// Every file in the pack (three folders deep, at most 800), with its kind: [{rel, kind, ext, size}].
export function packFiles(dir, { max = 800, depth = 3 } = {}) {
  const out = [];
  const walk = (d, rel, level) => {
    let list = [];
    try { list = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of list) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') || SKIP_NAMES.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (level < depth) walk(join(d, e.name), r, level + 1); continue; }
      if (!e.isFile()) continue;
      let size = 0;
      try { size = statSync(join(d, e.name)).size; } catch { continue; }
      out.push({ rel: r, kind: fileKind(r), ext: extname(e.name).toLowerCase(), size });
    }
  };
  walk(dir, '', 0);
  return out;
}
const countsOf = (files) => { const c = {}; for (const f of files) c[f.kind] = (c[f.kind] || 0) + 1; return c; };
// "2 fonts · 6 colours · 14 icons" for a pack's card.
export function brings(p) {
  const n = (k) => p.counts?.[k] || 0;
  const parts = [[n('font'), 'font'], [p.palette?.length || p.style?.palette?.length || 0, 'colour'], [n('icon'), 'icon'], [n('texture'), 'texture'], [n('picture'), 'picture'], [n('model'), '3D model'], [n('document'), 'document'], [n('layout'), 'layout']]
    .filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}${c === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export const packsRoot = (root) => join(root, 'packs');

function readPack(dir, kind, id) {
  let d = {};
  try { d = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')); } catch { /* a folder of pictures is a pack too */ }
  if (!d || typeof d !== 'object') d = {};
  const files = readdirSync(dir);
  const pictures = files.filter((f) => PICTURE.has(extname(f).toLowerCase())).sort().slice(0, 24).map((f) => join(dir, f));
  const fontsDir = join(dir, 'fonts');
  const fontFiles = existsSync(fontsDir) ? readdirSync(fontsDir).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f)).slice(0, 40).map((f) => join(fontsDir, f)) : [];
  const own = KINDS[kind]?.read(d, dir) || { words: str(d.words, 4000) };
  const asset_files = packFiles(dir);
  const counts = countsOf(asset_files);
  const out = { id, kind, name: str(d.name, 80) || id, description: str(d.description, 600), author: str(d.author, 120), license: str(d.license, 200),
    source: str(d.source, 200) || 'local', tags: strs(d.tags, 20, 40), version: Number(d.version) || 1, spec: Number(d.spec) || 1, share: d.share === false ? false : d.share === true, confirmed: d.confirmed !== false, dir, pictures, font_files: fontFiles, asset_files, counts, ...own };
  out.brings = brings(out);
  return out;
}

function packsIn(dir, kind) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500)) {
    try { out.push(readPack(join(dir, e.name), kind, e.name)); } catch { /* an unreadable folder is skipped */ }
  }
  return out;
}

// packs.list {kind?}: the studio's packs, every kind (or one). `style-packs/` (the first place style packs lived) is
// read as style packs too.
export function listAllPacks(root, kind = null) {
  const base = packsRoot(root);
  const kinds = existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name) : [];
  const out = [];
  for (const k of [...new Set([...Object.keys(KINDS), ...kinds])]) {
    if (kind && k !== kind) continue;
    out.push(...packsIn(join(base, k), k));
  }
  if (!kind || kind === 'style') for (const p of packsIn(join(root, 'style-packs'), 'style')) if (!out.some((x) => x.kind === 'style' && x.id === p.id)) out.push(p);
  return out;
}

// packs.kinds: every kind, what it's for, its folder and how many packs it has.
export function packKinds(root) {
  const all = listAllPacks(root);
  const kinds = [...new Set([...Object.keys(KINDS), ...all.map((p) => p.kind)])];
  return kinds.map((k) => ({ kind: k, used: KINDS[k]?.used || '', dir: join(packsRoot(root), k), count: all.filter((p) => p.kind === k).length }));
}
