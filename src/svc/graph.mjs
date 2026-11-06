// The node graph as the app draws it (doc 35), the loose preview's edit list (doc 36), the voice & music lanes
// (doc 34) and the Mortiflix Studio hand-off plan (doc 38): all read from the one canvas graph (src/canvas.mjs).
//
// The owner's own things live beside the graph in state/<id>/canvas/:
//   layout.json  node positions (free placement like Blender) and the film order (the chain; reorder = rewire)
//   picks.json   which version plays, when it isn't the newest
//   mix.json     per line / cue: level, ducking, hand-set timing, voice, length in bars
//   edit-app.json  what the app imported (node → clip), so a new version is swapped in, never rebuilt
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { canvasView, canvasPaths, loadGraph, nodeAction, requestNewPiece, CanvasError, readBeats, mediaUnfinished } from '../canvas.mjs';
import { beatNames } from './beatnames.mjs';
import { projectPaths, loadProject, event } from '../projects.mjs';
import { withLock, writeJson } from '../studio.mjs';
import { listAssets } from './assets.mjs';
import { cuePlan } from './theme.mjs';
import { boothStatus } from '../booth.mjs';
import { syncVoiceWords } from './script.mjs';
import { creditRate } from './voicecost.mjs';
import { voiceConfig } from '../voice/index.mjs';
import { writtenForms } from './stills.mjs';
import { captionText, moneyHints } from './captionform.mjs';

// Older versions handed to Edit per piece (the newest ones): two of a shot, one of a voice line or the music (a 26 min
// film put 494 in the bin: three per shot plus each line's take as MP3 and again as WAV).
const OLDER_KEPT = { shot: 2, line: 1, music: 1, cue: 1, transition: 1 };
// Version files are named by their content, so whether one is cut off (a video stopped mid-write, an empty or
// half-written WAV) never changes: asked once. Such a version is left out everywhere (graph, Edit's older versions).
const unfinishedSeen = new Map();
function unfinished(path) {
  if (!unfinishedSeen.has(path)) {
    if (unfinishedSeen.size > 20000) unfinishedSeen.clear();
    unfinishedSeen.set(path, mediaUnfinished(path));
  }
  return unfinishedSeen.get(path);
}
// The words as spoken: a line's voice directions ("[warm, a little smile] …") are for the voice, not the captions.
export const spoken = (words) => String(words || '').replace(/\[[^\]\n]{0,200}\]\s*/g, '').trim();

const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const files = (root, id) => {
  const cp = canvasPaths(root, id);
  return { ...cp, layout: join(cp.dir, 'layout.json'), picks: join(cp.dir, 'picks.json'), mix: join(cp.dir, 'mix.json'), app: join(cp.dir, 'edit-app.json') };
};
const save = (f, v) => { mkdirSync(join(f, '..'), { recursive: true }); writeJson(f, v); };
const round3 = (x) => Math.round(x * 1000) / 1000;
const NODE_ID = /^[a-z][a-z0-9-]{1,23}$/;

export const loadLayout = (root, id) => readOr(files(root, id).layout, { positions: {}, film_order: null });
export const loadPicks = (root, id) => readOr(files(root, id).picks, {});
export const loadMix = (root, id) => readOr(files(root, id).mix, { lines: {}, cues: {} });

// The film order: the owner's chain when they rewired it, then any shot that came later, in the AI's order.
export function filmOrder(g, layout) {
  const shots = g.order.shots;
  const mine = (layout.film_order || []).filter((s) => shots.includes(s));
  return [...mine, ...shots.filter((s) => !mine.includes(s))];
}

const plays = (n, picks) => {
  const v = picks[n.id] && n.versions?.some((x) => x.v === picks[n.id]) ? picks[n.id] : n.current;
  return n.versions?.find((x) => x.v === v) || null;
};

// Tidy rows, only for nodes the owner never moved (doc 35 + owner answer 3: then they stay where dropped).
function defaultPos(g, film) {
  const pos = {};
  film.forEach((s, i) => { pos[s] = [i * 300, 0]; });
  for (const t of g.order.transitions) { const n = g.nodes[t]; const a = film.indexOf(n?.from); if (a >= 0) pos[t] = [a * 300 + 230, 40]; }
  const perBeat = {};
  for (const l of g.order.lines) { const n = g.nodes[l]; const s = film.find((x) => g.nodes[x]?.beat === n?.beat); const k = perBeat[n?.beat] = (perBeat[n?.beat] || 0) + 1; pos[l] = [(s ? film.indexOf(s) : 0) * 300 + (k - 1) * 40, 260 + (k - 1) * 30]; }
  g.order.frames.forEach((f, i) => { pos[f] = [i * 300, -260]; });
  g.order.beats.forEach((b, i) => { pos[b] = [i * 300, -420]; });
  return pos;
}

// A PNG still per shot version (its first frame, made once with ffmpeg in the background, two at a time): graph.get
// names it (`still`) as soon as the file exists, and the node area and the chat show it. A picture version is its own
// still. A frame that can't be made is not tried again while the service runs.
const VIDEO = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;
const PICTURE = /\.(png|jpe?g|webp)$/i;
const stills = { queue: [], running: 0, failed: new Set(), queued: new Set() };
export function stillFor(state, node, v) {
  if (node.kind !== 'shot' || !v?.path) return null;
  if (PICTURE.test(v.path)) return v.path;
  if (!VIDEO.test(v.path)) return null;
  const file = join(state, 'stills', `${String(node.id).replace(/[^a-z0-9_-]/gi, '')}-v${Number(v.v) || 0}.png`);
  if (existsSync(file)) return file;
  if (!stills.failed.has(file) && !stills.queued.has(file) && existsSync(v.path)) {
    stills.queued.add(file);
    stills.queue.push({ src: v.path, at: Math.max(0, Number(v.from_sec) || 0), file });
    nextStill();
  }
  return null;
}
function nextStill() {
  while (stills.running < 2 && stills.queue.length) {
    const job = stills.queue.shift();
    stills.running++;
    const part = `${job.file}.part.png`;
    try { mkdirSync(join(job.file, '..'), { recursive: true }); } catch { /* the spawn reports it */ }
    let p;
    try {
      p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(job.at), '-i', job.src, '-frames:v', '1', '-vf', 'scale=480:-2', part], { stdio: 'ignore' });
    } catch { p = null; }
    const done = (ok) => {
      stills.running--;
      stills.queued.delete(job.file);
      try { if (ok && existsSync(part)) renameSync(part, job.file); else { stills.failed.add(job.file); rmSync(part, { force: true }); } } catch { stills.failed.add(job.file); }
      nextStill();
    };
    if (!p) { done(false); continue; }
    p.on('error', () => done(false));
    p.on('close', (code) => done(code === 0));
  }
}
// Waits until every queued still is made (tests).
export async function stillsSettled(timeoutMs = 20_000) {
  const t0 = Date.now();
  while ((stills.running || stills.queue.length) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50));
}

// The graph for the node area: every node with its beat number and colour, state, versions (absolute paths), which
// version plays, position, the owner's mix settings, the assets it uses; the edges; the film order.
export function graphView(root, id) {
  const g = canvasView(root, id);
  const state = projectPaths(root, id).state;
  const layout = loadLayout(root, id);
  const picks = loadPicks(root, id);
  const mix = loadMix(root, id);
  const assets = listAssets(root, id).yours;
  const film = filmOrder(g, layout);
  const beatNo = Object.fromEntries(g.order.beats.map((b, i) => [b, i + 1]));
  const dpos = defaultPos(g, film);
  // the beats' short names (the script's, the AI's, else a title from the words): nodes, ribbon, bins, markers
  let names = {};
  try { names = beatNames(root, id, readBeats(projectPaths(root, id).work, [])); } catch { /* no script yet */ }
  const nodes = Object.values(g.nodes).map((n) => {
    const p = plays(n, picks);
    return {
      ...n,
      ...(n.kind === 'beat' && names[n.id] ? { name: names[n.id].name, name_from: names[n.id].from } : {}),
      beat_no: n.beat ? beatNo[n.beat] ?? null : null,
      // a version copied while its video was still being written (before 439e1d1) is a cut-off file: left out
      versions: (n.versions || []).map((v) => ({ ...v, path: v.file ? join(state, v.file) : null })).filter((v) => !(v.path && unfinished(v.path)))
        .map((v) => ({ ...v, still: stillFor(state, n, v) })),
      plays: p?.v ?? null,
      pos: layout.positions[n.id] || null,
      default_pos: dpos[n.id] || null,
      mix: (n.kind === 'line' ? mix.lines[n.id] : n.kind === 'cue' ? mix.cues[n.id] : null) || null,
      uses: assets.filter((a) => a.used_in.some((u) => u.node === n.id)).map((a) => a.id),
    };
  });
  const edges = [];
  // Film order: shot → transition → shot where the board has a transition for that cut, else shot → shot.
  for (let i = 0; i + 1 < film.length; i++) {
    const [a, b] = [film[i], film[i + 1]];
    const t = g.order.transitions.find((x) => g.nodes[x]?.from === a && g.nodes[x]?.to === b);
    if (t) edges.push({ from: a, to: t, kind: 'next' }, { from: t, to: b, kind: 'next' });
    else edges.push({ from: a, to: b, kind: 'next' });
  }
  for (const l of g.order.lines) { const n = g.nodes[l]; for (const s of film.filter((x) => g.nodes[x]?.beat === n.beat)) edges.push({ from: l, to: s, kind: 'says' }); }
  for (const s of film) { const n = g.nodes[s]; if (n?.look) edges.push({ from: n.look, to: s, kind: 'look' }); }
  for (const a of assets) for (const u of a.used_in) edges.push({ from: a.id, to: u.node, kind: 'uses' });
  for (const c of g.order.cues) { const n = g.nodes[c]; for (const s of film.filter((x) => g.nodes[x]?.beat === n.beat)) edges.push({ from: c, to: s, kind: 'under' }); }
  // each shot's place and length in the film as the preview, Voice & music and Edit play it (the node area showed a
  // version's whole file length: "0:43" for a 0:36 film)
  try {
    const tl = shotTimeline(root, id, { order: { ...g.order, film }, nodes });
    for (const sh of tl.shots) { const n = nodes.find((x) => x.id === sh.node); if (n) Object.assign(n, { film_start: sh.start_sec, film_sec: sh.dur_sec }); }
  } catch { /* the nodes keep their own lengths */ }
  return {
    project: id, rev: g.rev, fps: g.fps, colours: g.colours, problems: g.problems, open_edits: g.open_edits,
    order: { ...g.order, film },
    beats: g.order.beats.map((b, i) => ({ id: b, no: i + 1, title: g.nodes[b]?.title || '', name: names[b]?.name || '', colour: g.nodes[b]?.colour || null })),
    nodes, edges,
    // your own files are input nodes too: where you dropped them (node.move takes asset ids)
    assets: assets.map((a) => ({ ...a, pos: layout.positions[a.id] || null })),
  };
}

// Free placement: positions as {nodeId: [x, y]} (finite numbers), merged into what's saved. null removes one.
export function moveNodes(root, id, positions) {
  if (!positions || typeof positions !== 'object') throw new CanvasError('positions: {node: [x, y]}');
  const f = files(root, id);
  mkdirSync(f.dir, { recursive: true });
  return withLock(f.lock, () => {
    const layout = loadLayout(root, id);
    const known = new Set([...Object.keys(loadGraph(root, id)?.nodes || {}), ...(loadProject(root, id).assets || []).map((a) => a.id)]);
    let n = 0;
    for (const [nid, p] of Object.entries(positions).slice(0, 5000)) {
      if (!known.has(nid)) continue;
      if (p === null) { delete layout.positions[nid]; n++; continue; }
      if (!Array.isArray(p) || p.length !== 2 || !p.every((x) => Number.isFinite(x) && Math.abs(x) < 1e7)) continue;
      layout.positions[nid] = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
      n++;
    }
    save(f.layout, layout);
    return { moved: n };
  });
}

// Reorder = rewire the chain (doc 35): the owner's film order, every shot once. Nothing is remade.
export function reorder(root, id, order) {
  const g = canvasView(root, id);
  if (!Array.isArray(order)) throw new CanvasError('order: the shot ids in film order');
  const shots = new Set(g.order.shots);
  const clean = [...new Set(order.map(String))].filter((s) => shots.has(s));
  if (!clean.length) throw new CanvasError('no shots in that order');
  const f = files(root, id);
  const out = withLock(f.lock, () => {
    const layout = loadLayout(root, id);
    layout.film_order = [...clean, ...g.order.shots.filter((s) => !clean.includes(s))];
    save(f.layout, layout);
    return layout.film_order;
  });
  event(root, id, { event: 'REORDERED', actor: 'you', details: out.map((s) => s.toUpperCase()).join(' ') });
  return { film: out };
}

// Which version plays (an older one picked from the versions); null goes back to the newest.
export function pickVersion(root, id, nid, v) {
  const g = canvasView(root, id);
  const n = g.nodes[nid];
  if (!n) throw new CanvasError(`no piece ${nid}`);
  if (v !== null && !n.versions.some((x) => x.v === v)) throw new CanvasError(`${n.label} has no v${v}`);
  const f = files(root, id);
  // picking the newest is "the newest": a remake later plays (run 2: v2 picked when it was the newest stayed on
  // after the remakes, and Edit got the old shot)
  const newest = v !== null && v === n.current;
  withLock(f.lock, () => { const p = loadPicks(root, id); if (v === null || newest) delete p[nid]; else p[nid] = v; save(f.picks, p); });
  event(root, id, { event: 'VERSION_PICKED', actor: 'you', details: `${n.label} v${v ?? n.current}` });
  return { node: nid, plays: v ?? n.current };
}

// A new shot: Duplicate (like this one) or Insert (after this one, from words). A session makes it; it joins the film
// right after `after`.
export function newShot(root, id, { op, after, text }) {
  const g = canvasView(root, id);
  const base = g.nodes[after];
  if (!base || base.kind !== 'shot') throw new CanvasError(`${after} isn't a shot`);
  const taken = new Set([...Object.keys(g.nodes), ...readOr(canvasPaths(root, id).edits, { edits: [] }).edits.map((e) => e.node)]);
  let k = 1;
  while (taken.has(`s${String(k).padStart(2, '0')}`)) k++;
  const nid = `s${String(k).padStart(2, '0')}`;
  const words = op === 'duplicate'
    ? `Duplicate ${base.label}: a new shot ${nid.toUpperCase()} like it, right after it in the film.${text ? ` ${text}` : ''} Write it as scene "${nid}" (beat ${base.beat || 'none'}) with its own file in out/scenes.json.`
    : `Insert a new shot ${nid.toUpperCase()} right after ${base.label}: ${text}. Write it as scene "${nid}" (beat ${base.beat || 'none'}) with its own file in out/scenes.json.`;
  if (op !== 'duplicate' && !String(text || '').trim()) throw new CanvasError('say what the new shot shows');
  const edit = requestNewPiece(root, id, { node: nid, kind: 'shot', label: nid.toUpperCase(), beat: base.beat || null, op, after, text: words });
  const layout = loadLayout(root, id);
  const film = filmOrder(g, layout);
  film.splice(film.indexOf(after) + 1, 0, nid);
  const f = files(root, id);
  withLock(f.lock, () => { const l = loadLayout(root, id); l.film_order = film; save(f.layout, l); });
  return { edit, node: nid };
}

// ---------------------------------------------------------------------------------------- times and media

function bpmOf(root, id) {
  const bp = readOr(join(projectPaths(root, id).work, 'music', 'blueprint.json'), null);
  const [num] = String(bp?.meter || '4/4').split('/').map(Number);
  return { bpm: Number(bp?.bpm) || 120, beats: num || 4 };
}

// Each shot of the film with its time and the best media it has (doc 36: its own piece of the animatic, else its
// look's still held for the length, else a beat card).
export function shotTimeline(root, id, gv = graphView(root, id)) {
  const byId = Object.fromEntries(gv.nodes.map((n) => [n.id, n]));
  const lineSec = (beat) => gv.nodes.filter((n) => n.kind === 'line' && n.beat === beat && n.end_sec != null && n.start_sec != null).reduce((s, n) => s + (n.end_sec - n.start_sec), 0);
  let t = 0;
  const shots = [];
  for (const sid of gv.order.film) {
    const n = byId[sid];
    if (!n || n.state === 'cut' || n.missing) continue;
    const v = n.versions.find((x) => x.v === n.plays);
    const beat = n.beat ? byId[n.beat] : null;
    const shotsInBeat = gv.order.film.filter((x) => byId[x]?.beat === n.beat && byId[x]?.state !== 'cut').length || 1;
    let media;
    let dur;
    if (v?.path) {
      dur = round3((v.to_sec ?? 0) - (v.from_sec ?? 0)) || 2;
      media = { kind: /\.(png|jpe?g|webp|svg|gif)$/i.test(v.path) ? 'still' : 'video', path: v.path, from_sec: v.from_sec ?? 0, to_sec: v.to_sec ?? null };
    } else {
      dur = round3(((beat?.target_sec ?? null) || lineSec(n.beat) || 3) / shotsInBeat);
      const look = n.look ? byId[n.look] : null;
      const still = look?.versions.find((x) => x.v === look.plays);
      media = still?.path ? { kind: 'still', path: still.path, look: look.id } : { kind: 'card', text: n.title || beat?.title || n.label, colour: n.colour?.hex || null };
    }
    shots.push({ node: sid, label: n.label, title: n.title || '', beat: n.beat || null, beat_no: n.beat_no, colour: n.colour || null, state: n.state, version: n.plays, start_sec: 0, dur_sec: dur, media, at: Number.isFinite(n.at_sec) ? n.at_sec : null });
  }
  // Shots with their place in the animatic (the film as the AI timed it, voice included): each plays until the next
  // one's place, also a shot remade alone into its own longer file (run 2: S03 and S05 remade kept their whole
  // length and pushed every later shot, 7 s by the end)
  for (let i = 0; i + 1 < shots.length; i++) {
    const a = shots[i];
    const gap = a.at !== null && shots[i + 1].at !== null ? round3(shots[i + 1].at - a.at) : null;
    if (gap !== null && gap > 0.2 && gap < a.dur_sec && a.media.to_sec != null) {
      a.dur_sec = gap;
      a.media.to_sec = round3((a.media.from_sec ?? 0) + gap);
    }
  }
  // Shots cut from one animatic whose ranges overlap (the AI's cuts carry a transition): each plays until the next one
  // starts, so the film keeps the animatic's timing and the voice stays on its pictures (run 2: placed back to back
  // whole, the overlaps added 8 s and the last lines played over the wrong shots)
  for (let i = 0; i + 1 < shots.length; i++) {
    const a = shots[i].media;
    const b = shots[i + 1].media;
    if (a.kind === 'video' && b.kind === 'video' && a.path === b.path && b.from_sec > a.from_sec && a.to_sec != null && b.from_sec < a.to_sec) {
      a.to_sec = b.from_sec;
      shots[i].dur_sec = round3(b.from_sec - a.from_sec);
    }
  }
  for (const sh of shots) { sh.start_sec = round3(t); t += sh.dur_sec; delete sh.at; }
  return { shots, length_sec: round3(t) };
}

// What speech-to-text heard in a line's kept take (voice/clips/<id>.json), so the owner can check the words:
// `heard` is null and `checked` false when nothing listened (a voice with no speech-to-text, or the owner's own take);
// `words_ok` is the check's verdict when it ran.
function heardOf(work, lineId, changedAt) {
  return { ...heardCheck(work, lineId), words_changed: wordsChanged(work, lineId, changedAt) };
}

// The script's words for a line changed after its kept take was made (script.edit no longer remakes it): Voice shows
// "words changed" and Remake line until a new take lands. The voice cache knows the words a take was made with
// (sound/voice/lines/<id>.json); without it, a script change newer than the take's clip.
function wordsChanged(work, lineId, changedAt) {
  const said = changedAt.said?.[lineId];
  if (said !== undefined) return said !== changedAt.words?.[lineId];
  const at = changedAt[lineId];
  if (!at) return false;
  try {
    return Date.parse(at) > statSync(join(work, 'voice', 'clips', `${lineId}.wav`)).mtimeMs;
  } catch { return false; }
}

function heardCheck(work, lineId) {
  try {
    const j = JSON.parse(readFileSync(join(work, 'voice', 'clips', `${lineId}.json`), 'utf8'));
    const heard = typeof j.transcript === 'string' ? j.transcript.slice(0, 2000) : null;
    return { heard, checked: heard !== null, words_ok: heard !== null ? j.pass !== false : null };
  } catch { return { heard: null, checked: false, words_ok: null }; }
}

// Voice clips at their times (hand-set start wins), music with its cues' times.
export function soundTimeline(root, id, gv, shots) {
  const mix = loadMix(root, id);
  const work = projectPaths(root, id).work;
  const beatStart = {};
  for (const s of shots) if (s.beat && beatStart[s.beat] === undefined) beatStart[s.beat] = s.start_sec;
  const cursor = {};
  const changedAt = {};
  try {
    for (const b of JSON.parse(readFileSync(join(work, 'script', 'beats.json'), 'utf8')).beats || []) for (const l of b.lines || []) if (l.changed_at) changedAt[l.id] = l.changed_at;
  } catch { /* no script yet */ }
  try {
    changedAt.words = {};
    changedAt.said = {};
    for (const l of JSON.parse(readFileSync(join(work, 'voice', 'lines.json'), 'utf8'))) {
      changedAt.words[l.id] = l.text ?? l.script;
      const m = join(work, 'sound', 'voice', 'lines', `${l.id}.json`);
      const clip = join(work, 'voice', 'clips', `${l.id}.wav`);
      // a take made after the cache (New take, Remake line) is newer than what the cache says was said
      if (existsSync(m) && !(existsSync(clip) && statSync(clip).mtimeMs > statSync(m).mtimeMs + 1000)) changedAt.said[l.id] = JSON.parse(readFileSync(m, 'utf8')).text;
    }
  } catch { /* no voice lines yet */ }
  const voice = gv.nodes.filter((n) => n.kind === 'line' && !n.missing && n.state !== 'cut').sort((a, b) => a.order - b.order).map((n) => {
    const v = n.versions.find((x) => x.v === n.plays);
    const m = mix.lines[n.id] || {};
    const len = n.end_sec != null && n.start_sec != null ? round3(n.end_sec - n.start_sec) : null;
    const at = m.start_sec ?? n.start_sec ?? ((beatStart[n.beat] ?? 0) + (cursor[n.beat] || 0));
    cursor[n.beat] = (cursor[n.beat] || 0) + (len || 0);
    return { node: n.id, label: n.label, words: n.title, beat: n.beat, beat_no: n.beat_no, colour: n.colour, state: n.state, version: n.plays, path: v?.path || null, start_sec: round3(at), dur_sec: len, gain_db: m.gain_db ?? 0, voice: m.voice ?? null, timing_locked: m.start_sec !== undefined, ...heardOf(work, n.id, changedAt) };
  });
  const music = gv.nodes.find((n) => n.id === 'music' && !n.missing);
  const mv = music?.versions.find((x) => x.v === music.plays);
  const { bpm, beats } = bpmOf(root, id);
  const barSec = (60 / bpm) * beats;
  const cues = gv.nodes.filter((n) => n.kind === 'cue' && !n.missing).sort((a, b) => a.order - b.order).map((n) => {
    const m = mix.cues[n.id] || {};
    const start = n.bars ? round3((n.bars[0] - 1) * barSec) : null;
    // a cue the score doesn't tie to a beat takes the beat it starts in, so its clip has that beat's colour in Edit
    // (run 2: every cue was the same green, hard to tell which music goes with which scene)
    const at = !n.beat && start !== null ? (shots || []).find((sh) => start >= sh.start_sec - 0.05 && start < sh.start_sec + sh.dur_sec) : null;
    const beat = n.beat || at?.beat || null;
    return { node: n.id, label: n.label, title: n.title, beat, beat_no: n.beat_no ?? at?.beat_no ?? null, colour: n.colour || at?.colour || null, state: n.state, bars: n.bars || null,
      start_sec: start, end_sec: n.bars ? round3(n.bars[1] * barSec) : null, gain_db: m.gain_db ?? 0, duck_db: m.duck_db ?? null, len_bars: m.len_bars ?? null };
  });
  return { voice, music: mv?.path ? { node: 'music', path: mv.path, version: music.plays, start_sec: 0 } : null, cues, bpm, beats_per_bar: beats };
}

// The loose preview's edit list (doc 36): scope all | from | shot | beat, around `node`.
export function previewPlan(root, id, { scope = 'all', node = null } = {}) {
  const gv = graphView(root, id);
  const { shots, length_sec } = shotTimeline(root, id, gv);
  const sound = soundTimeline(root, id, gv, shots);
  let range = [0, length_sec];
  if (scope !== 'all') {
    const n = gv.nodes.find((x) => x.id === node);
    if (!n) throw new CanvasError(`${scope} needs a node`);
    const beat = n.kind === 'beat' ? n.id : n.beat;
    const sel = scope === 'beat' ? shots.filter((s) => s.beat === beat) : scope === 'shot' ? shots.filter((s) => s.node === node) : shots.slice(Math.max(0, shots.findIndex((s) => s.node === node || (n.kind !== 'shot' && s.beat === beat))));
    if (!sel.length) throw new CanvasError(`nothing to play for ${node}`);
    range = scope === 'from' ? [sel[0].start_sec, length_sec] : [sel[0].start_sec, round3(sel.at(-1).start_sec + sel.at(-1).dur_sec)];
  }
  return { rev: gv.rev, scope, node, range, length_sec, fps: gv.fps || 30, shots, ...sound };
}

// ------------------------------------------------------------------------------------- voice & music settings

export function setMix(root, id, nid, patch = {}) {
  const g = canvasView(root, id);
  const n = g.nodes[nid];
  if (!n || !['line', 'cue', 'music'].includes(n.kind)) throw new CanvasError(`${nid} isn't a voice line or a music cue`);
  const f = files(root, id);
  const out = withLock(f.lock, () => {
    const mix = loadMix(root, id);
    const box = n.kind === 'line' ? mix.lines : mix.cues;
    const m = { ...(box[nid] || {}) };
    const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v) * 10) / 10)) : undefined);
    if (patch.gain_db !== undefined) m.gain_db = num(patch.gain_db, -60, 12);
    if (n.kind === 'line') {
      // times to the millisecond: rounded to tenths, a first ±0.1 s on a line starting at 3.05 s moved it 0.15 s (run 2)
      const sec = (v) => (Number.isFinite(Number(v)) ? Math.min(36000, Math.max(0, Math.round(Number(v) * 1000) / 1000)) : undefined);
      if (patch.start_sec === null) delete m.start_sec;
      else if (patch.start_sec !== undefined) m.start_sec = sec(patch.start_sec);
      if (patch.nudge_sec !== undefined) m.start_sec = sec((m.start_sec ?? n.start_sec ?? 0) + Number(patch.nudge_sec));
      if (patch.voice !== undefined) m.voice = patch.voice ? String(patch.voice).slice(0, 120) : null;
    } else {
      if (patch.duck_db !== undefined) m.duck_db = patch.duck_db === null ? null : num(patch.duck_db, -40, 0);
      if (patch.len_bars !== undefined) m.len_bars = patch.len_bars === null ? null : num(patch.len_bars, 1, 512);
    }
    for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
    box[nid] = m;
    save(f.mix, mix);
    return m;
  });
  event(root, id, { event: 'MIX_SET', actor: 'you', details: `${n.label}: ${JSON.stringify(out).slice(0, 200)}` });
  // A new voice or a new length is real work: it goes to the AI as a Fix on that piece.
  let edit = null;
  if (n.kind === 'line' && patch.voice) edit = nodeAction(root, id, nid, { action: 'fix', text: `Read this line with the voice "${String(patch.voice).slice(0, 120)}".` }).edit;
  if (n.kind === 'cue' && patch.len_bars) edit = nodeAction(root, id, nid, { action: 'fix', text: `Make ${n.label} ${out.len_bars} bars long (ripple what follows, doc 19 §5).` }).edit;
  return { node: nid, mix: out, edit };
}

// Stage 4's two lanes: lines (with booth takes) and cues (the plan before the score, the sections after).
export function voiceMusicView(root, id) {
  // the voice lines say the script's current words before anything is shown (a scene Fix rewrote them: RUN-BUGS Dir3)
  try { syncVoiceWords(root, id); } catch (e) { console.error(`voice words sync ${id}: ${e.message}`); }
  const gv = graphView(root, id);
  const { shots, length_sec } = shotTimeline(root, id, gv);
  const sound = soundTimeline(root, id, gv, shots);
  let booth = { takes: [] };
  try { booth = boothStatus(root, id); } catch { /* no lines yet */ }
  const voice = sound.voice.map((l) => ({ ...l, takes: (booth.takes || []).filter((t) => t.line_id === l.node).map((t, _i, all) => ({ take: t.take_no, kept: t.kept, status: !t.kept && all.some((o) => o.kept) ? 'superseded' : 'ready', seconds: t.duration_ms / 1000, flags: t.flags, source: t.source })) }));
  const scored = new Map(sound.cues.map((c) => [c.node, c]));
  // Once the score exists its sections are the cues: the one-cue-per-beat plan's unscored entries go (a 26 min score in
  // 28 sections showed 42 more "planned" cues over the music, and the lanes said 70 cues where the stage said 28).
  const plan = cuePlan(root, id, gv).filter((c) => !scored.size || scored.has(c.id)).map((c) => (scored.has(c.id) ? { ...c, ...scored.get(c.id), state: gv.nodes.find((n) => n.id === c.id)?.state || 'ready', scored: true } : { ...c, node: c.id, scored: false, state: 'planned' }));
  const extra = sound.cues.filter((c) => !plan.some((p) => p.node === c.node)).map((c) => ({ ...c, id: c.node, scored: true }));
  // credits per character ElevenLabs bills (measured, svc/voicecost.mjs): the screen's own estimates use it
  let credit_rate = 1;
  try { credit_rate = creditRate(root, voiceConfig(root).elevenlabs?.model_id); } catch { /* list price */ }
  return { rev: gv.rev, length_sec, shots, voice, cues: [...plan, ...extra], music: sound.music, bpm: sound.bpm, beats_per_bar: sound.beats_per_bar, credit_rate };
}

// ------------------------------------------------------------------------------------------ into Edit

// A voice line as subtitles: its spoken words cut into captions of at most two lines of SUB_LINE characters, ending at
// a sentence or clause where one fits, each starting at its first word and ending at the next caption (or the line's
// end). `t`: the line's entry in voice/timing.json ({ start, words: [{ text, start, end }] } in voice-track time);
// without word times (or when the counts differ) times are shared by characters.
export const SUB_LINE = 52;
// One line each, small, at the very bottom edge (SUB_STYLE): the animatic keeps its own words 5 % inside the frame
// (the text-safe check), so the strip below is almost always free (run 3: two-line subtitles in the usual place
// covered credits, MIU strings and equations in a third of the film).
export const SUB_LINES = 1;
export const SUB_STYLE = { size: 38, margin: 0.008 };
export function subtitles(l, t, form = (x) => x) {
  const text = spoken(l.words);
  const words = text.split(/\s+/).filter(Boolean);
  const start = l.start_sec; const end = round3(l.start_sec + l.dur_sec);
  if (!words.length) return [];
  const fits = (ws) => { // two lines at most, filled greedily
    let lines = 1; let len = 0;
    for (const w of ws) { if (w.length > SUB_LINE && len === 0) continue; if (len && len + 1 + w.length > SUB_LINE) { lines++; len = w.length; } else len += (len ? 1 : 0) + w.length; }
    return lines <= SUB_LINES;
  };
  // sentences first; a sentence too long for one caption is cut into the fewest parts that fit, of even length,
  // at a comma where one is near; then a short sentence joins its neighbour when they fit together
  const sentences = [];
  let cur = [];
  for (const w of words) { cur.push(w); if (/[.?!]["”’)]?$/.test(w)) { sentences.push(cur); cur = []; } }
  if (cur.length) sentences.push(cur);
  const len = (ws) => ws.join(' ').length;
  const split = (ws) => {
    if (fits(ws)) return [ws];
    for (let parts = Math.max(2, Math.ceil(len(ws) / (SUB_LINES * SUB_LINE))); parts <= ws.length; parts++) {
      const cuts = [];
      let at = 0; const ends = ws.map((w) => (at += w.length + 1) - 1);
      for (let k = 1; k < parts; k++) {
        const target = len(ws) * k / parts;
        let best = null;
        for (let i = 1; i < ws.length; i++) {
          if (cuts.length && i <= cuts.at(-1)) continue;
          const score = Math.abs(ends[i - 1] - target) - (/[,;:—)]$/.test(ws[i - 1]) ? 12 : 0);
          if (best === null || score < best[1]) best = [i, score];
        }
        if (best) cuts.push(best[0]);
      }
      const out = []; let from = 0;
      for (const c of [...cuts, ws.length]) { out.push(ws.slice(from, c)); from = c; }
      if (out.every((x) => x.length && fits(x))) return out;
    }
    return ws.map((w) => [w]);
  };
  const chunks = [];
  for (const sen of sentences.flatMap(split)) {
    const prev = chunks.at(-1);
    if (prev && (len(sen) < 24 || len(prev) < 24) && fits([...prev, ...sen])) prev.push(...sen); else chunks.push([...sen]);
  }
  // each caption's first word: its index in the line, then its time
  const firsts = []; let n = 0;
  for (const c of chunks) { firsts.push(n); n += c.length; }
  const tw = Array.isArray(t?.words) ? t.words : [];
  const exact = tw.length === words.length && Number.isFinite(t?.start);
  const total = text.length;
  const timeOf = (wi) => {
    if (exact && Number.isFinite(tw[wi]?.start)) return round3(start + (tw[wi].start - t.start));
    const chars = words.slice(0, wi).join(' ').length + (wi ? 1 : 0);
    if (tw.length && Number.isFinite(t?.start)) { const j = Math.min(tw.length - 1, Math.round(wi * tw.length / words.length)); if (Number.isFinite(tw[j]?.start)) return round3(start + (tw[j].start - t.start)); }
    return round3(start + (end - start) * chars / total);
  };
  // two even lines when it doesn't fit on one
  const wrap = (ws) => {
    if (len(ws) <= SUB_LINE || SUB_LINES < 2) return ws.join(' ');
    let best = null;
    // even lines, but a break after a sentence or clause wins when it's nearly as even
    for (let i = 1; i < ws.length; i++) { const m = Math.max(len(ws.slice(0, i)), len(ws.slice(i))) + (/[.?!]["”’)]?$/.test(ws[i - 1]) ? 0 : /[,;:—)]$/.test(ws[i - 1]) ? 4 : 10); if (len(ws.slice(0, i)) <= SUB_LINE && len(ws.slice(i)) <= SUB_LINE && (!best || m < best[1])) best = [i, m]; }
    return best ? `${ws.slice(0, best[0]).join(' ')}\n${ws.slice(best[0]).join(' ')}` : ws.join(' ');
  };
  const out = chunks.map((c, i) => ({ node: l.node, part: i + 1, text: form(wrap(c)), start_sec: i === 0 ? start : timeOf(firsts[i]), end_sec: end }));
  for (let i = 0; i + 1 < out.length; i++) out[i].end_sec = out[i + 1].start_sec;
  return out.filter((c) => c.end_sec > c.start_sec);
}

const SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };

// Everything the app needs to build the Mortiflix Studio project once, in-process (doc 38 §1): the sequence, bins, tracks,
// clips (absolute paths, in/out, start, label colour), markers, captions, your assets, older versions, cut shots.
export function handoffPlan(root, id) {
  const project = loadProject(root, id);
  const gv = graphView(root, id);
  const { shots, length_sec } = shotTimeline(root, id, gv);
  const sound = soundTimeline(root, id, gv, shots);
  const byId = Object.fromEntries(gv.nodes.map((n) => [n.id, n]));
  const [width, height] = SIZES[String(project.intake?.answers?.aspect || '16:9').trim()] || SIZES['16:9'];
  const beatBin = (beat) => (beat ? `Shots/${byId[beat] ? `${byId[beat].beat_no ?? ''} ${String(byId[beat].name || byId[beat].title || '').slice(0, 40)}`.trim() : beat}` : 'Shots');
  const label = (n) => n?.colour?.label || null;
  const clips = [];
  for (const s of shots) clips.push({ node: s.node, kind: 'shot', track: 'V1', bin: beatBin(s.beat), name: `${s.label} · ${s.title}`.slice(0, 80), label: label(s), version: s.version, start_sec: s.start_sec, dur_sec: s.dur_sec, media: s.media, preview: s.media.kind !== 'video' });
  const film = gv.order.film;
  for (const tid of gv.order.transitions) {
    const t = byId[tid];
    if (!t || t.state === 'cut' || t.missing) continue;
    const at = shots.find((x) => x.node === t.to);
    if (!at || film.indexOf(t.from) + 1 !== film.indexOf(t.to)) continue;
    const kind = String(t.title || 'Cut');
    const native = /^(cut|crossfade|cross dissolve|dissolve|dip to black)$/i.test(kind.trim());
    clips.push({ node: tid, kind: 'transition', native, transition: native ? (/dip/i.test(kind) ? 'Dip to Black' : /cut/i.test(kind) ? 'Cut' : 'Cross Dissolve') : kind, at_sec: at.start_sec, from: t.from, to: t.to, version: t.plays, name: `${t.label} · ${kind}`, label: null, bin: native ? null : 'Transitions' });
  }
  for (const l of sound.voice) if (l.path) clips.push({ node: l.node, kind: 'line', track: 'A1', bin: 'Voice', name: `${l.label} · ${spoken(l.words).slice(0, 60)}`, label: label(l), version: l.version, start_sec: l.start_sec, dur_sec: l.dur_sec, gain_db: l.gain_db, media: { kind: 'audio', path: l.path } });
  if (sound.music) clips.push({ node: 'music', kind: 'music', track: 'A2', bin: 'Music', name: 'Music', label: null, version: sound.music.version, start_sec: 0, dur_sec: null, media: { kind: 'audio', path: sound.music.path }, cues: sound.cues.map((c) => ({ node: c.node, start_sec: c.start_sec, end_sec: c.end_sec, gain_db: c.gain_db, duck_db: c.duck_db, label: label(c) })) });
  // v3: the Voice step's music cues (ElevenLabs) and the Sound step's approved sounds are clips of their own
  // (2026-11-02, d4fd: the Finish summary said "no music · no effects" over a film with both)
  const workDir = projectPaths(root, id).work;
  if (!sound.music) {
    for (const c of readOr(join(workDir, 'music', 'cues.json'), { cues: [] }).cues || []) {
      if (!c.file || c.state === 'stale' || !existsSync(join(workDir, c.file))) continue;
      clips.push({ node: `music-${c.id}`, kind: 'music', track: 'A2', bin: 'Music', name: `Music ${c.id}${c.mood ? ` · ${String(c.mood).slice(0, 40)}` : ''}`, label: null, version: 1, start_sec: c.from_sec, dur_sec: Math.max(0, (c.to_sec ?? c.from_sec) - c.from_sec), gain_db: c.gain_db ?? null, media: { kind: 'audio', path: join(workDir, c.file) } });
    }
  }
  for (const c of readOr(join(workDir, 'sound', 'sfx-plan.json'), { cues: [] }).cues || []) {
    const f = c.file && existsSync(c.file) ? c.file : c.library_file && existsSync(c.library_file) ? c.library_file : null;
    if (c.status === 'cut' || !f) continue;
    clips.push({ node: `sfx-${c.id}`, kind: 'sfx', track: 'A3', bin: 'Sounds', name: `${c.what || c.id}`.slice(0, 80), label: null, version: 1, start_sec: c.at_sec, dur_sec: c.dur_sec, gain_db: c.gain_db ?? 0, media: { kind: 'audio', path: f } });
  }
  const assets = listAssets(root, id).yours;
  // the newest few older versions of each piece (run 2: 240 of them, every one a whole animatic, went into Edit)
  const older = gv.nodes.flatMap((n) => n.versions.filter((v) => v.path && v.v !== n.plays).slice(-(OLDER_KEPT[n.kind] ?? 1)).map((v) => ({ node: n.id, version: v.v, name: `${n.label} v${v.v}`, label: label(n), path: v.path, from_sec: v.from_sec ?? null, to_sec: v.to_sec ?? null })));
  const cut = gv.nodes.filter((n) => n.kind === 'shot' && n.state === 'cut').map((n) => { const v = n.versions.find((x) => x.v === n.plays); return v?.path ? { node: n.id, version: v.v, name: `${n.label} · ${n.title || ''}`.slice(0, 80), label: label(n), path: v.path, from_sec: v.from_sec ?? null, to_sec: v.to_sec ?? null } : null; }).filter(Boolean);
  const markers = [];
  for (const b of gv.beats) { const s = shots.find((x) => x.beat === b.id); if (s) markers.push({ kind: 'chapter', node: b.id, time_sec: s.start_sec, name: `${b.no} ${String(b.name || b.title).slice(0, 60)}`, label: b.colour?.label || null, comment: b.title }); }
  for (const c of sound.cues) if (c.start_sec !== null) markers.push({ kind: 'comment', node: c.node, time_sec: c.start_sec, name: `${c.label} · ${c.title || ''}`.trim(), label: label(c) });
  // Subtitles: each voice line split into short captions (two lines of at most 42 characters), each timed by the
  // line's word timings (run 3: one caption per line put a whole paragraph over the picture). A line moved over the
  // next one ends its last caption where the next begins (a caption track holds one caption at a time).
  const timing = readOr(join(projectPaths(root, id).work, 'voice', 'timing.json'), { lines: [] });
  const timed = Object.fromEntries((Array.isArray(timing?.lines) ? timing.lines : []).filter((t) => t?.id).map((t) => [t.id, t]));
  // in the script's written form ("Character.AI", "20 million", "$8–9 million"), timed by the spoken words
  const work = projectPaths(root, id).work;
  const forms = writtenForms(work);
  let scriptText = ''; try { scriptText = readFileSync(join(work, 'script.md'), 'utf8'); } catch { /* none */ }
  const money = moneyHints(scriptText);
  const captions = sound.voice.filter((l) => l.dur_sec).flatMap((l) => subtitles(l, timed[l.node], (x) => captionText(x, forms, money)))
    .sort((a, b) => a.start_sec - b.start_sec);
  for (let i = 0; i + 1 < captions.length; i++) if (captions[i].end_sec > captions[i + 1].start_sec) captions[i].end_sec = captions[i + 1].start_sec;
  for (let i = captions.length - 1; i >= 0; i--) if (!(captions[i].end_sec > captions[i].start_sec)) captions.splice(i, 1);
  const tracks = ['V2 Your assets', 'V1 Shots', 'A1 Voice', 'A2 Music', 'A3 Sounds', 'C1 Captions'].filter((t) => (t.startsWith('V1')) || (t.startsWith('A1') && sound.voice.some((l) => l.path)) || (t.startsWith('A2') && clips.some((c) => c.kind === 'music')) || (t.startsWith('A3') && clips.some((c) => c.kind === 'sfx')) || (t.startsWith('C1') && captions.length) || (t.startsWith('V2') && false));
  return {
    format: 'mortiflix.handoff', version: 1, project: id, title: project.title, rev: gv.rev, fcproj: handoffFcproj(root, id, project.title),
    sequence: { name: project.title, width, height, fps: gv.fps || 30, length_sec },
    tracks, bins: ['Shots', ...new Set(clips.filter((c) => c.bin?.startsWith('Shots/')).map((c) => c.bin)), 'Transitions', 'Voice', 'Music', 'Music stems', 'Sounds', 'Your assets', 'Older versions', 'Cut on the board'],
    clips, markers, captions, caption_style: SUB_STYLE,
    your_assets: assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, path: a.path, bin: `Your assets/${a.kind}`, used_in: a.used_in })),
    older_versions: older, cut_on_board: cut,
    notes: `Mortiflix project ${id}, graph rev ${gv.rev}. Click a clip, then ask in the Mortiflix panel.`,
    previews: shots.filter((s) => s.media.kind !== 'video').length,
  };
}

// Where the app saves the Mortiflix Studio project: the one it saved before, else beside the project's record
// (`<studio>/state/<id>/edit/<title>.mortiflix`, the title kept to letters, digits, space, `-`, `_` and `.`).
export function handoffFcproj(root, id, title) {
  const saved = loadHandoff(root, id)?.fcproj;
  if (saved) return saved;
  const name = Array.from(String(title || '')).filter((c) => /[\p{L}\p{N} ._-]/u.test(c)).join('').trim().slice(0, 120) || 'Mortiflix';
  return join(projectPaths(root, id).state, 'edit', `${name}.mortiflix`);
}

// What the app imported (doc 38 "done once"): saved so later versions are swapped in, never rebuilt.
export function saveHandoff(root, id, map) {
  if (!map || typeof map !== 'object' || !Array.isArray(map.clips)) throw new CanvasError('handoff.done needs {clips: [{node, version, clip?, item?}]}');
  const clean = { project: id, rev: Number(map.rev) || null, fcproj: map.fcproj ? String(map.fcproj).slice(0, 2000) : null, made_at: new Date().toISOString(),
    clips: map.clips.slice(0, 20_000).filter((c) => c && NODE_ID.test(String(c.node || '')) || c?.node === 'music').map((c) => ({ node: String(c.node), version: Number(c.version) || null, clip: c.clip ?? null, item: c.item ?? null })) };
  save(files(root, id).app, clean);
  event(root, id, { event: 'EDIT_IMPORTED', actor: 'you', details: `${clean.clips.length} clips into the app` });
  return clean;
}

export const loadHandoff = (root, id) => readOr(files(root, id).app, null);

// Pieces whose playing version is newer than the one in the app: the app swaps each in (clip.replaceFromBin).
export function handoffSwaps(root, id) {
  const map = loadHandoff(root, id);
  if (!map) return { imported: false, swaps: [] };
  const gv = graphView(root, id);
  const byId = Object.fromEntries(gv.nodes.map((n) => [n.id, n]));
  const swaps = [];
  for (const c of map.clips) {
    const n = byId[c.node];
    if (!n || n.plays === null || n.plays === c.version) continue;
    const v = n.versions.find((x) => x.v === n.plays);
    if (v?.path) swaps.push({ node: n.id, from_version: c.version, version: n.plays, clip: c.clip, item: c.item, path: v.path, from_sec: v.from_sec ?? null, to_sec: v.to_sec ?? null, name: `${n.label} v${n.plays}` });
  }
  return { imported: true, swaps, rev: gv.rev };
}

export function markSwapped(root, id, nid, version, { clip = undefined, item = undefined } = {}) {
  const f = files(root, id);
  const map = loadHandoff(root, id);
  if (!map) throw new CanvasError('nothing is in Mortiflix Studio yet');
  const c = map.clips.find((x) => x.node === nid);
  if (!c) throw new CanvasError(`${nid} isn't in Mortiflix Studio`);
  c.version = Number(version) || c.version;
  if (clip !== undefined) c.clip = clip;
  if (item !== undefined) c.item = item;
  save(f.app, map);
  event(root, id, { event: 'EDIT_UPDATED', actor: 'studio', details: `${nid} v${c.version} swapped into the app` });
  return c;
}

export function findNodes(root, id, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  return graphView(root, id).nodes.filter((n) => !n.missing && [n.id, n.label, n.title].some((x) => String(x || '').toLowerCase().includes(q))).slice(0, 50).map((n) => ({ id: n.id, kind: n.kind, label: n.label, title: n.title, beat_no: n.beat_no }));
}

export const hasHandoff = (root, id) => existsSync(files(root, id).app);
