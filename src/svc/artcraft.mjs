// Finish: the checks the owner runs before sending, and the hand-off file for ArtCraft (Mortiflix Studio, the Rust editor).
// "We don't need a final edit thing. We just need it to output a file that can be opened in Art Craft."
//   checks.run     jump | sync | overlap | sound, from ffmpeg + the project's own data; no GPU, no app
//   artcraft.write the .mortiflix project (headless engine, `mortiflix-studio-cli`, no control port), from handoff.plan
//   artcraft.open  `mortiflix-studio <file>`, detached
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { projectPaths, loadProject } from '../projects.mjs';
import { studioBin } from '../studio-edit.mjs';
import { UserError } from '../studio.mjs';
import { handoffPlan } from './graph.mjs';
import { keyOf, pickKeyWord, writtenForms } from './stills.mjs';
import { captionText } from './captionform.mjs';

const TPS = 254016000000;
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const round2 = (n) => Math.round(n * 100) / 100;
const norm = (w) => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ------------------------------------------------------------------------------------------ checks

const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 300_000 });

// Seconds where the picture changes a lot between two frames (ffmpeg scene score above `threshold`).
export function bigJumps(video, threshold = 0.45) {
  const r = ff(['-i', video, '-an', '-vf', `select='gt(scene,${threshold})',metadata=print:file=-`, '-f', 'null', '-']);
  const out = [];
  let t = null;
  for (const line of String(r.stdout).split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) t = Number(m[1]);
    const s = line.match(/scene_score=([\d.]+)/);
    if (s && t !== null) { out.push({ at_sec: round2(t), score: Number(s[1]) }); t = null; }
  }
  return out;
}

// Loudness of a file's sound: null when there is no audio stream.
export function soundLevel(file) {
  const r = ff(['-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = String(r.stderr).match(/mean_volume: (-?[\d.]+|-inf) dB/);
  const max = String(r.stderr).match(/max_volume: (-?[\d.]+|-inf) dB/);
  if (!mean) return null;
  const n = (x) => (x[1] === '-inf' ? -120 : Number(x[1]));
  return { mean_db: n(mean), max_db: n(max) };
}

function sceneTable(scenes, fps) {
  return (Array.isArray(scenes) ? scenes : []).filter((s) => Number.isFinite(s.from_frame)).map((s) => ({ ...s, from_sec: s.from_frame / fps, to_sec: (s.from_frame + (s.frames || 0)) / fps }));
}
const shotAt = (table, t) => table.find((s) => t >= s.from_sec - 1e-6 && t < s.to_sec - 1e-6)?.key || null;

// Key words from the motion's own code: per voice line its key word (design/stills/stills.json key_word, else picked),
// shown at the frame src/timing.ts gives that word (`slippery: f(1.28), // 38`, any helper: g(10.218), m6(39.4)), else at the nearest on-screen move in
// video/src/actions.json within half a second of it being said. A key word nothing shows is an item.
export function codeKeys(work, table, timing, fps) {
  const tsText = (() => { try { return readFileSync(join(work, 'video', 'src', 'timing.ts'), 'utf8'); } catch { return ''; } })();
  const tsWords = [...tsText.matchAll(/^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*[A-Za-z_$][\w$]*\(\s*([\d.]+)\s*\)/gm)].map((m) => ({ w: norm(m[1].replace(/^y(?=\d)/, '')), at: Number(m[2]) }));
  const acts = (readJson(join(work, 'video', 'src', 'actions.json'), []) || []).filter((a) => /(appears|slides in|scales|changes)$/.test(String(a.what || ''))).map((a) => Number(a.at_sec ?? (a.at_frame ?? 0) / fps));
  const stills = readJson(join(work, 'design', 'stills', 'stills.json'), { lines: {} })?.lines || {};
  const forms = writtenForms(work);
  const keys = [], items = [];
  if (!tsWords.length && !acts.length) return { keys, items, source: 'nothing' };
  for (const l of timing.lines || []) {
    const k = keyOf(stills[l.id], l.text || '', work) || pickKeyWord(l.text || '', forms);
    const first = norm(String(k).split(/\s+/)[0]);
    const w = (l.words || []).find((x) => norm(x.text) === first) || (l.words || []).find((x) => norm(captionText(x.text, forms)) === first);
    if (!k || !w) continue; // a written number ("2025") the voice says in words: not timed here
    const at = Number(w.start);
    const inCode = tsWords.filter((x) => x.w === first).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    const move = acts.filter((t) => Math.abs(t - at) <= 0.5).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
    const shown = inCode ? inCode.at : move;
    if (shown === undefined) { items.push({ shot: shotAt(table, at), at_sec: round2(at), text: `Nothing in the motion is timed on "${k}" (said at ${at.toFixed(2)} s): no timing.ts word and no move within 0.5 s.` }); continue; }
    keys.push({ shot: shotAt(table, at), word: first, at_sec: shown });
  }
  return { keys, items, source: tsWords.length ? (acts.length ? "timing.ts and the motion's actions" : 'timing.ts') : "the motion's actions" };
}

// opts: video, mix, fps, jump_threshold, jump_frames, sync_frames, boxes, keys (all optional: read from the project)
export function runChecks(root, id, opts = {}) {
  const work = projectPaths(root, id).work;
  const sc = readJson(join(work, 'out', 'scenes.json'), {});
  const fps = Number(opts.fps) || Number(sc.fps) || 30;
  const table = sceneTable(sc.scenes, fps);
  const video = opts.video || join(work, 'out', 'animatic.mp4');
  const timing = readJson(join(work, 'voice', 'timing.json'), { lines: [] });
  const checks = [];
  // why the key words / boxes may be missing, said plainly (the studio writes sc.motion_data after every animatic build)
  const md = sc.motion_data;
  const why = md === undefined ? ' (this animatic was built before the studio read motion data off it)' : md.ok === false ? ` (reading them off the render failed: ${md.error})` : ' (nothing on screen matched a spoken word, or no text was settled)';

  // jump: a big frame-to-frame change that no cut explains
  {
    const key = 'jump'; const items = [];
    if (!existsSync(video)) checks.push({ key, ok: false, checked: false, reason: 'There is no animatic yet, so nothing was compared.', note: 'no animatic to check', items: [] });
    else {
      const tol = (Number(opts.jump_frames) || 3) / fps;
      const cuts = table.slice(1).map((s) => s.from_sec);
      for (const j of bigJumps(video, Number(opts.jump_threshold) || 0.45)) {
        if (cuts.some((c) => Math.abs(c - j.at_sec) <= tol)) continue;
        items.push({ shot: shotAt(table, j.at_sec), at_sec: j.at_sec, text: `The picture jumps here (change ${Math.round(j.score * 100)}%) and no cut is planned.` });
      }
      checks.push({ key, ok: !items.length, checked: true, items });
    }
  }

  // sync: the key word appears on screen within +-N frames of the moment it is said
  {
    const key = 'sync'; const items = [];
    let keys = opts.keys || table.flatMap((s) => (s.keys || []).map((k) => ({ shot: s.key, word: k.word, at_sec: Number.isFinite(k.at_frame) ? k.at_frame / fps : k.at_sec })));
    const said = (timing.lines || []).flatMap((l) => (l.words || []).map((w) => ({ w: norm(w.text), at: Number(w.start) })));
    const tol = (Number(opts.sync_frames) || 6) / fps;
    // no key words read off the render: each line's key word (the stills' own, else picked), timed where the motion's
    // code puts it (src/timing.ts word frames) and where something moves on screen (the motion's actions), against the
    // voice word map (2026-11-02, 61dc: sync never ran)
    let source = 'the render';
    if (!keys.length && !opts.keys) { const k = codeKeys(work, table, timing, fps); keys = k.keys; source = k.source; items.push(...k.items); }
    let seen = 0;
    for (const k of keys) {
      const hits = said.filter((x) => x.w === norm(k.word));
      if (!hits.length) { items.push({ shot: k.shot || null, at_sec: round2(k.at_sec), text: `"${k.word}" is never said in the voice.` }); continue; }
      seen++;
      const nearest = hits.reduce((a, b) => (Math.abs(b.at - k.at_sec) < Math.abs(a.at - k.at_sec) ? b : a));
      const off = k.at_sec - nearest.at;
      if (Math.abs(off) > tol) items.push({ shot: k.shot || shotAt(table, k.at_sec), at_sec: round2(k.at_sec), text: `"${k.word}" shows ${Math.abs(off).toFixed(2)} s ${off > 0 ? 'after' : 'before'} it is said (at ${nearest.at.toFixed(2)} s).` });
    }
    checks.push({ key, ok: !items.length, checked: keys.length > 0, ...(keys.length ? {} : { reason: `Nothing was compared: no key words in the scene data${why}, and none in the motion's timing.ts or actions.` }), items, ...(keys.length ? { note: `${seen} of ${keys.length} key words timed (from ${source})` } : { unverified: true, note: `not checked: no key words in the scene data${why}` }) });
  }

  // overlap: text boxes that sit on each other while both are on screen
  {
    const key = 'overlap'; const items = [];
    const boxes = opts.boxes || table.flatMap((s) => (s.boxes || []).map((b) => ({ ...b, shot: s.key, from_sec: b.from_frame !== undefined ? b.from_frame / fps : s.from_sec, to_sec: b.to_frame !== undefined ? b.to_frame / fps : s.to_sec })));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      if (!(a.from_sec < b.to_sec && b.from_sec < a.to_sec)) continue;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > 0 && h > 0) items.push({ shot: a.shot || b.shot || null, at_sec: round2(Math.max(a.from_sec, b.from_sec)), text: `"${a.text}" and "${b.text}" overlap by ${Math.round((w * h) / Math.min(a.w * a.h, b.w * b.h) * 100)}% of the smaller box.` });
    }
    checks.push({ key, ok: !items.length, checked: boxes.length > 0, ...(boxes.length ? {} : { reason: `Nothing was compared: no text boxes in the scene data${why}.` }), items, ...(boxes.length ? { note: `${boxes.length} text boxes` } : { unverified: true, note: `not checked: no text boxes in the scene data${why}` }) });
  }

  // sound: the final mix is there and not silent
  {
    const key = 'sound'; const items = [];
    const mix = (opts.mix ? [opts.mix] : [join(work, 'out', 'voice', 'narration.wav'), join(work, 'out', 'mix.wav'), video]).find((f) => existsSync(f));
    const lv = mix ? soundLevel(mix) : null;
    if (!lv) items.push({ shot: null, at_sec: 0, text: mix ? 'The video has no sound track.' : 'No final mix found.' });
    else if (lv.max_db < -50) items.push({ shot: null, at_sec: 0, text: `The mix is silent (loudest point ${lv.max_db} dB).` });
    checks.push({ key, ok: !items.length, checked: Boolean(lv), ...(lv ? {} : { reason: mix ? 'The video has no sound track to measure.' : 'There is no final mix yet, so the sound was not measured.' }), items });
  }
  return checks;
}

// ------------------------------------------------------------------------------------------ the project file

const srtTime = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
export const toSrt = (caps) => caps.map((c, i) => `${i + 1}\n${srtTime(c.start_sec)} --> ${srtTime(c.end_sec)}\n${c.text}\n`).join('\n');

// `cli(args)` runs mortiflix-studio-cli and returns its stdout; tests pass a fake.
export function writeArtcraft(root, id, { cli = null, plan = null } = {}) {
  const project = loadProject(root, id);
  plan = plan || handoffPlan(root, id);
  const state = projectPaths(root, id).state;
  const abs = (p) => (isAbsolute(p) ? p : join(state, p));
  const fcproj = plan.fcproj.replace(/\.fcproj$/, '.mortiflix');
  const dir = join(dirname(fcproj), 'media');
  if (!plan.clips.some((c) => c.kind === 'shot')) throw new UserError('nothing to hand over yet: the shots come with the animatic');
  let run = cli;
  if (!run) {
    const bin = studioBin();
    if (!bin) throw new UserError('ArtCraft (mortiflix-studio-cli) isn\'t found: put it on PATH, or set MFX_STUDIO_BIN to its folder');
    run = (args) => { const r = spawnSync(bin.cli, ['--compact', ...args], { encoding: 'utf8', timeout: 600_000 }); if (r.status !== 0) throw new Error(`ArtCraft: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`); return r.stdout; };
  }
  mkdirSync(dir, { recursive: true });
  // the ArtCraft project made before may hold the owner's own edits ("Need changes?" hands over again): it is kept
  // beside the new one as "<name> (before <time>).mortiflix", never deleted
  if (existsSync(fcproj)) renameSync(fcproj, fcproj.replace(/\.mortiflix$/, ` (before ${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}).mortiflix`));
  const J = (args) => JSON.parse(String(run(args)).trim() || 'null');
  const exec = (cmd, params) => J(['--project', fcproj, '--save', 'exec', cmd, JSON.stringify(params)]);

  // shots: the piece of each file that plays, re-encoded without B-frames so ArtCraft shows every frame on time
  const shots = plan.clips.filter((c) => c.kind === 'shot' && c.media?.path);
  const media = shots.map((s) => {
    const src = abs(s.media.path);
    if (!(s.media.from_sec || s.media.to_sec) || s.media.kind !== 'video') return src;
    const dest = join(dir, `${s.node}-v${s.version}.mp4`);
    if (!cli) ff(['-y', '-loglevel', 'error', '-ss', String(s.media.from_sec || 0), '-i', src, '-t', String(s.dur_sec), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-bf', '0', '-pix_fmt', 'yuv420p', '-an', dest]);
    return dest;
  });
  const sound = plan.clips.filter((c) => ['line', 'music', 'sfx'].includes(c.kind) && c.media?.path);
  const srt = plan.captions?.length ? join(dir, 'captions.srt') : null;
  if (srt) writeFileSync(srt, toSrt(plan.captions));

  J(['--save-as', fcproj, 'exec', 'file.newProject', JSON.stringify({ name: project.title })]);
  const paths = [...media, ...sound.map((c) => abs(c.media.path))];
  const imp = exec('file.import', { paths });
  if (imp?.errors?.length) throw new Error(`ArtCraft couldn't import: ${JSON.stringify(imp.errors).slice(0, 300)}`);
  const sq = plan.sequence;
  exec('file.newSequence', { name: sq.name, width: sq.width, height: sq.height, fps: sq.fps, video: 2, audio: 3 });
  const placed = exec('timeline.place', { items: imp.items.slice(0, shots.length), track: 'V1', seconds: 0, insert: false, audio: false });
  const trackOf = { line: 'A1', music: 'A2', sfx: 'A3' };
  const clips = shots.map((s, i) => ({ node: s.node, kind: 'shot', version: s.version, item: imp.items[i], clip: placed?.placed?.[i]?.[0] ?? placed?.clips?.[i] ?? null, track: 'V1', start_sec: s.start_sec }));
  sound.forEach((c, i) => { const r = exec('timeline.place', { item: imp.items[shots.length + i], track: trackOf[c.kind], seconds: c.start_sec || 0, insert: false, video: false }); clips.push({ node: c.node, kind: c.kind, version: c.version, item: imp.items[shots.length + i], clip: r?.clips?.[0] ?? null, track: trackOf[c.kind], start_sec: c.start_sec || 0 }); });
  // names, markers per scene (plan.markers: beats + sound cues), captions
  const script = [
    ...clips.filter((c) => c.clip).map((c) => ({ id: 'clip.rename', params: { clip: c.clip, name: (plan.clips.find((p) => p.node === c.node && p.kind === c.kind) || {}).name || c.node } })),
    ...plan.markers.map((m) => ({ id: 'markers.add', params: { target: 'program', time: Math.round(m.time_sec * TPS), name: m.name, ...(m.label ? { color: m.label } : {}) } })),
    ...(srt ? [{ id: 'captions.import', params: { path: srt, name: 'Captions' } }] : []),
  ];
  const jsonl = join(dir, '.script.jsonl');
  writeFileSync(jsonl, script.map((x) => JSON.stringify(x)).join('\n'));
  run(['--project', fcproj, '--save', '--keep-going', 'run', jsonl]);
  rmSync(jsonl, { force: true });
  return { file: fcproj, clips: clips.length, tracks: [...new Set(clips.map((c) => c.track))].concat(srt ? ['C1'] : []), markers: plan.markers.length, captions: plan.captions?.length || 0, length_sec: sq.length_sec, sound: sound.length, map: clips };
}

// Opens the file in ArtCraft. `spawnFn` is replaced in tests.
export function openArtcraft(file, { spawnFn = spawn } = {}) {
  if (!file || !existsSync(file)) throw new UserError('make the ArtCraft file first');
  const bin = studioBin();
  const app = bin?.app || process.env.MFX_ARTCRAFT_APP || 'mortiflix-studio';
  const child = spawnFn(app, [file], { detached: true, stdio: 'ignore' });
  child.unref?.();
  return { opened: file, app };
}

export const handlers = (root, { needProject }) => ({
  'checks.run': (p) => runChecks(root, needProject(p), p || {}),
  'artcraft.write': (p) => writeArtcraft(root, needProject(p)),
  'artcraft.open': (p) => openArtcraft(p?.file || handoffPlan(root, needProject(p)).fcproj),
});
