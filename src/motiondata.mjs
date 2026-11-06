// Motion data, derived from the rendered animatic's own scene graph instead of trusted from the AI.
//   video/src/actions.json    [{shot, at_frame, at_sec, dur_frames, dur_sec, what}]  every visible action, real start and length
//                             (read by svc/sfx.mjs: each sound on its frame, as long as the motion)
//   out/scenes.json scenes[]  keys[{word, at_frame}] and boxes[{text,x,y,w,h,from_frame,to_frame}]  (read by checks.run in
//                             svc/artcraft.mjs: sync and overlap); frames are absolute, from the start of the video
// Source: `kinetograph inspect <entry> --comp Main --frame N --json` (layers with opacity, world bounds, text) at sampled
// frames; the edges between two samples are found by bisection, so starts and ends are exact to the frame.
// deriveMotionData is pure over a `probe(frame) -> InspectResult`; probeKinetograph is the real probe.
import { spawn } from 'node:child_process';
import { freemem } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { kgCommand } from './kinetograph.mjs';

const STEP = 5;               // frames between samples
const COARSE = 3;             // first pass: every 3rd sample (15 frames); the rest only where the ends differ
const SHOWN = 0.5;            // a text counts as on screen from this opacity (readable)
const SEEN = 0.02;            // a layer counts as visible above this opacity
const WINDOW = 1.5;           // a word shown within this many seconds of being said is a key word
const AMBIENT = 4;            // seconds: a motion longer than this is ambience (drift, loop), not an action
const MIN_MOVE = 3;           // px (or opacity x200): smaller changes are shimmer
const MERGE = 4;              // frames: same verb in one shot starting this close together is one action (a stagger)
const norm = (w) => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const readJsonOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const r3 = (n) => Math.round(n * 1000) / 1000;

// Leaf layers of one frame with the opacity inherited from their groups.
function leaves(result) {
  const out = [];
  const seen = new Map();
  const walk = (layers, parent, path) => (layers || []).forEach((l, i) => {
    const op = parent * (Number.isFinite(l.opacity) ? l.opacity : 1);
    const p = `${path}/${l.id ?? i}`;
    if (l.children?.length) return walk(l.children, op, p);
    const n = seen.get(p) || 0; seen.set(p, n + 1);
    out.push({ key: n ? `${p}#${n}` : p, op, b: l.bounds || null, layer: l });
  });
  walk(result.layers, 1, '');
  return out;
}

const sigOf = (e, w, h) => {
  if (!e || !e.b || e.op <= SEEN || e.b.width <= 0 || e.b.height <= 0 || e.b.x >= w || e.b.y >= h || e.b.x + e.b.width <= 0 || e.b.y + e.b.height <= 0) return 'none';
  return [Math.round(e.op * 100), Math.round(e.b.x), Math.round(e.b.y), Math.round(e.b.width), Math.round(e.b.height), Math.round((e.layer.transform?.rotation || 0) * 10)].join(',');
};
const dev = (a, b) => { // how far two states are apart, in px (opacity x200)
  if (a === 'none' || b === 'none') return 1e9;
  const x = a.split(',').map(Number), y = b.split(',').map(Number);
  return Math.max(Math.abs(x[0] - y[0]) * 2, Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]), Math.abs(x[3] - y[3]), Math.abs(x[4] - y[4]));
};

// Run `fn` over items, `n` at a time.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i); }));
  return out;
}

// `from`: the first frame to look at (a scene built on its own probes only [from, totalFrames); the approved scenes before it
// keep their results).
// concurrency: how many inspect processes at once (each is a bundle + engine, about 1 GB): at most 4 and at most 70% of the
// free RAM. coarse (G2): the grid is first probed every `coarse` samples; a span whose two ends look the same (same layers,
// same look, same words) gets no probes inside, a span that differs is probed at every sample, so the edges are found as
// before. coarse 1 probes every sample.
export const motionConcurrency = (free = freemem(), perProbe = 1.2e9) => Math.max(1, Math.min(4, Math.floor((0.7 * free) / perProbe)));
export async function deriveMotionData({ probe, totalFrames, from: begin = 0, fps = 30, scenes = [], said = [], step = STEP, concurrency = motionConcurrency(), coarse = COARSE }) {
  const cache = new Map();
  let probed = 0, skipped = 0;
  const at = async (f) => { if (!cache.has(f)) { probed++; cache.set(f, probe(f).then((r) => ({ r, by: new Map(leaves(r).map((e) => [e.key, e])) }))); } return cache.get(f); };
  const last = Math.max(0, totalFrames - 1);
  const frames = []; for (let f = begin; f < last; f += step) frames.push(f); frames.push(Math.max(begin, last));
  if (coarse > 1 && frames.length > coarse + 1) {
    const marks = frames.map((f, i) => i).filter((i) => i % coarse === 0 || i === frames.length - 1);
    await pool(marks.map((i) => frames[i]), concurrency, at);
    const todo = [];
    for (let m = 0; m + 1 < marks.length; m++) {
      const a = await at(frames[marks[m]]), b = await at(frames[marks[m + 1]]);
      const mid = frames.slice(marks[m] + 1, marks[m + 1]);
      if (!mid.length) continue;
      let W0 = a.r.width, H0 = a.r.height;
      const same = a.by.size === b.by.size && [...a.by.keys()].every((k) => b.by.has(k) && sigOf(a.by.get(k), W0, H0) === sigOf(b.by.get(k), W0, H0) && (a.by.get(k).layer.text?.text ?? '') === (b.by.get(k).layer.text?.text ?? ''));
      if (same) { for (const f of mid) cache.set(f, cache.get(frames[marks[m]])); skipped += mid.length; } else todo.push(...mid);
    }
    await pool(todo, concurrency, at);
  } else await pool(frames, concurrency, at);
  const { r: first } = await at(frames[0]);
  const W = first.width, H = first.height;
  const keys = new Set(); for (const f of frames) for (const k of (await at(f)).by.keys()) keys.add(k);
  const state = async (k, f) => { const { by } = await at(f); return sigOf(by.get(k), W, H); };
  const entry = async (k, f) => (await at(f)).by.get(k) || null;
  // first frame in (a, b] where pred is true, given pred(a) false and pred(b) true (monotone between samples)
  const edge = async (a, b, pred) => { while (b - a > 1) { const m = (a + b) >> 1; if (await pred(m)) b = m; else a = m; } return b; };
  const shotOf = (f) => (scenes.find((s) => f >= s.from_frame && f < s.from_frame + s.frames) || scenes[0] || {}).key || 's01';

  const actions = [], boxes = [], keyed = [];
  for (const k of [...keys].sort()) {
    const samples = [];
    for (const f of frames) { const e = await entry(k, f); samples.push({ f, e, sig: sigOf(e, W, H), op: e ? e.op : 0 }); }
    const any = samples.find((s) => s.e);
    const layer = any.e.layer;
    const full = samples.every((s) => !s.e || !s.e.b || (s.e.b.width >= W * 0.9 && s.e.b.height >= H * 0.9));

    // ---- actions: stretches where the layer's look changes ----
    if (!full) {
      let i = 1;
      while (i < samples.length) {
        if (samples[i].sig === samples[i - 1].sig) { i++; continue; }
        let j = i; while (j + 1 < samples.length && samples[j + 1].sig !== samples[j].sig) j++;
        const a = samples[i - 1], z = samples[j];
        const span = samples.slice(i - 1, j + 1);
        const moved = Math.max(...span.map((s) => dev(a.sig, s.sig)), ...span.map((s) => dev(z.sig, s.sig)));
        if ((a.sig !== 'none' || z.sig !== 'none' || span.some((s) => s.sig !== 'none')) && moved >= MIN_MOVE) {
          const start = await edge(a.f, samples[i].f, async (m) => (await state(k, m)) !== a.sig);
          const end = await edge(samples[j - 1].f, z.f, async (m) => (await state(k, m)) === z.sig);
          const dur = Math.max(1, end - start);
          if (dur / fps <= AMBIENT) {
            const appears = a.sig === 'none' || a.op < SEEN + 0.001 || span[0].op < 0.1;
            const leaves_ = z.sig === 'none' || z.op < 0.1;
            const bs = span.map((s) => s.e?.b).filter(Boolean);
            const slid = bs.length > 1 && Math.max(...bs.map((b) => Math.abs(b.x - bs[0].x) + Math.abs(b.y - bs[0].y))) > 20;
            const grew = bs.length > 1 && Math.max(...bs.map((b) => Math.abs(b.width - bs[0].width) + Math.abs(b.height - bs[0].height))) > 20;
            const verb = leaves_ && !appears ? 'leaves' : appears ? (slid ? 'slides in' : 'appears') : slid ? 'moves' : grew ? 'scales' : 'changes';
            const name = String(layer.text?.text || layer.label || layer.component || layer.id || 'Element').replace(/\s+/g, ' ').slice(0, 40);
            actions.push({ shot: shotOf(start), at_frame: start, dur_frames: dur, what: `${name} ${verb}`, verb });
          }
        }
        i = j + 1;
      }
    }

    // ---- text: boxes and key words ----
    if (layer.text?.text !== undefined || samples.some((s) => s.e?.layer.text?.text)) {
      // Kinetograph 0.2.0's inspect gives every text layer with text.text '' (svc/inspect.mjs): its box still counts (the
      // overlap and safe-area checks need where text is), with no words; key words then can't be read off the render
      // (2026-11-02, d4fd: 0 boxes and 0 key words over a video full of type)
      const blind = !samples.some((x) => String(x.e?.layer.text?.text || '').trim());
      const shown = (s) => s.e && s.e.op >= SHOWN && s.e.b && s.e.b.width > 0 && sigOf(s.e, W, H) !== 'none' && (blind || String(s.e.layer.text?.text || '').trim());
      let s = 0;
      while (s < samples.length) {
        if (!shown(samples[s])) { s++; continue; }
        let e = s;
        // a run ends on a gap, or when the words change to something that doesn't continue them (a new caption)
        while (e + 1 < samples.length && shown(samples[e + 1]) && (String(samples[e + 1].e.layer.text.text).startsWith(String(samples[e].e.layer.text.text)) || String(samples[e].e.layer.text.text).startsWith(String(samples[e + 1].e.layer.text.text)) || false)) e++;
        const run = samples.slice(s, e + 1);
        const visAt = async (m) => { const x = await entry(k, m); return Boolean(x && x.op >= SHOWN && x.b && x.b.width > 0); };
        const from = s === 0 ? begin : await edge(samples[s - 1].f, samples[s].f, visAt);
        const next = samples[e + 1];
        const to = !next ? totalFrames : shown(next) ? next.f : await edge(samples[e].f, next.f, async (m) => !(await visAt(m)));
        // the settled box: the longest stretch with the same bounds
        const key = (x) => `${Math.round(x.e.b.x / 2)},${Math.round(x.e.b.y / 2)},${Math.round(x.e.b.width / 2)},${Math.round(x.e.b.height / 2)}`;
        let best = { n: 0 }, cur = { start: 0, n: 0 };
        run.forEach((x, n) => { if (n && key(x) === key(run[n - 1])) cur.n++; else cur = { start: n, n: 1 }; if (cur.n >= best.n) best = { ...cur }; });
        const text = String(run[run.length - 1].e.layer.text.text).replace(/\s+/g, ' ').trim();
        if (best.n >= 2 || run.length <= 2) {
          const b = run[best.start].e.b;
          const settledFrom = best.start === 0 ? from : run[best.start].f;
          const endAt = run[best.start + best.n - 1];
          const settledTo = best.start + best.n >= run.length ? to : run[best.start + best.n].f;
          boxes.push({ text, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), from_frame: settledFrom, to_frame: Math.max(settledTo, endAt.f + 1), shot: shotOf(settledFrom) });
        }
        // when each word shows: the first frame its text contains it (a typed line shows words one by one)
        const seen = new Map();
        for (let n = 0; n < run.length; n++) {
          const ws = String(run[n].e.layer.text.text).split(/\s+/).map((w) => ({ w, n: norm(w) })).filter((x) => x.n);
          for (const x of ws) if (!seen.has(x.n)) seen.set(x.n, { word: x.w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), frame: n === 0 ? from : run[n].f });
        }
        const groups = new Map();
        for (const x of seen.values()) { if (norm(x.word).length < 3) continue; (groups.get(x.frame) || groups.set(x.frame, []).get(x.frame)).push(x); }
        for (const [frame, ws] of groups) {
          let pick = null;
          for (const x of ws) {
            const near = said.filter((y) => y.w === norm(x.word)).map((y) => Math.abs(y.at - frame / fps)).sort((p, q) => p - q)[0];
            if (near === undefined || near > WINDOW) continue;
            if (!pick || near < pick.near - 1e-9 || (Math.abs(near - pick.near) < 1e-9 && norm(x.word).length > norm(pick.word).length)) pick = { word: x.word, near };
          }
          if (pick) keyed.push({ word: pick.word, at_frame: frame, shot: shotOf(frame) });
        }
        s = e + 1;
      }
    }
  }

  // a stagger (same verb in one shot, starts close together) is one action; ends at the last member's end
  actions.sort((p, q) => p.shot.localeCompare(q.shot) || p.verb.localeCompare(q.verb) || p.at_frame - q.at_frame);
  const merged = [];
  for (const a of actions) {
    const m = merged[merged.length - 1];
    if (m && m.shot === a.shot && m.verb === a.verb && a.at_frame - m.last_at <= MERGE) { m.count++; m.last_at = a.at_frame; m.end = Math.max(m.end, a.at_frame + a.dur_frames); } else merged.push({ ...a, count: 1, last_at: a.at_frame, end: a.at_frame + a.dur_frames });
  }
  const out = merged.sort((p, q) => p.at_frame - q.at_frame).map((m) => ({
    shot: m.shot, at_frame: m.at_frame, at_sec: r3(m.at_frame / fps), dur_frames: m.end - m.at_frame, dur_sec: r3((m.end - m.at_frame) / fps),
    what: m.count > 1 ? `${m.count} elements ${m.verb}` : m.what,
  }));
  return { fps, actions: out, boxes, keys: keyed.sort((p, q) => p.at_frame - q.at_frame), probes: probed, skipped, step };
}

// The real probe: one kinetograph process per frame. Reads the project in `video/` (the studio's own render folder).
// Each process at once gets its own entry beside the real one (src/.kg-probe-N.ts, `import './index'`): kinetograph writes its
// bundle to node_modules/.cache/kinetograph/<entry>-<hash of the entry's path>-<hash of the code>.mjs with a plain
// writeFileSync, so two processes bundling the same entry at once (4 inspects in parallel, or an inspect beside the render)
// truncate and rewrite the file while the other imports it: an empty module, "mod.setPublicDir is not a function"
// (2026-11-02, d4fd scene 1). Same folder, so the same public dir and relative paths.
export function probeEntry(work, entry, slot) {
  const rel = `${dirname(entry)}/.kg-probe-${slot}${extname(entry)}`;
  const file = join(work, 'video', rel);
  const body = `// Written by the studio (motiondata.mjs): one inspect process's own entry, so parallel bundles never share a file.\nimport './${basename(entry, extname(entry))}';\n`;
  try { if (!existsSync(file) || readFileSync(file, 'utf8') !== body) writeFileSync(file, body); } catch { return entry; }
  return rel;
}

export function probeKinetograph({ root, work, comp = 'Main', entry = 'src/index.ts', timeoutMs = 120_000 }) {
  const [cmd, ...pre] = kgCommand(root);
  const busy = new Set();
  return (frame) => new Promise((resolve, reject) => {
    let slot = 0; while (busy.has(slot)) slot++;
    busy.add(slot);
    const own = probeEntry(work, entry, slot);
    const p = spawn(cmd, [...pre, 'inspect', own, '--comp', comp, '--frame', String(frame), '--json'], { cwd: join(work, 'video'), stdio: ['ignore', 'pipe', 'pipe'] });
    p.on('close', () => busy.delete(slot));
    p.on('error', () => busy.delete(slot));
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`kinetograph inspect timed out at frame ${frame}`)); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        if (j.error) throw new Error(j.error.message || 'inspect failed');
        if (code !== 0 || !Array.isArray(j.layers)) throw new Error(`exit ${code}`);
        resolve(j);
      } catch (e) { reject(new Error(`kinetograph inspect, frame ${frame}: ${e.message} ${err.slice(-200)}`.trim())); }
    });
  });
}

// The narration's words as {w, at}, for matching key words.
export const saidWords = (timing) => (timing?.lines || []).flatMap((l) => (l.words || []).map((w) => ({ w: norm(w.text), at: Number(w.start) })));

/**
 * Derive and write both files. `scenes` are the scenes.json scenes (absolute from_frame). Returns the summary that goes
 * into scenes.json as `motion_data`; never throws (a failure is recorded, stale actions.json removed, so the sound and
 * the checks say plainly that the data is missing instead of using old numbers).
 */
export async function writeMotionData({ work, scenes, fps, totalFrames, from = 0, timing, probe, step }) {
  const actionsFile = join(work, 'video', 'src', 'actions.json');
  const t0 = Date.now();
  try {
    // the approved scenes before `from`: their actions, key words and boxes as they were read when they were built
    const prevScenes = from ? readJsonOr(join(work, 'out', 'scenes.json'), {}).scenes || [] : [];
    const prevActions = from ? readJsonOr(actionsFile, []).filter((a) => a.at_frame < from) : [];
    const d = await deriveMotionData({ probe, totalFrames, from, fps, scenes: scenes.filter((x) => x.from_frame + x.frames > from), said: saidWords(timing), step });
    mkdirSync(join(work, 'video', 'src'), { recursive: true });
    writeFileSync(actionsFile, JSON.stringify([...prevActions, ...d.actions].map(({ shot, at_sec, at_frame, dur_sec, dur_frames, what }) => ({ shot, at_sec, at_frame, dur_sec, dur_frames, what })), null, 2));
    const into = (f) => scenes.find((s) => f >= s.from_frame && f < s.from_frame + s.frames) || scenes[0];
    for (const s of scenes) { const p = from && s.from_frame < from ? prevScenes.find((x) => x.key === s.key) : null; s.keys = p?.keys || []; s.boxes = p?.boxes || []; }
    for (const k of d.keys) { const s = into(k.at_frame); if (s) s.keys.push({ word: k.word, at_frame: k.at_frame }); }
    for (const b of d.boxes) { const s = into(b.from_frame); if (s) s.boxes.push({ text: b.text, x: b.x, y: b.y, w: b.w, h: b.h, from_frame: b.from_frame, to_frame: b.to_frame }); }
    const sum = (k) => scenes.reduce((n, x) => n + (x[k]?.length || 0), 0);
    return { ok: true, derived_from: 'kinetograph inspect', step: d.step, probes: d.probes, skipped: d.skipped, ms: Date.now() - t0, ms_per_probe: d.probes ? Math.round((Date.now() - t0) / d.probes) : 0, mode: 'process', from, actions: prevActions.length + d.actions.length, keys: sum('keys'), boxes: sum('boxes') };
  } catch (e) {
    rmSync(actionsFile, { force: true });
    for (const s of scenes) { delete s.keys; delete s.boxes; }
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  }
}

// The whole video's motion data again, from frame 0, when what is on file is missing or failed (2026-11-02, d4fd: one
// scene's inspect crashed, actions.json was removed, and Sound planned 0 sound moments over 7 approved scenes). Reads the
// scenes from out/scenes.json, writes actions.json and scenes.json's motion_data. {ok, ...} or {ok:false, error}.
export async function refreshMotionData({ root, work, probe = null, fps = 30 }) {
  const file = join(work, 'out', 'scenes.json');
  let doc; try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { return { ok: false, error: 'no out/scenes.json' }; }
  const scenes = doc.scenes || [];
  if (!scenes.length) return { ok: false, error: 'no scenes' };
  const total = Math.max(...scenes.map((x) => Number(x.from_frame) + Number(x.frames)));
  let timing = null; try { timing = JSON.parse(readFileSync(join(work, 'voice', 'timing.json'), 'utf8')); } catch { /* no word times */ }
  const motion_data = await writeMotionData({ work, scenes, fps: Number(doc.fps) || fps, totalFrames: total, from: 0, timing, probe: probe || probeKinetograph({ root, work }) });
  writeFileSync(file, JSON.stringify({ ...doc, scenes, motion_data }, null, 2));
  return motion_data;
}
