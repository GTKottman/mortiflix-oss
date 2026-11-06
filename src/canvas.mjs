// The canvas's project graph: every piece of a project (beats of the script, style frames, shots, voice lines, music
// sections, transitions) as one node with a stable id, its beat's colour and every version it has had. The shot board,
// the node view and the Mortiflix Studio hand-off all read this one graph.
//
// Sessions write plain files in their working folder (script/beats.json, design/frames.json, out/scenes.json,
// voice/lines.json, music/blueprint.json, transitions/board.json). `syncCanvas` reads them, copies each new version's
// media into the project's record (state/<id>/canvas/media/, so a later re-render can't change what the owner saw) and
// saves the graph in state/<id>/canvas/graph.json. Ids are forever: a node keeps its id and colour for life.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, realpathSync, statSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { sceneGaps, gapsText } from './scenes.mjs';
import { projectPaths, update, event, projectPipeline, loadProject } from './projects.mjs';
import { settle, GateError, stepView, respond } from './gates.mjs';
import { withLock, isInside, writeJson } from './studio.mjs';
import { musicHeld } from './svc/musicneed.mjs';

// One Mortiflix Studio label colour per beat, in order (crates/project Label::rgb / marker_rgb, v0.8.0). Their marker colours
// all differ; Yellow is left out because text on its fill fails contrast. The beat number always sits beside it.
export const BEAT_COLOURS = [
  { label: 'Violet', hex: '#380ea7', chip: '#a98caf' },
  { label: 'Mango', hex: '#803f17', chip: '#da7639' },
  { label: 'Teal', hex: '#1f4d45', chip: '#72f0d7' },
  { label: 'Rose', hex: '#801836', chip: '#c13c3d' },
  { label: 'Blue', hex: '#192d94', chip: '#568bf4' },
  { label: 'Forest', hex: '#404a11', chip: '#758542' },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// A video still being written (a render streams the animatic out): versioned on a later sync, once whole.
const BUSY = Symbol('busy');
// Media hashes by file: { size, mtimeMs, sha }, so an unchanged file is never read again.
const HASHED = new Map();
// An MP4/MOV is whole when its top-level boxes tile the file and one is the movie box (encoders write it last, or
// move it to the front when they finish). Only box headers are read.
export function mp4Unfinished(file) {
  if (!/\.(mp4|m4v|mov)$/i.test(file)) return false;
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const h = Buffer.alloc(16);
    let at = 0;
    let moov = false;
    for (let i = 0; i < 10000 && at < size; i++) {
      if (readSync(fd, h, 0, 16, at) < 8) return true;
      let len = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      if (len === 1) len = Number(h.readBigUInt64BE(8));
      else if (len === 0) len = size - at;
      if (len < 8) return true;
      if (type === 'moov') moov = true;
      at += len;
    }
    return !(moov && at === size);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  }
}

// Any media file still being written: empty (just created), a WAV whose header promises more than is there yet, or an
// unfinished MP4 (run 3: a voice line remade by a Fix got an empty version, then the real one a moment later).
export function mediaUnfinished(file) {
  try {
    const size = statSync(file).size;
    if (size === 0) return true;
    if (/\.wav$/i.test(file)) {
      if (size < 12) return true;
      const fd = openSync(file, 'r');
      try {
        const h = Buffer.alloc(12);
        readSync(fd, h, 0, 12, 0);
        if (h.toString('latin1', 0, 4) === 'RIFF' && h.readUInt32LE(4) !== 0xffffffff && h.readUInt32LE(4) + 8 > size) return true;
      } finally { closeSync(fd); }
    }
  } catch {
    return false;
  }
  return mp4Unfinished(file);
}

export function canvasPaths(root, id) {
  const dir = join(projectPaths(root, id).state, 'canvas');
  return { dir, graph: join(dir, 'graph.json'), media: join(dir, 'media'), lock: join(dir, '.lock'), owner: join(dir, 'owner.json'), edits: join(dir, 'edits.json') };
}

export function loadGraph(root, id) {
  const f = canvasPaths(root, id).graph;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

// A file a session wrote, only if it really is inside its working folder (no symlink out).
function workFile(work, rel) {
  if (!rel || typeof rel !== 'string') return null;
  const f = join(work, rel);
  if (!existsSync(f)) return null;
  const real = realpathSync(f);
  return isInside(realpathSync(work), real) && statSync(real).isFile() ? real : null;
}

function readJson(work, rel, problems) {
  const f = workFile(work, rel);
  if (!f) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { problems.push({ file: rel, text: `can't be read: ${e.message}` }); return null; }
}

// The beats: script/beats.json, or the script's own "B01 · words" paragraphs.
export function readBeats(work, problems) {
  const j = readJson(work, 'script/beats.json', problems);
  // `name`: the beat's short title when the session (or the owner) gave it one (svc/beatnames.mjs names the rest)
  if (j?.beats?.length) return j.beats.filter((b) => /^b\d{2,3}$/.test(b.id)).map((b) => ({ id: b.id, words: String(b.words || ''), visual: b.visual ? String(b.visual) : null, target_sec: b.target_sec ?? null, ...(typeof (b.name ?? b.title) === 'string' && String(b.name ?? b.title).trim() ? { name: String(b.name ?? b.title).trim().slice(0, 80) } : {}) }));
  const f = workFile(work, 'script.md');
  if (!f) return [];
  const out = [];
  for (const para of readFileSync(f, 'utf8').split(/\n\s*\n/)) {
    const m = para.trim().match(/^B(\d{2,3})\s*·\s*([\s\S]*)$/);
    if (!m) continue;
    const [words, ...rest] = m[2].split('\n');
    out.push({ id: `b${m[1]}`, words: words.trim(), visual: rest.join(' ').replace(/^\*?Visual:\s*/i, '').replace(/\*$/, '').trim() || null, target_sec: null });
  }
  return out;
}

export function syncCanvas(root, id) {
  const pp = projectPaths(root, id);
  const cp = canvasPaths(root, id);
  mkdirSync(cp.media, { recursive: true });
  return withLock(cp.lock, () => {
    const prev = loadGraph(root, id) || { nodes: {}, colours: {} };
    const before = JSON.parse(JSON.stringify(prev));
    const problems = [];
    const nodes = prev.nodes || {};
    const colours = prev.colours || {};
    const seen = new Set();
    const work = pp.work;

    const colourOf = (beat) => {
      if (!beat) return null;
      if (colours[beat] === undefined) colours[beat] = Object.keys(colours).length;
      return BEAT_COLOURS[colours[beat] % BEAT_COLOURS.length];
    };
    // Add a version when the content behind a node changed (its media's or its text's hash).
    const put = (nid, kind, fields, version) => {
      seen.add(nid);
      // its file is still being written: keep the node as it is until the file settles
      if (version === BUSY) {
        if (nodes[nid]) Object.assign(nodes[nid], fields, { kind, colour: colourOf(fields.beat) });
        else if (kind === 'shot') nodes[nid] = { id: nid, ...fields, kind, colour: colourOf(fields.beat), planned: true, versions: [], current: null };
        return nodes[nid];
      }
      const n = nodes[nid] || { id: nid, kind, versions: [] };
      Object.assign(n, fields, { kind, colour: colourOf(fields.beat) });
      delete n.planned; // a planned shot (before the animatic) is real once it has a version
      if (!n.versions.some((v) => v.sha === version.sha)) n.versions.push({ v: n.versions.length + 1, made_at: new Date().toISOString(), ...version });
      n.current = n.versions.at(-1).v;
      nodes[nid] = n;
      return n;
    };
    // Copy a media file into the record once, named by its content.
    const snapshot = (rel, nid) => {
      const f = workFile(work, rel);
      if (!f) { problems.push({ file: rel, text: `doesn't exist (${nid})` }); return null; }
      // A video still being written: copying it made a version per sync, each a cut-off video (run 2: 13 broken
      // versions of every shot in 5 s while the animatic rendered)
      if (mediaUnfinished(f)) return BUSY;
      // Hash a file only when it changed (size or time): every sync hashed every clip and the whole score again
      // (a 26 min project: ~1 s per request, and the requests queued up behind each other).
      const st = statSync(f);
      const known = HASHED.get(f);
      let h;
      if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) h = known.sha;
      else {
        h = sha(readFileSync(f));
        HASHED.set(f, { size: st.size, mtimeMs: st.mtimeMs, sha: h });
      }
      const name = `${h.slice(0, 16)}${extname(f).toLowerCase()}`;
      const dest = join(cp.media, nid, name);
      if (!existsSync(dest)) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(f, dest); }
      return { sha: h, file: `canvas/media/${nid}/${name}` };
    };

    const beats = readBeats(work, problems);
    beats.forEach((b, i) => {
      put(b.id, 'beat', { label: b.id.toUpperCase(), beat: b.id, order: i, title: b.words, visual: b.visual, target_sec: b.target_sec },
        { sha: sha(`${b.words}\n${b.visual || ''}`), text: b.words, visual: b.visual });
    });
    const beatIds = new Set(beats.map((b) => b.id));

    const frames = readJson(work, 'design/frames.json', problems)?.frames || [];
    frames.forEach((f, i) => {
      if (!/^sf\d{2,3}$/.test(f.id)) return problems.push({ file: 'design/frames.json', text: `frame id "${f.id}" should look like sf01` });
      const s = snapshot(f.file, f.id);
      if (s) put(f.id, 'frame', { label: f.label || f.id.toUpperCase(), beat: (f.beats || [])[0] || null, beats: f.beats || [], order: i }, s);
    });

    // Shots: one video cut into scenes. The video is snapshotted once; each shot plays its own seconds of it.
    const scenes = readJson(work, 'out/scenes.json', problems);
    if (scenes?.scenes?.length) {
      const src = snapshot(scenes.made_from, 'video');
      const fps = Number(scenes.fps) || 30;
      if (src) {
        scenes.scenes.forEach((sc, i) => {
          if (!/^s\d{2,3}$/.test(sc.key)) return problems.push({ file: 'out/scenes.json', text: `scene key "${sc.key}" should look like s01` });
          if (sc.beat && !beatIds.has(sc.beat)) problems.push({ file: 'out/scenes.json', text: `${sc.key}: beat ${sc.beat} isn't in the script` });
          // at_sec: where the shot starts in the animatic (the film as the AI timed it), also once it is remade alone
          // (a shot remade alone keeps its scene's place when the scenes are still cut from the animatic)
          const inAnimatic = !sc.file || sc.file !== scenes.made_from;
          const at = Number.isFinite(Number(sc.from_frame)) && inAnimatic ? +(Number(sc.from_frame) / fps).toFixed(3) : (nodes[sc.key]?.at_sec ?? null);
          const fields = { label: sc.key.toUpperCase(), title: sc.name || sc.key, beat: sc.beat || null, order: i, at_sec: at, look: frames.find((f) => (f.beats || []).includes(sc.beat))?.id || null };
          // A shot remade on its own (an edit request) arrives as its own file; the others are cut from the video.
          const own = sc.file ? snapshot(sc.file, sc.key) : null;
          if (own === BUSY || (src === BUSY && !own)) return put(sc.key, 'shot', fields, BUSY);
          if (own) return put(sc.key, 'shot', fields, { ...own, from_sec: 0, to_sec: +(sc.frames / fps).toFixed(3) });
          const from = +(sc.from_frame / fps).toFixed(3);
          const to = +((sc.from_frame + sc.frames) / fps).toFixed(3);
          put(sc.key, 'shot', fields, { sha: `${src.sha}:${sc.from_frame}:${sc.frames}`, file: src.file, from_sec: from, to_sec: to });
        });
      }
      // A beat with no scene yet (one shot made alone, before the animatic): its planned shot stays in the film, and
      // the shots go in beat order (run 2: S08 remade first left out/scenes.json with only s08, and the film was "1/1")
      // Only then: an animatic (shots cut from one video) is the film as the AI cut it, and a beat it folded into another
      // shot ("Fan and cap") has no shot of its own
      const keys = new Set(scenes.scenes.map((sc) => sc.key));
      const covered = new Set(scenes.scenes.map((sc) => sc.beat).filter(Boolean));
      const alone = scenes.scenes.every((sc) => sc.file);
      const gaps = beats.filter((b) => !covered.has(b.id) && !keys.has(`s${b.id.slice(1)}`));
      // an animatic that left a beat without a shot is a problem to fix, never the film as cut (run 2: beat 7 was
      // folded into shot 6; the film had 7 shots for 8 beats): the beat keeps its planned shot and the stage says so
      if (!alone && gaps.length) problems.push({ file: 'out/scenes.json', text: gapsText(gaps), beats: gaps.map((b) => b.id) });
      if (gaps.length) {
        for (const b of gaps) {
          const look = frames.find((f) => (f.beats || []).includes(b.id));
          const sid = `s${b.id.slice(1)}`;
          seen.add(sid);
          if (nodes[sid]?.versions?.some((v) => v.file)) continue;
          nodes[sid] = { ...(nodes[sid] || {}), id: sid, kind: 'shot', label: sid.toUpperCase(), title: b.words, beat: b.id, look: look?.id || null, colour: colourOf(b.id), planned: true, versions: [], current: null };
        }
        const beatAt = new Map(beats.map((b, i) => [b.id, i]));
        const sceneAt = new Map(scenes.scenes.map((sc, i) => [sc.key, i]));
        [...seen].filter((id) => nodes[id]?.kind === 'shot')
          .sort((a, b) => (beatAt.get(nodes[a].beat) ?? 1e9) - (beatAt.get(nodes[b].beat) ?? 1e9) || (sceneAt.get(a) ?? -1) - (sceneAt.get(b) ?? -1))
          .forEach((id, i) => { nodes[id].order = i; });
      }
    } else {
      // Before the animatic: one planned shot per beat, its style frame as the still.
      beats.forEach((b, i) => {
        const look = frames.find((f) => (f.beats || []).includes(b.id));
        const sid = `s${b.id.slice(1)}`;
        if (nodes[sid]?.versions?.some((v) => v.file)) { seen.add(sid); return; }
        seen.add(sid);
        nodes[sid] = { ...(nodes[sid] || {}), id: sid, kind: 'shot', label: sid.toUpperCase(), title: b.words, beat: b.id, order: i, look: look?.id || null, colour: colourOf(b.id), planned: true, versions: [], current: null };
      });
    }

    const lines = readJson(work, 'voice/lines.json', problems);
    const timing = Object.fromEntries((readJson(work, 'voice/timing.json', problems)?.lines || []).map((t) => [t.id, t]));
    for (const [i, l] of (Array.isArray(lines) ? lines : lines?.lines || []).entries()) {
      if (!l?.id) continue;
      const beat = String(l.id).match(/^(b\d{2,3})-/)?.[1] || null;
      const clip = [l.file, `voice/clips/${l.id}.wav`, `voice/clips/${l.id}.mp3`].find((c) => c && workFile(work, c));
      const s = clip ? snapshot(clip, l.id) : null;
      const t = timing[l.id];
      put(l.id, 'line', { label: l.id, title: String(l.script || l.text || ''), beat, order: i, start_sec: t?.start ?? null, end_sec: t?.end ?? null }, s || { sha: sha(String(l.script || l.text || '')), file: null });
    }
    // The music as mixed (a video's score, or the owner's own master), for the Mortiflix Studio hand-off's music track.
    const mix = ['music/own-master/master.wav', 'out/music/master.wav', 'out/music/score.wav'].find((f) => workFile(work, f));
    if (mix) put('music', 'music', { label: 'Music', title: 'The music', beat: null, order: 0 }, snapshot(mix, 'music'));

    const bp = readJson(work, 'music/blueprint.json', problems);
    // Once the song exists (doc 18 §4), the cues are its sections: title and bars from it, and a new version whenever
    // its notes or its parts' instruments change. Before that, from the blueprint.
    const song = workFile(work, 'music/song.json') ? readJson(work, 'music/song.json', problems) : null;
    if (song?.patterns?.length) {
      const m = song.meter?.[0] || { num: 4, den: 4 };
      const tpb = (song.ppq || 960) * 4 * m.num / m.den;
      const items = (song.playlist?.items || []).filter((x) => x.kind === 'pattern').sort((a, b) => a.at.tick - b.at.tick);
      const instruments = (song.channels || []).map((c) => [c.id, c.instrument?.blob || c.instrument?.name || null]);
      items.forEach((it, i) => {
        const p = song.patterns.find((x) => x.id === it.ref);
        if (!p) return;
        const sec = (bp?.sections || []).find((x) => x.id === p.id) || (bp?.sections || [])[i] || {};
        const start = it.at.tick / tpb + 1;
        put(p.id, 'cue', { label: p.id.toUpperCase(), title: p.name || sec.name || p.id, beat: sec.beat || null, order: i, bars: [start, start + it.len / tpb - 1], intensity: sec.intensity ?? null },
          { sha: sha(JSON.stringify([p.notes, p.bars, instruments])) });
      });
    } else {
      (bp?.sections || []).forEach((sec, i) => {
        const mid = sec.id || `m${String(i + 1).padStart(2, '0')}`;
        put(mid, 'cue', { label: mid.toUpperCase(), title: sec.name, beat: sec.beat || null, order: i, bars: [sec.start_bar, sec.end_bar], intensity: sec.intensity ?? null }, { sha: sha(JSON.stringify(sec)) });
      });
    }

    const board = readJson(work, 'transitions/board.json', problems);
    const ends = cutEnds(nodes, frames);
    (board?.cuts || []).forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const tid = /^t\d{2,3}$/.test(String(c.id || '')) ? c.id : `t${String(i + 1).padStart(2, '0')}`;
      const [from, to] = ends(c);
      // its picture or clip: what the board names, else the board's own render (out/board/cut-01.mp4 / .png)
      const n2 = String(i + 1).padStart(2, '0');
      const rel = [c.file, c.video, c.clip, c.preview, `out/board/cut-${n2}.mp4`, `out/board/cut-${n2}.webm`, `out/board/cut-${n2}.png`, `out/board/cut-${n2}.jpg`]
        .find((x) => typeof x === 'string' && workFile(work, x));
      const media = rel ? snapshot(rel, tid) : null;
      if (media === BUSY) { put(tid, 'transition', { label: tid.toUpperCase(), title: transitionName(c), from, to, order: i }, BUSY); return; }
      put(tid, 'transition', { label: tid.toUpperCase(), title: transitionName(c), from, to, order: i, beat: to ? nodes[to]?.beat || null : null },
        { sha: sha(JSON.stringify(c) + (media?.sha || '')), ...(media ? { file: media.file } : {}) });
    });

    // Ids are forever: a node that disappeared from the files stays, marked missing, never deleted.
    for (const [nid, n] of Object.entries(nodes)) n.missing = !seen.has(nid) || undefined;

    const same = before.rev && JSON.stringify({ nodes: before.nodes, problems: before.problems, colours: before.colours }) === JSON.stringify({ nodes, problems, colours });
    if (same) return before;
    const order = (kind) => Object.values(nodes).filter((n) => n.kind === kind && !n.missing).sort((a, b) => a.order - b.order).map((n) => n.id);
    const graph = {
      format: 'mortiflix.canvas', version: 1, project: id, rev: (prev.rev || 0) + 1, built_at: new Date().toISOString(),
      order: { beats: order('beat'), shots: order('shot'), frames: order('frame'), lines: order('line'), cues: order('cue'), transitions: order('transition') },
      // the video's frame rate (from the scenes), for the music's one-frame rule on cuts
      fps: scenes?.fps ? Number(scenes.fps) : null,
      colours, nodes, problems,
    };
    writeJson(cp.graph, graph);
    return graph;
  });
}

// A transition's name: the board's `transition` (a string, or {new, inspired_by} for a new one), else its name/style.
function transitionName(c) {
  const t = c.transition;
  const name = typeof t === 'string' ? t : t && typeof t === 'object' ? t.new || t.name || t.kind : null;
  return String(name || c.name || c.style || 'cut').replace(/[-_]+/g, ' ').trim().slice(0, 80) || 'cut';
}

// Which cut of the film a board transition sits on (the shot before → the shot after). Boards say it in several
// ways: shot ids (`from_scene`/`to_scene`, or s03 in `from`/`to`), the beat it lands on (`lands_on: "… in B03"`,
// `to_beat`), or the style frames on either side (`from: "SF01 · Opening"`, `to: "SF02 · …"`: the cut into the
// first shot of the next frame's beats). Unknown = [null, null] (it shows on no cut).
function cutEnds(nodes, frames) {
  const shots = Object.values(nodes).filter((n) => n.kind === 'shot').sort((a, b) => a.order - b.order).map((n) => n.id);
  const shotOf = (v) => { const m = String(v ?? '').match(/\b(s\d{2,3})\b/i); return m && nodes[m[1].toLowerCase()]?.kind === 'shot' ? m[1].toLowerCase() : null; };
  const beatOf = (v) => String(v ?? '').match(/\b(b\d{2,3})\b/i)?.[1]?.toLowerCase() || null;
  const frameOf = (v) => String(v ?? '').match(/\b(sf\d{2,3})\b/i)?.[1]?.toLowerCase() || null;
  const firstShotOf = (beat) => shots.find((s) => nodes[s].beat === beat) || null;
  const into = (to) => { const i = shots.indexOf(to); return i > 0 ? [shots[i - 1], to] : [null, null]; };
  return (c) => {
    if (shotOf(c.from_scene) && shotOf(c.to_scene)) return [shotOf(c.from_scene), shotOf(c.to_scene)];
    if (shotOf(c.from) && shotOf(c.to)) return [shotOf(c.from), shotOf(c.to)];
    const beat = beatOf(c.to_beat) || beatOf(c.lands_on) || beatOf(c.to);
    if (beat && firstShotOf(beat)) return into(firstShotOf(beat));
    const f = frameOf(c.to);
    const fr = f && frames.find((x) => x?.id === f);
    const first = f ? (fr?.beats || []).map(firstShotOf).find(Boolean) || shots.find((s) => nodes[s].look === f) : null;
    if (first) return into(first);
    return [null, null];
  };
}

// ---- what the owner does on the canvas, and the edit requests it makes ----

// The owner's decisions and the edit list: a missing file is the empty default; a file that is there but cannot be
// read or parsed is an error (code state_corrupt), never an empty default, so the next save cannot wipe the OK/Cut
// decisions or restart the edit ids at E001 over the damaged file. The file is left as it is for repair.
const readOr = (f, dflt) => {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return dflt; throw Object.assign(new Error(`${f} cannot be read (${e.code || e.message})`), { code: 'state_corrupt', file: f }); }
  try { return JSON.parse(text); } catch (e) { throw Object.assign(new Error(`${f} is damaged and was not changed: ${e.message}`), { code: 'state_corrupt', file: f }); }
};

export function loadOwner(root, id) { return readOr(canvasPaths(root, id).owner, { decisions: {} }); }
export function loadEdits(root, id) { return readOr(canvasPaths(root, id).edits, { edits: [] }).edits; }
export const readEdits = loadEdits;
const openOf = (edits) => edits.filter((e) => ['requested', 'working'].includes(e.state));

// The graph as the canvas shows it: every node with the owner's decision and any edit on it, and its state.
export function canvasView(root, id) {
  const g = syncCanvas(root, id);
  const owner = loadOwner(root, id);
  const edits = loadEdits(root, id);
  const nodes = {};
  for (const [nid, n] of Object.entries(g.nodes)) {
    const decision = owner.decisions[nid]?.verdict || null;
    const pending = openOf(edits).filter((e) => e.node === nid).at(-1) || null;
    const failed = !pending && edits.filter((e) => e.node === nid).at(-1)?.state === 'failed' ? edits.filter((e) => e.node === nid).at(-1) : null;
    const made = Boolean(n.versions?.length);
    const state = decision === 'cut' ? 'cut' : pending ? 'generating' : failed ? 'needs you' : decision === 'ok' && made ? 'approved' : n.planned ? 'generating' : 'ready';
    nodes[nid] = { ...n, owner: decision, pending, failed, state, edits: edits.filter((e) => e.node === nid).map(({ id: eid, text, state: st, version, at }) => ({ id: eid, text, state: st, version, at })) };
  }
  return { ...g, nodes, open_edits: openOf(edits).length };
}

// OK, Cut it (and taking either back) are the owner's decisions; Fix makes an edit request that starts a session at
// once, so the AI remakes that one piece while the owner keeps going.
// A Fix on a section can name bars inside it (1-based, [from, to]) and a part (channel id): doc 26 §3.
export function nodeAction(root, id, nid, { action, text, bars = null, part = null, write = false } = {}) {
  const g = syncCanvas(root, id);
  const node = g.nodes[nid];
  if (!node) throw new CanvasError(`no piece ${nid} on this canvas`);
  const cp = canvasPaths(root, id);
  // An OK is on a made piece: a shot that isn't made yet has nothing to OK (owner's first run: "4 OK" on plans)
  if (action === 'ok' && !node.versions?.length) throw new CanvasError(`${node.label} isn't made yet: OK it once it exists`);
  return withLock(cp.lock, () => {
    const owner = loadOwner(root, id);
    if (['ok', 'cut'].includes(action)) owner.decisions[nid] = { verdict: action, version: node.current, at: new Date().toISOString() };
    else if (action === 'clear') delete owner.decisions[nid];
    else if (action === 'fix') {
      const words = String(text || '').trim().slice(0, 4000);
      if (!words) throw new CanvasError('say what to change');
      const all = loadEdits(root, id);
      if (bars !== null) {
        const len = node.bars ? node.bars[1] - node.bars[0] + 1 : Infinity;
        if (node.kind !== 'cue' || !Array.isArray(bars) || bars.length !== 2 || !bars.every(Number.isInteger) || bars[0] < 1 || bars[1] < bars[0] || bars[1] > len) throw new CanvasError(`bars must be [from, to] inside ${node.label} (1–${len})`);
      }
      if (part !== null && !/^ch\d{2,}$/.test(String(part))) throw new CanvasError('part must be a channel id like ch02');
      const edit = { id: `E${String(all.length + 1).padStart(3, '0')}`, node: nid, kind: node.kind, label: node.label, beat: node.beat || null,
        ...(bars ? { bars } : {}), ...(part ? { part } : {}), ...(write ? { write: true } : {}), text: words, from_version: node.current, state: 'requested', at: new Date().toISOString() };
      all.push(edit);
      writeJson(cp.edits, { edits: all });
      delete owner.decisions[nid];
      writeJson(cp.owner, owner);
      syncEditCount(root, id, all);
      event(root, id, { event: 'EDIT_REQUESTED', actor: 'you', details: `${edit.id} on ${node.label}: ${words.slice(0, 200)}` });
      return { edit };
    } else throw new CanvasError('action: ok, cut, clear or fix');
    writeJson(cp.owner, owner);
    event(root, id, { event: action === 'clear' ? 'CANVAS_CLEARED' : action === 'ok' ? 'CANVAS_OK' : 'CANVAS_CUT', actor: 'you', details: node.label });
    return { decision: owner.decisions[nid] || null, approved: action === 'clear' ? null : approveWhenAllDecided(root, id, g, owner, node.kind) };
  });
}

// "If one is okay then it'll go to the next": when every piece of a canvas step waiting for the owner is OK or cut,
// the step is approved, exactly as if the owner pressed Approve in the review room.
function approveWhenAllDecided(root, id, g, owner, kind) {
  const step = stepView(loadProject(root, id), projectPipeline(root, id)).find((s) => s.canvas === kind && s.state === 'in_review');
  if (!step) return null;
  const pieces = Object.values(g.nodes).filter((n) => n.kind === kind && !n.missing && !n.planned);
  if (!pieces.length || !pieces.every((n) => ['ok', 'cut'].includes(owner.decisions[n.id]?.verdict))) return null;
  // v3: the voice step makes the music too; every line OK'd waits until every music cue is made and OK'd
  if (step.key === 'voice' && musicHeld(root, id)) return null;
  const cut = pieces.filter((n) => owner.decisions[n.id].verdict === 'cut').map((n) => n.label);
  respond(root, id, step.key, step.version, { verdict: 'approve', overall: cut.length ? `Approved on the canvas. Cut: ${cut.join(', ')}.` : 'Approved on the canvas: every piece OK.' });
  return step.key;
}

// The music's last cue OK'd: the voice step is approved when every line is OK or cut too (the line OKs came first).
export function approveIfAllDecided(root, id, kind = 'line') {
  const g = syncCanvas(root, id);
  return withLock(canvasPaths(root, id).lock, () => approveWhenAllDecided(root, id, g, loadOwner(root, id), kind));
}

// The session reports an edit: done only once its piece really has a new version (sync shows it), or failed.
export function finishEdit(root, id, eid, { ok, note = '', via = null } = {}) {
  const g = syncCanvas(root, id);
  const cp = canvasPaths(root, id);
  return withLock(cp.lock, () => {
    const all = loadEdits(root, id);
    const e = all.find((x) => x.id === eid);
    if (!e) throw new CanvasError(`no edit request ${eid}`);
    if (!['requested', 'working', 'fast'].includes(e.state)) throw new CanvasError(`${eid} is already ${e.state}`);
    if (ok) {
      const n = g.nodes[e.node];
      if (!n || !(n.current > e.from_version)) throw new CanvasError(`${e.label} has no new version yet (still v${e.from_version}): write it where the canvas reads it (GATES.md, "The canvas"), then say edit done`);
      if (e.kind === 'shot') {
        const gaps = sceneGaps(projectPaths(root, id).work);
        if (gaps.length) throw new CanvasError(gapsText(gaps));
      }
      e.version = n.current;
    }
    e.state = ok ? 'done' : 'failed';
    if (via) e.via = via;
    e.note = String(note || '').slice(0, 2000);
    e.finished_at = new Date().toISOString();
    writeJson(cp.edits, { edits: all });
    syncEditCount(root, id, all);
    event(root, id, { event: ok ? 'EDIT_DONE' : 'EDIT_FAILED', details: `${eid} on ${e.label}${note ? `: ${String(note).slice(0, 200)}` : ''}` });
    // A scene remade by a Fix becomes its new version on the Motion screen (clips.json, versions, the joined animatic).
    if (ok && e.kind === 'shot') {
      setImmediate(() => import('./quickanimatic.mjs')
        .then((q) => q.syncSceneEdits(projectPaths(root, id).work))
        .then((d) => { for (const x of d) event(root, id, { event: 'SCENE_VERSION', details: `${x.beat}: ${x.file} is the scene's new version` }); })
        .catch((err) => event(root, id, { event: 'SCENE_VERSION_FAILED', details: `${e.label}: ${err.message}` })));
    }
    // A piece that is in the Mortiflix Studio project gets its new version there too (studio-edit.mjs), right after.
    if (ok) {
      setImmediate(() => import('./studio-edit.mjs')
        .then((f) => f.swapIntoEdit(root, id, e.node))
        .then((r) => { if (r.swapped) event(root, id, { event: 'EDIT_UPDATED', details: `${e.label} v${r.version} replaced its clip in Mortiflix Studio (${r.via === 'app' ? 'the open app' : 'the project file'})` }); })
        .catch((err) => event(root, id, { event: 'EDIT_UPDATE_FAILED', details: `${e.label}: ${err.message}` })));
    }
    return e;
  });
}

export const openEdits = (root, id) => openOf(loadEdits(root, id));

// An edit request for a piece that doesn't exist yet (a duplicated or inserted shot, doc 35): its node is the new id,
// at version 0, so it is done once a session writes that piece (finishEdit's "has a new version" rule).
export function requestNewPiece(root, id, { node, kind, label, beat = null, op, after = null, text }) {
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(String(node || ''))) throw new CanvasError(`bad piece id ${node}`);
  const words = String(text || '').trim().slice(0, 4000);
  if (!words) throw new CanvasError('say what the new piece is');
  const cp = canvasPaths(root, id);
  mkdirSync(cp.dir, { recursive: true });
  return withLock(cp.lock, () => {
    const all = loadEdits(root, id);
    const edit = { id: `E${String(all.length + 1).padStart(3, '0')}`, node, kind, label: label || node.toUpperCase(), beat, op, ...(after ? { after } : {}),
      text: words, from_version: 0, state: 'requested', at: new Date().toISOString() };
    all.push(edit);
    writeJson(cp.edits, { edits: all });
    syncEditCount(root, id, all);
    event(root, id, { event: 'EDIT_REQUESTED', actor: 'you', details: `${edit.id} new ${edit.label} (${op}${after ? ` after ${after.toUpperCase()}` : ''}): ${words.slice(0, 200)}` });
    return edit;
  });
}

// The Fix fast path (doc 28 §4) holds an edit as 'fast' while it tries, so no session starts for it; it goes back to
// 'requested' (with what was tried) when the fast path gives up.
export function setEditState(root, id, eid, state, extra = {}) {
  const cp = canvasPaths(root, id);
  return withLock(cp.lock, () => {
    const all = loadEdits(root, id);
    const e = all.find((x) => x.id === eid);
    if (!e) throw new CanvasError(`no edit request ${eid}`);
    Object.assign(e, extra, { state });
    writeJson(cp.edits, { edits: all });
    syncEditCount(root, id, all);
    return e;
  });
}

// project.json carries how many edits are open, so the runner starts a session for them (gates.settle).
function syncEditCount(root, id, all) {
  const pipeline = projectPipeline(root, id);
  update(root, id, (p) => { p.canvas_edits = openOf(all).length; settle(p, pipeline); return p; });
}

export class CanvasError extends GateError {}
