#!/usr/bin/env node
// Replay pack generator: maps artefacts of past real generations onto v3-shaped step outputs, so the v3 pipeline can be
// beta-tested end to end with zero paid calls (the replay backend copies these files instead of calling Claude /
// ElevenLabs / Kinetograph). Read-only on the sources (copies only). Pure Node + ffmpeg/ffprobe.
//   node tools/replay/make-pack.mjs --studio <studio> --project <id> --out <pack dir> [--motion-from <studio>:<id>]...
//        [--music-from <studio>:<id>]... [--sfx-library <dir>] [--name <name>] [--force]
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const FPS = 30, LEAD = 0.25, W = 1920, H = 1080;
const STEPS = ['brief', 'script', 'voice', 'style-frames'];
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const fail = (m) => { throw new Error(`replay pack: ${m}`); };
const need = (cond, m) => { if (!cond) fail(m); };

function ff(bin, args, timeout = 180_000) {
  const r = spawnSync(bin, ['-hide_banner', '-v', 'error', ...(bin === 'ffmpeg' ? ['-nostdin', '-y'] : []), ...args], { encoding: 'utf8', timeout });
  if (r.status !== 0) fail(`${bin} failed (${(r.stderr || r.error?.message || '').slice(-300)}) for ${args.join(' ').slice(0, 200)}`);
  return r.stdout;
}
const probe = (f) => {
  const j = JSON.parse(ff('ffprobe', ['-of', 'json', '-show_streams', '-show_format', f]));
  const v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
  return { v, a, dur: Number(j.format.duration) };
};
const sig = (p) => JSON.stringify([p.v?.codec_name, p.v?.width, p.v?.height, p.v?.r_frame_rate, p.v?.pix_fmt, p.a?.codec_name, p.a?.sample_rate, p.a?.channels]);
const cp = (from, to) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); };
const r3 = (n) => Math.round(n * 1000) / 1000;

// "studio:id" -> { studio, id }
const ref = (s) => { const i = s.lastIndexOf(':'); need(i > 0, `bad source "${s}" (want <studio>:<project id>)`); return { studio: resolve(s.slice(0, i)), id: s.slice(i + 1) }; };
const projDir = (r) => join(r.studio, 'projects', r.id);

// One scene per beat, from the voice: starts LEAD before its first word (the first at 0), runs to the next start (the
// last to the narration's end + 1 s hold). Same rule and total as scenesFromTiming in src/quickanimatic.mjs, in whole frames.
export function sceneSpans(beats, timing) {
  const starts = beats.map((b) => {
    const ls = timing.lines.filter((l) => l.id.startsWith(`${b.id}-`));
    return ls.length ? Math.max(0, (ls[0].words?.[0]?.start ?? ls[0].start) - LEAD) : null;
  });
  const total = Math.round((timing.seconds + 1) * FPS);
  const out = [];
  beats.forEach((b, i) => {
    if (starts[i] === null) return;
    const from = out.length === 0 ? 0 : Math.round(starts[i] * FPS);
    const next = starts.slice(i + 1).find((s) => s !== null);
    const to = next === undefined ? total : Math.round(next * FPS);
    out.push({ beat: b.id, name: b.name, from: from / FPS, frames: Math.max(1, to - from), seconds: Math.max(1, to - from) / FPS });
  });
  return out;
}

// Real motion: the scenes of past real animatics (out/scenes.json cut points; else equal slices), cycled over our scenes.
function motionSegments(sources) {
  const segs = [];
  for (const s of sources) {
    const file = join(projDir(s), 'out', 'animatic.mp4');
    need(existsSync(file), `no animatic at ${file}`);
    const dur = probe(file).dur;
    const sc = readJson(join(projDir(s), 'out', 'scenes.json'), {});
    const list = (sc.scenes || []).filter((x) => x.frames > 0);
    const fps = sc.fps || FPS;
    const cuts = list.length ? list.map((x) => ({ from: x.from_frame / fps, len: x.frames / fps })) : Array.from({ length: 6 }, (_, i) => ({ from: (dur / 6) * i, len: dur / 6 }));
    for (const c of cuts) if (c.len >= 1 && c.from + 0.5 < dur) segs.push({ file, from: c.from, len: Math.min(c.len, dur - c.from), src: `${basename(s.studio)}:${s.id}` });
  }
  return segs;
}

export function makePack(o) {
  const src = { studio: resolve(o.studio), id: o.project };
  const pd = projDir(src);
  need(existsSync(pd), `project not found: ${pd}`);
  const out = resolve(o.out);
  if (existsSync(out) && readdirSync(out).length) { need(o.force, `${out} exists and is not empty (use --force)`); rmSync(out, { recursive: true, force: true }); }
  mkdirSync(out, { recursive: true });
  const notes = [];
  const state = join(src.studio, 'state', src.id);
  const proj = readJson(join(state, 'project.json'), {});
  const answers0 = proj.intake?.answers || {};

  // ---- source artefacts
  const beatsDoc = readJson(join(pd, 'script', 'beats.json')); need(beatsDoc?.beats?.length, 'script/beats.json has no beats');
  const beats = beatsDoc.beats;
  const lines = readJson(join(pd, 'voice', 'lines.json')); need(Array.isArray(lines) && lines.length, 'voice/lines.json missing');
  const timing = readJson(join(pd, 'voice', 'timing.json')); need(timing?.lines?.length, 'voice/timing.json missing');
  const narr = join(pd, 'out', 'voice', 'narration.wav'); need(existsSync(narr), 'out/voice/narration.wav missing');
  const frames = readJson(join(pd, 'design', 'frames.json')); need(frames?.frames?.length, 'design/frames.json missing');
  const nd = probe(narr).dur;

  // ---- consistency of the voice
  const beatIds = new Set(beats.map((b) => b.id));
  for (const l of lines) need(beatIds.has(String(l.id).split('-')[0]), `voice line ${l.id}: no beat ${String(l.id).split('-')[0]} in script/beats.json`);
  for (const b of beats) need(lines.some((l) => l.id.startsWith(`${b.id}-`)), `beat ${b.id} has no voice line`);
  need(lines.length === timing.lines.length && lines.every((l, i) => timing.lines[i].id === l.id), 'timing.json lines do not match lines.json ids');
  need(Math.abs(nd - timing.seconds) < 0.5, `narration is ${nd.toFixed(2)} s but timing.json says ${timing.seconds}`);

  // ---- steps
  const step = (k) => join(out, 'steps', k);
  const add = (k, rel, from) => { need(existsSync(from), `${k}: source file missing ${from}`); cp(from, join(step(k), 'work', rel)); };
  const recorded = (k) => readJson(join(state, 'reviews', k, 'v1', 'submission.json'), null);
  const sub = {};
  const mk = (k, rec, items, extra = {}) => { sub[k] = { note: rec?.note || `${k} (replayed)`, ...(extra.questions || rec?.questions?.length ? { questions: extra.questions || rec.questions } : {}), items }; };

  // brief: the research notes are the item (the recorded one carried the text inline)
  add('brief', 'research/brief-notes.md', join(pd, 'research', 'brief-notes.md'));
  mk('brief', recorded('brief'), [{ path: 'research/brief-notes.md', label: 'Early research notes' }]);
  // script
  add('script', 'script.md', join(pd, 'script.md'));
  add('script', 'script/beats.json', join(pd, 'script', 'beats.json'));
  mk('script', recorded('script'), [{ path: 'script.md', label: 'Script' }]);
  // voice
  const vlines = lines.map((l) => {
    const c = join(pd, 'voice', 'clips', `${l.id}.wav`);
    if (existsSync(c)) { add('voice', `voice/clips/${l.id}.wav`, c); return { ...l, file: `voice/clips/${l.id}.wav` }; }
    return l;
  });
  mkdirSync(join(step('voice'), 'work', 'voice'), { recursive: true });
  writeFileSync(join(step('voice'), 'work', 'voice', 'lines.json'), JSON.stringify(vlines, null, 2));
  add('voice', 'voice/timing.json', join(pd, 'voice', 'timing.json'));
  add('voice', 'out/voice/narration.wav', narr);
  add('voice', 'voice/narration.wav', narr);
  // the per-line take cache (soundtrack/voice.mjs makeVoice): a line retake then re-records that line only and joins the
  // rest from the cache, as in the real studio; without it every line is "missing" and the narration is rebuilt from scratch
  for (const f of ['timing.json', 'voice.wav']) if (existsSync(join(pd, 'sound', 'voice', f))) add('voice', `sound/voice/${f}`, join(pd, 'sound', 'voice', f));
  if (existsSync(join(pd, 'sound', 'voice', 'lines'))) for (const f of readdirSync(join(pd, 'sound', 'voice', 'lines'))) add('voice', `sound/voice/lines/${f}`, join(pd, 'sound', 'voice', 'lines', f));
  const vitems = [{ path: 'out/voice/narration.wav', label: `Narration · full (${r3(nd)} s)`, section: 'Full' }];
  for (const b of beats) {
    const f = join(pd, 'out', 'voice', `${b.id}.wav`);
    if (existsSync(f)) { add('voice', `out/voice/${b.id}.wav`, f); vitems.push({ path: `out/voice/${b.id}.wav`, label: `${b.id.toUpperCase()} · ${b.name}`, section: 'Scenes' }); }
  }
  mk('voice', recorded('voice'), vitems);
  // style frames
  const fitems = [];
  for (const f of frames.frames) {
    add('style-frames', f.file, join(pd, f.file));
    fitems.push({ path: f.file, label: f.label || f.id });
    for (const b of f.beats || []) need(beatIds.has(b), `frame ${f.id}: unknown beat ${b}`);
  }
  add('style-frames', 'design/frames.json', join(pd, 'design', 'frames.json'));
  for (const extra of ['design/look-brief.json', 'design/LOOK.md']) if (existsSync(join(pd, extra))) add('style-frames', extra, join(pd, extra));
  mk('style-frames', recorded('style-frames'), fitems);
  for (const k of STEPS) {
    writeFileSync(join(step(k), 'submission.json'), JSON.stringify(sub[k], null, 2));
    for (const it of sub[k].items) need(existsSync(join(step(k), 'work', it.path)), `${k}: item ${it.path} not in the overlay`);
  }

  // ---- motion: one clip per beat
  const spans = sceneSpans(beats, timing);
  need(spans.length === beats.length, 'a beat has no scene');
  const sumSec = spans.reduce((a, s) => a + s.seconds, 0);
  need(Math.abs(sumSec - (timing.seconds + 1)) < 0.1, `scene seconds ${sumSec.toFixed(2)} vs narration + 1 s hold ${(timing.seconds + 1).toFixed(2)}`);
  const tmp = join(out, '.tmp'); mkdirSync(tmp, { recursive: true });
  const msrc = (o.motionFrom || []).map(ref);
  const segs = msrc.length ? motionSegments(msrc) : [];
  if (!segs.length) notes.push('no --motion-from: every scene is a slow-zoom of the project\'s own style frame (synthesised motion).');
  const frameFor = (beat) => (frames.frames.find((f) => (f.beats || []).includes(beat)) || frames.frames[0]).file;
  const scenes = [], clipSig = [];
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p,setsar=1`;
  const venc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-video_track_timescale', '15360'];
  const used = [];
  spans.forEach((s, i) => {
    const clip = join(out, 'motion', 'clips', `${s.beat}.mp4`); mkdirSync(dirname(clip), { recursive: true });
    const audio = ['-ss', String(s.from), '-t', String(s.seconds), '-i', narr];
    const aenc = ['-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
    if (segs.length) {
      const g = segs[i % segs.length];
      const seg = join(tmp, `${s.beat}-src.mp4`);
      ff('ffmpeg', ['-ss', String(g.from), '-t', String(g.len), '-i', g.file, '-an', '-vf', vf, ...venc, seg]);
      ff('ffmpeg', ['-stream_loop', '-1', '-i', seg, ...audio, '-map', '0:v', '-map', '1:a', '-t', String(s.seconds), '-vf', vf, ...venc, ...aenc, clip]);
      used.push(`${s.beat} <- ${g.src} ${r3(g.from)}-${r3(g.from + g.len)} s${g.len < s.seconds ? ' (looped)' : ''}`);
    } else {
      const fr = join(pd, frameFor(s.beat));
      const n = Math.round(s.seconds * FPS);
      ff('ffmpeg', ['-loop', '1', '-framerate', String(FPS), '-i', fr, ...audio, '-map', '0:v', '-map', '1:a', '-t', String(s.seconds),
        '-vf', `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,zoompan=z='1+0.1*on/${n}':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p,setsar=1`, ...venc, ...aenc, clip]);
    }
    const p = probe(clip);
    clipSig.push([s.beat, sig(p)]);
    need(p.dur > 0 && Math.abs(p.dur - s.seconds) < 0.25, `clip ${s.beat} is ${p.dur.toFixed(2)} s, wanted ${s.seconds.toFixed(2)}`);
    scenes.push({ beat: s.beat, file: `motion/clips/${s.beat}.mp4`, seconds: r3(s.seconds) });
  });
  for (const [b, sg] of clipSig) need(sg === clipSig[0][1], `clip ${b} differs from ${clipSig[0][0]} in codec params: ${sg} vs ${clipSig[0][1]}`);
  if (used.length) notes.push(`motion: REAL recorded motion cut from past animatics, cycled over our ${spans.length} scenes, video only with this project's own narration slice laid under: ${used.join('; ')}. The picture does not depict this video's script (it is another video's motion).`);
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(join(out, 'motion', 'scenes.json'), JSON.stringify(scenes, null, 2));

  // actions.json (synthesised): a few sound cues per scene on real line starts
  const actions = [];
  spans.forEach((s, i) => {
    const sh = `s${String(i + 1).padStart(2, '0')}`;
    const ls = timing.lines.filter((l) => l.id.startsWith(`${s.beat}-`));
    actions.push({ shot: sh, at_sec: r3(s.from + 0.1), what: `${s.name} title in`, sound: i === 0 ? 'impact' : 'whoosh' });
    ls.slice(1, 3).forEach((l) => actions.push({ shot: sh, at_sec: r3(Math.min(l.start, nd - 0.5)), what: 'Row pops in', sound: 'pop' }));
  });
  actions.sort((a, b) => a.at_sec - b.at_sec);
  for (const a of actions) need(a.at_sec >= 0 && a.at_sec < nd, `action ${a.what} at ${a.at_sec} outside the video`);
  writeFileSync(join(out, 'motion', 'actions.json'), JSON.stringify(actions, null, 2));
  notes.push(`motion/actions.json is synthesised (${actions.length} sound cues on real line starts); the source had no actions file.`);

  // ---- stills: one per voice line, the style frame of its beat, forced to 1920x1080
  const done = new Map();
  for (const l of lines) {
    const fr = frameFor(l.id.split('-')[0]);
    const dest = join(out, 'stills', `${l.id}.png`); mkdirSync(dirname(dest), { recursive: true });
    if (done.has(fr)) copyFileSync(done.get(fr), dest);
    else { ff('ffmpeg', ['-i', join(pd, fr), '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, '-frames:v', '1', dest]); done.set(fr, dest); }
  }
  notes.push('stills: the beat\'s own style frame (real, from design/frames.json) for each of its lines; lines of one beat share the picture.');

  // ---- audio pools
  const audio = { tts: [], music: [], sfx: [] };
  const mp3 = (from, rel, extra = []) => { const to = join(out, rel); mkdirSync(dirname(to), { recursive: true }); ff('ffmpeg', ['-i', from, ...extra, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', to]); return rel; };
  for (const l of lines.filter((l, i, a) => a.findIndex((x) => x.id.split('-')[0] === l.id.split('-')[0]) === i).slice(0, 6)) {
    const c = join(pd, 'voice', 'clips', `${l.id}.wav`);
    if (existsSync(c)) audio.tts.push(mp3(c, `audio/tts/${l.id}.mp3`));
  }
  need(audio.tts.length, 'no voice clips for the tts pool');
  const msources = (o.musicFrom?.length ? o.musicFrom : o.motionFrom || []).map(ref);
  for (const m of msources) {
    const f = join(projDir(m), 'out', 'music', 'score.mp3');
    if (existsSync(f)) audio.music.push(mp3(f, `audio/music/${m.id.slice(0, 40)}.mp3`, ['-t', '120']));
  }
  need(audio.music.length, 'no music found (out/music/score.mp3 in the --music-from / --motion-from projects)');
  const lib = resolve(o.sfxLibrary || join(homedir(), 'MortiDrive', 'files', 'Sound Effects', 'ElevenLabs'));
  const idx = readJson(join(lib, 'index.json'), []);
  for (const k of ['whoosh', 'pop', 'impact', 'click', 'riser', 'chime']) {
    const it = idx.find((i) => i.file && `${i.name} ${i.prompt}`.toLowerCase().includes(k) && existsSync(join(lib, i.file)));
    if (it) { const to = join(out, 'audio', 'sfx', `${k}.mp3`); cp(join(lib, it.file), to); audio.sfx.push(`audio/sfx/${k}.mp3`); }
  }
  need(audio.sfx.length, `no sound effects found in ${lib}`);
  notes.push(`audio: tts = this project's own real ElevenLabs line clips; music = past real scores (${audio.music.length}); sfx = real ElevenLabs effects from the sound library (${audio.sfx.length}).`);

  // ---- claude answers (synthesised): music plan cut at scene changes
  const moods = ['tense low drone, sparse pulse', 'driving minimal electronic, urgent', 'calm steady pulse, reassuring', 'warm resolve, light bell tones'];
  const cuts = spans.filter((_, i) => i === 0 || i % Math.ceil(spans.length / moods.length) === 0).slice(0, moods.length);
  const cues = cuts.map((s, i) => ({ from_sec: r3(s.from), mood: moods[i].split(',')[0], prompt: `${moods[i]}, instrumental, no vocals` }));
  mkdirSync(join(out, 'claude'), { recursive: true });
  writeFileSync(join(out, 'claude', 'music-plan.json'), JSON.stringify({ cues }, null, 2));
  notes.push('claude/music-plan.json is synthesised (no recorded music plan in the source): cues cut at scene starts.');

  // ---- look / motion briefs, intake answers
  const lb = readJson(join(pd, 'design', 'look-brief.json'), null);
  const mb = readJson(join(pd, 'design', 'motion-brief.json'), null);
  if (!mb) notes.push('motion_brief: the source has none; the default "AI decides" brief is used.');
  const lookBrief = lb ? Object.fromEntries(Object.entries(lb).filter(([k]) => k !== 'at')) : { vibe: 'flat' };
  const len = timing.seconds;
  const lengths = [15, 30, 45, 60, 90, 120, 180, 300, 480, 600, 900, 1200];
  const answers = {
    topic: answers0.topic || proj.title || src.id,
    audience: answers0.audience || '',
    length: answers0.length || `${lengths.reduce((a, b) => (Math.abs(b - len) < Math.abs(a - len) ? b : a))} s`,
    aspect: answers0.aspect || '16:9',
    voice: answers0.voice || 'Narrated',
  };
  const pack = {
    format: 'mfx-replay-1', name: o.name || basename(out), made_at: new Date().toISOString(),
    source: { studio: src.studio, project: src.id, title: proj.title || src.id, notes },
    project: { title: proj.title || src.id, pipeline: 'v3', answers },
    look_brief: lookBrief, motion_brief: mb || { motion_pack: null, rule_packs: [], words: 'the AI decides' },
    steps: Object.fromEntries(STEPS.map((k) => [k, { submission: `steps/${k}/submission.json`, work: `steps/${k}/work` }])),
    motion: { scenes: 'motion/scenes.json', actions: 'motion/actions.json' },
    stills: 'stills', audio, claude: { 'music-plan': 'claude/music-plan.json' },
  };
  writeFileSync(join(out, 'replay.json'), JSON.stringify(pack, null, 2));
  validatePack(out);
  return pack;
}

// Re-reads the written pack and checks every path and the consistency rules. Throws on the first failure.
export function validatePack(dir) {
  const pack = readJson(join(dir, 'replay.json')); need(pack?.format === 'mfx-replay-1', 'replay.json missing or wrong format');
  const has = (rel, what) => need(rel && existsSync(join(dir, rel)), `${what}: ${rel} does not exist`);
  for (const [k, s] of Object.entries(pack.steps)) {
    has(s.submission, `${k} submission`); has(s.work, `${k} work`);
    const sb = readJson(join(dir, s.submission)); need(Array.isArray(sb.items) && sb.items.length, `${k}: submission has no items`);
    for (const it of sb.items) has(`${s.work}/${it.path}`, `${k} item`);
  }
  const vw = join(dir, pack.steps.voice.work), sw = join(dir, pack.steps.script.work);
  const beats = readJson(join(sw, 'script', 'beats.json')).beats.map((b) => b.id);
  const lines = readJson(join(vw, 'voice', 'lines.json')), timing = readJson(join(vw, 'voice', 'timing.json'));
  for (const l of lines) { need(beats.includes(l.id.split('-')[0]), `line ${l.id} has no beat`); if (l.file) need(existsSync(join(vw, l.file)), `line ${l.id}: ${l.file} missing`); has(`stills/${l.id}.png`, 'still'); }
  need(lines.length === timing.lines.length && lines.every((l, i) => timing.lines[i].id === l.id), 'timing/lines mismatch');
  const sf = join(dir, pack.steps['style-frames'].work);
  for (const f of readJson(join(sf, 'design', 'frames.json')).frames) need(existsSync(join(sf, f.file)), `frame file ${f.file} missing`);
  const sc = readJson(join(dir, pack.motion.scenes)); need(sc.length === beats.length && sc.every((s, i) => s.beat === beats[i]), 'motion scenes are not one per beat in order');
  let first = null, total = 0;
  for (const s of sc) { has(s.file, `clip ${s.beat}`); const p = probe(join(dir, s.file)); first ||= sig(p); need(sig(p) === first, `clip ${s.beat} codec params differ`); need(p.v && p.a, `clip ${s.beat} lacks video or audio`); total += s.seconds; }
  const nd = probe(join(vw, 'out', 'voice', 'narration.wav')).dur;
  need(Math.abs(total - (nd + 1)) < 0.6, `scenes ${total.toFixed(2)} s vs narration + 1 s hold ${(nd + 1).toFixed(2)} s`);
  for (const a of readJson(join(dir, pack.motion.actions))) need(a.at_sec >= 0 && a.at_sec < total, `action ${a.what} at ${a.at_sec} outside the video`);
  for (const [k, list] of Object.entries(pack.audio)) { need(list.length, `audio.${k} empty`); for (const f of list) has(f, `audio.${k}`); }
  const plan = readJson(join(dir, pack.claude['music-plan'])); need(plan.cues?.length && plan.cues[0].from_sec === 0, 'music plan must start at 0');
  for (const c of plan.cues) need(c.from_sec < nd && c.mood && c.prompt, 'bad music cue');
  return { clips: sc.length, seconds: r3(total), lines: lines.length };
}

const du = (d) => { let n = 0; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); n += e.isDirectory() ? du(p) : statSync(p).size; } return n; };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), o = { motionFrom: [], musicFrom: [] };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--studio') o.studio = a[++i]; else if (k === '--project') o.project = a[++i]; else if (k === '--out') o.out = a[++i];
    else if (k === '--motion-from') o.motionFrom.push(a[++i]); else if (k === '--music-from') o.musicFrom.push(a[++i]);
    else if (k === '--sfx-library') o.sfxLibrary = a[++i]; else if (k === '--name') o.name = a[++i]; else if (k === '--force') o.force = true;
    else { console.error(`unknown argument ${k}`); process.exit(2); }
  }
  if (!o.studio || !o.project || !o.out) { console.error('usage: make-pack.mjs --studio <studio> --project <id> --out <dir> [--motion-from <studio>:<id>]... [--music-from <studio>:<id>]... [--sfx-library <dir>] [--name n] [--force]'); process.exit(2); }
  try {
    const p = makePack(o);
    console.log(`pack ok: ${resolve(o.out)} (${(du(resolve(o.out)) / 1e6).toFixed(1)} MB), validation passed`);
    for (const n of p.source.notes) console.log(`- ${n}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
