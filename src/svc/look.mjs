// Stage 2 Look (doc 11 §9.3, doc 37's looks card): the style frames to pick from, the one in use, its palette and
// fonts, and which shots were made in which look.
//
// The looks are the canvas's frame nodes (design/frames.json, `sf01`…). Which one is in use is the owner's pick, kept
// in state/<id>/canvas/look.json (`using`, else the first frame) and mirrored into design/frames.json's `using`, so the
// session reads it too. Picking another look when shots already exist asks first (`look.use` without `confirm`
// answers with what would be remade); confirmed, each shot made in the old look gets a Fix through the canvas (versions
// kept, the AI runs ahead as usual) and is marked changed until its remake is in. "Make more looks" asks the session for
// new frames as new pieces (edit requests, op `more`), the same path as a new shot.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { canvasView, canvasPaths, nodeAction, requestNewPiece, loadEdits, CanvasError } from '../canvas.mjs';
import { projectPaths, loadProject } from '../projects.mjs';
import { withLock, writeJson } from '../studio.mjs';
import { filmOrder, loadLayout } from './graph.mjs';

/** Most looks a project keeps to pick from. */
export const MAX_LOOKS = 8;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const lookFile = (root, id) => join(canvasPaths(root, id).dir, 'look.json');
const hex6 = (h) => { const x = h.toLowerCase(); return x.length === 4 ? `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}` : x; };

export function readLook(root, id) {
  const l = readOr(lookFile(root, id), {});
  return { using: typeof l.using === 'string' ? l.using : null, made_in: l.made_in && typeof l.made_in === 'object' ? l.made_in : {},
    changed: l.changed && typeof l.changed === 'object' ? l.changed : {}, history: Array.isArray(l.history) ? l.history.slice(-50) : [] };
}

// The palette and fonts a frame was made with: what the session wrote in design/frames.json, else what an SVG frame
// uses (its fill / stroke / stop colours and font families). A picture with neither: the app reads its colours itself.
function paletteOf(f, file) {
  let palette = Array.isArray(f?.palette) ? f.palette.filter((c) => typeof c === 'string' && HEX.test(c)).map(hex6) : [];
  let fonts = Array.isArray(f?.fonts) ? f.fonts.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 60)) : [];
  if ((!palette.length || !fonts.length) && file && extname(file).toLowerCase() === '.svg') {
    try {
      if (statSync(file).size <= 4 * 1024 * 1024) {
        const svg = readFileSync(file, 'utf8');
        if (!palette.length) palette = [...svg.matchAll(/(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*(#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b)/g)].map((m) => hex6(m[1]));
        if (!fonts.length) fonts = [...svg.matchAll(/font-family\s*[=:]\s*["']?([^"';>]+)/g)].map((m) => m[1].split(',')[0].replace(/["']/g, '').trim()).filter(Boolean);
      }
    } catch { /* an unreadable frame has no palette */ }
  }
  return { palette: [...new Set(palette)].slice(0, 8), fonts: [...new Set(fonts)].slice(0, 4) };
}

// look.get: the looks (made and being made), the one in use, its palette and fonts, and every shot with the look it
// was made in.
export function lookView(root, id) {
  const g = canvasView(root, id);
  const paths = projectPaths(root, id);
  const abs = (v) => (v?.file ? join(paths.state, v.file) : null);
  const design = readOr(join(paths.work, 'design', 'frames.json'), {});
  const own = new Map((Array.isArray(design?.frames) ? design.frames : []).filter((f) => f && typeof f.id === 'string').map((f) => [f.id, f]));
  const st = readLook(root, id);
  const frames = g.order.frames.map((fid) => {
    const n = g.nodes[fid];
    const ver = n.versions?.find((v) => v.v === n.current) || n.versions?.at(-1) || null;
    const path = abs(ver);
    const f = own.get(fid) || {};
    const name = String(f.name || String(n.label || fid).replace(/^SF\d+\s*·\s*/i, '') || n.label).slice(0, 80);
    return { id: fid, label: n.label, name, words: String(f.words || f.description || '').slice(0, 400), path, version: n.current ?? null,
      versions: n.versions?.length || 0, state: n.state, owner: n.owner, pending: Boolean(n.pending), making: false,
      beats: Array.isArray(n.beats) ? n.beats : [], ...paletteOf(f, path) };
  });
  // looks asked for with "Make more looks" that aren't made yet
  for (const e of loadEdits(root, id).filter((x) => x.kind === 'frame' && x.op === 'more' && ['requested', 'working', 'fast'].includes(x.state))) {
    if (!frames.some((f) => f.id === e.node)) frames.push({ id: e.node, label: e.label, name: 'Being made…', words: '', path: null, version: null, versions: 0, state: 'generating', owner: null, pending: true, making: true, beats: [], palette: [], fonts: [] });
  }
  const made = frames.filter((f) => !f.making && f.path);
  const using = made.some((f) => f.id === st.using) ? st.using : made[0]?.id || null;
  const beatNo = Object.fromEntries(g.order.beats.map((b, i) => [b, i + 1]));
  const film = filmOrder(g, loadLayout(root, id));
  const shots = film.map((sid) => g.nodes[sid]).filter((n) => n && n.kind === 'shot' && !n.missing).map((n) => {
    const isMade = Boolean(n.versions?.some((v) => v.file));
    const c = st.changed[n.id];
    return { id: n.id, label: n.label, title: String(n.title || '').slice(0, 200), beat: n.beat || null, beat_no: beatNo[n.beat] ?? null, colour: n.colour || null,
      made: isMade, cut: n.owner === 'cut', look: isMade ? (st.made_in[n.id] || using) : null,
      remaking: Boolean(n.pending), changed: Boolean(c && n.pending && n.pending.id === c.edit), changed_from: c && n.pending && n.pending.id === c.edit ? c.from : null };
  });
  // the video's shape (width / height) from the brief ("9:16"), so the app draws the frames in it
  const answers = Object.values(loadProject(root, id).intake?.answers || {});
  const shape = answers.map((v) => String(v).match(/^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/)).find(Boolean);
  const aspect = shape && Number(shape[2]) > 0 ? Math.round((Number(shape[1]) / Number(shape[2])) * 1000) / 1000 : 16 / 9;
  return { project: id, using, frames, shots, max: MAX_LOOKS, can_more: frames.length < MAX_LOOKS, aspect };
}

// look.use {frame, confirm?}: pick the look in use. Shots made in another look are remade in it, but only once the
// owner confirmed: without `confirm` (and with shots to remake) nothing changes and the answer lists them.
export function useLook(root, id, { frame, confirm = false } = {}) {
  const fid = String(frame || '');
  const v = lookView(root, id);
  const f = v.frames.find((x) => x.id === fid);
  if (!f) throw new CanvasError(`no look ${fid.slice(0, 20) || '(none)'} in this project`);
  if (f.making || !f.path) throw new CanvasError(`${f.label} isn't made yet`);
  const from = v.using;
  const brief = (s) => ({ id: s.id, label: s.label, title: s.title, beat: s.beat, beat_no: s.beat_no, colour: s.colour, look: s.look });
  const remake = v.shots.filter((s) => s.made && !s.cut && s.look !== fid);
  if (fid === from && !remake.length) return { project: id, using: fid, from, changed: false, remake: [], remaking: [] };
  if (remake.length && confirm !== true) return { project: id, needs_confirm: true, using: from, from, to: fid, remake: remake.map(brief) };
  const paths = projectPaths(root, id);
  const rel = f.path.startsWith(paths.state) ? f.path.slice(paths.state.length + 1) : f.path;
  const cp = canvasPaths(root, id);
  mkdirSync(cp.dir, { recursive: true });
  return withLock(join(cp.dir, '.look.lock'), () => {
    const st = readLook(root, id);
    const at = new Date().toISOString();
    st.using = fid;
    st.history.push({ at, from, to: fid });
    const remaking = [];
    for (const s of remake) {
      try {
        const r = nodeAction(root, id, s.id, { action: 'fix', text: `The owner picked another look: ${f.name} (${f.label}, the style frame ${rel}). Remake this shot in that look: its colours, type and texture. Keep what it shows, its timing and its length.` });
        remaking.push({ node: s.id, edit: r.edit.id });
        st.changed[s.id] = { from: s.look, to: fid, edit: r.edit.id, at };
        st.made_in[s.id] = fid;
      } catch (e) { console.error(`look.use ${s.id}: ${e.message}`); }
    }
    writeJson(lookFile(root, id), st);
    // the session reads design/frames.json: it says which look is in use
    const df = join(paths.work, 'design', 'frames.json');
    const design = readOr(df, null);
    if (design && typeof design === 'object' && Array.isArray(design.frames)) writeJson(df, { ...design, using: fid });
    return { project: id, using: fid, from, changed: true, remake: remake.map(brief), remaking };
  });
}

// look.more {count?, text?}: ask the session for more looks to pick from (1-3 at a time, at most MAX_LOOKS in all).
export function moreLooks(root, id, { count = 2, text = '' } = {}) {
  const v = lookView(root, id);
  if (!v.frames.length) throw new CanvasError('the first looks come with the style frames step');
  const room = MAX_LOOKS - v.frames.length;
  if (room <= 0) throw new CanvasError(`${MAX_LOOKS} looks is the most a project keeps; ask for changes on one instead`);
  const n = Math.max(1, Math.min(3, room, Number.isInteger(count) ? count : 2));
  const g = canvasView(root, id);
  const taken = new Set([...Object.keys(g.nodes), ...loadEdits(root, id).map((e) => e.node)]);
  const others = v.frames.filter((f) => !f.making).map((f) => `${f.label} (${f.name})`).join(', ');
  const words = String(text || '').trim().slice(0, 1000);
  const making = [];
  for (let k = 1, made = 0; made < n && k < 1000; k++) {
    const nid = `sf${String(k).padStart(2, '0')}`;
    if (taken.has(nid)) continue;
    taken.add(nid);
    const edit = requestNewPiece(root, id, { node: nid, kind: 'frame', label: nid.toUpperCase(), op: 'more',
      text: `Make a new look to pick from: style frame ${nid.toUpperCase()}, a clearly different direction from ${others || 'the others'}.${words ? ` ${words}` : ''} Write it as frame "${nid}" in design/frames.json with its own file, a short name, its palette (hex colours) and fonts; keep the frames that are there.` });
    making.push({ node: nid, edit: edit.id });
    made++;
  }
  return { project: id, making };
}
