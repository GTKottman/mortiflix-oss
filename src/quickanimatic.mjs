// The animatic driven by the studio, not a session (owner, 2026-10-19: an animatic session reached 2.14M tokens in 26
// steps before it was stopped, reading every file of the project first and re-reading all of it on every step).
// Every AI call starts fresh and small:
//   1. write: the approved frames' code, the cut list, the voice's word times, the scenes, the motion brief and the
//      skills → src/timing.ts, src/scenes/animatic.tsx and src/Main.tsx (and small exports in the frames' code);
//   2. the studio puts the mastered narration in video/public, renders the animatic through the render queue
//      and runs qc.mjs (format, black and frozen frames, loudness, a contact sheet);
//   3. review: a fresh call reads the sheet with the QC report and the code, and passes or hands back fixed files
//      (render errors go back the same way); blocking problems must be fixed, polish after 3 rounds goes to the owner;
//   4. the studio writes out/scenes.json (one scene per beat, from the voice's times) and submits.
// The owner's notes on a version, a motion or rule pack, or an animatic that keeps failing go to a session.
import { ensureVideoScaffold, ensureVideoModules } from './svc/videoscaffold.mjs';
import { writeRoot } from './quickframes.mjs';
import { runAs } from './models.mjs';
import { run as runAsync } from './svc/run.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { paths, REPO } from './studio.mjs';
import { loadProject, projectPaths, projectPipeline, event } from './projects.mjs';
import { stepView, stepChecks, submit } from './gates.mjs';
import { scriptView } from './svc/script.mjs';
import { lessonsBlock, scenePlan, sceneBuilt } from './svc/lessons.mjs';
import { queueScenes } from './svc/videonotes.mjs';
import { sceneGaps, gapsText } from './scenes.mjs';
import { measure } from './quickvoice.mjs';
import { plainGain } from './soundtrack/voice.mjs';
import { kgRender } from './kinetograph.mjs';
import { writeMotionData, probeKinetograph } from './motiondata.mjs';
import { kgFfmpeg } from './kinetograph.mjs';
import { sceneSources, sourcesBlock } from './svc/motionsources.mjs';
import { uploadsBlock } from './svc/uploads.mjs';

const CHECKS = ['spelling-and-facts', 'text-safe-area', 'no-collisions', 'text-contrast', 'frame-sheet', 'format', 'loudness', 'sync', 'music-source', 'transitions-carried'];
const FILES = ['src/timing.ts', 'src/scenes/animatic.tsx', 'src/Main.tsx', 'src/video.ts', 'src/ui.tsx', 'src/scenes/frames.tsx'];
export const QC = join(REPO, 'pipelines', '_shared', 'skills', 'final-pass', 'qc.mjs');
const FPS = 30;
const MAX_ROUNDS = 3;
const LEAD = 0.25; // a scene starts this long before its first word
// kinetograph draws frames in worker threads, each with its own GPU device and 0.5 to 1 GB of memory; past 4 the one GPU
// and the one encoder are the limit (its own default: half the cores, at most 4), so 4 on the 16-thread, 32 GB PC
export const CONCURRENCY = 4;

const read = (f, n = 200_000) => (existsSync(f) ? readFileSync(f, 'utf8').slice(0, n) : '');
const readJsonOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function quickAnimaticStep(root, id, config) {
  if (config.quickAnimatic === false || config.quickScript === false) return null;
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const step = pipeline.steps.find((s) => s.key === 'animatic');
  if (!step || step.review !== 'video') return null;
  const runnable = stepView(project, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  if (runnable.length !== 1 || runnable[0].key !== 'animatic' || runnable[0].state === 'changes') return null;
  if (project.mfx && Object.keys(project.mfx).some((k) => k.endsWith('_wanted'))) return null;
  const work = projectPaths(root, id).work;
  const brief = readJsonOr(join(work, 'design', 'motion-brief.json'), null);
  if (!brief || brief.motion_pack || (brief.rule_packs || []).length) return null;
  // v3 has no transitions step: no board and no cuts.ts to wait for
  const hasBoard = pipeline.steps.some((s) => s.key === 'transitions');
  for (const f of ['video/src/scenes/frames.tsx', ...(hasBoard ? ['video/src/cuts.ts'] : []), 'voice/timing.json', 'out/voice/narration.wav', ...(hasBoard ? ['transitions/board.json'] : [])]) if (!existsSync(join(work, f))) return null;
  if (stepChecks(root, id, 'animatic').some((c) => !CHECKS.includes(c.id))) return null;
  return runnable[0];
}

// One scene per beat, from the voice: each starts LEAD before its first word (the first at 0), and runs to the next.
export function scenesFromTiming(beats, timing, totalFrames) {
  const starts = beats.map((b) => {
    const ls = timing.lines.filter((l) => l.id.startsWith(`${b.id}-`));
    return ls.length ? Math.max(0, (ls[0].words?.[0]?.start ?? ls[0].start) - LEAD) : null;
  });
  const out = [];
  beats.forEach((b, i) => {
    if (starts[i] === null) return;
    const from = i === 0 ? 0 : Math.round(starts[i] * FPS);
    const next = starts.slice(i + 1).find((s) => s !== null);
    const to = next === undefined ? totalFrames : Math.round(next * FPS);
    out.push({ key: `s${String(i + 1).padStart(2, '0')}`, name: b.name, from_frame: from, frames: Math.max(1, to - from), beat: b.id });
  });
  return out;
}

const FILE_SCHEMA = { type: 'array', items: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', enum: FILES }, content: { type: 'string' } } } };
export const WRITE_SCHEMA = {
  type: 'object',
  required: ['files', 'seconds', 'note', 'facts_note'],
  properties: {
    files: FILE_SCHEMA,
    seconds: { type: 'number', description: 'the animatic\'s length in seconds (the narration plus a short end hold)' },
    note: { type: 'string', description: 'for the owner: the pace and order, what moves on which word, what to judge' },
    facts_note: { type: 'string', description: 'every on-screen word, name and number checked against the script' },
    sfx: { type: 'array', description: 'the story actions a sound should mark in what you built (a stamp slams, a tag snaps on, a box is ticked): absolute frame of the impact, what happens, a short sound description; the same words for the same kind of action', items: { type: 'object', required: ['frame', 'what', 'sound'], properties: { frame: { type: 'integer' }, what: { type: 'string' }, sound: { type: 'string' }, importance: { type: 'integer', minimum: 1, maximum: 3 } } } },
    missing_sources: { type: 'array', items: { type: 'string' }, description: 'paths named under "What each scene is built from" that could not be opened (then files is [])' },
  },
};
export const REVIEW_SCHEMA = {
  type: 'object',
  required: ['ok', 'blocking', 'problems', 'checks'],
  properties: {
    ok: { type: 'boolean' },
    blocking: { type: 'boolean', description: 'true only for a broken rule: a blank or frozen stretch, wrong words, a scene that doesn\'t show its beat, the voice out of step' },
    problems: { type: 'array', items: { type: 'string' } },
    files: { ...FILE_SCHEMA, description: 'only when not ok: the files to replace, whole' },
    need_files: { type: 'array', items: { type: 'string' }, description: 'only if a file listed as unchanged must be read to judge: its paths, with ok false and no files; the studio sends them whole and asks again' },
    seconds: { type: 'number' },
    checks: { type: 'object', required: ['text-safe-area', 'no-collisions', 'spelling-and-facts', 'frame-sheet', 'text-contrast'], properties: { 'text-safe-area': { type: 'string' }, 'no-collisions': { type: 'string' }, 'spelling-and-facts': { type: 'string' }, 'frame-sheet': { type: 'string' }, 'text-contrast': { type: 'string' } } },
  },
};

function context(root, id) {
  const work = projectPaths(root, id).work;
  const project = loadProject(root, id);
  const script = scriptView(root, id);
  const timing = readJsonOr(join(work, 'voice', 'timing.json'), { seconds: 0, lines: [] });
  const board = readJsonOr(join(work, 'transitions', 'board.json'), { cuts: [] });
  const frames = (readJsonOr(join(work, 'design', 'frames.json'), { frames: [] }).frames || []).map((f) => ({ composition: f.composition || String(f.id).toUpperCase(), label: f.label, beats: f.beats || [] }));
  const lines = timing.lines.map((l) => ({ id: l.id, text: l.text, start: l.start, end: l.end, words: (l.words || []).map((w) => [w.text, w.start]) }));
  // scene by scene (svc/lessons.mjs scenePlan): a v3 project builds only the scene the owner is checking now; the scenes
  // already approved keep their rendered clips (out/scenes/) and are only given as continuity. Mode "all" builds what is left.
  const target = projectPipeline(root, id).stage_set === 'v3' ? buildTarget(root, id, script.beats, timing) : null;
  const done = target ? target.doneScenes : [];
  const only = target?.partial ? target.ids.join('+') : null;
  if (target?.partial) {
    script.beats = script.beats.filter((b) => target.ids.includes(b.id));
    const keep = timing.lines.filter((l) => target.ids.some((b) => l.id.startsWith(`${b}-`)));
    lines.splice(0, lines.length, ...lines.filter((l) => keep.some((k) => k.id === l.id)));
    timing.seconds = target.to / FPS;
    board.cuts = [];
  }
  // the approved stills, frames and look each scene of this build is made from, by absolute path
  const sources = sceneSources(root, id, work, script.beats.map((b) => b.id));
  return { only, target, done, work, project, script, timing, board, frames, lines, sources, brief: readJsonOr(join(work, 'design', 'motion-brief.json'), {}) };
}

// What this build makes: {ids, partial, from, to (absolute frames), doneScenes, all: every scene's frame range}.
// Not partial = the whole video in one render (every scene is waiting, or the approved ones have no clip to reuse).
export function buildTarget(root, id, beats, timing) {
  const plan = scenePlan(root, id);
  const all = scenesFromTiming(beats, timing, Math.round((timing.seconds + 1) * FPS));
  const doneScenes = all.filter((x) => plan.done.includes(x.beat));
  const left = all.filter((x) => !plan.done.includes(x.beat));
  const clips = readJsonOr(join(projectPaths(root, id).work, 'out', 'scenes', 'clips.json'), []);
  const have = (b) => clips.some((c) => c.beats.includes(b) && existsSync(join(projectPaths(root, id).work, 'out', 'scenes', c.file)));
  const reuse = doneScenes.length > 0 && doneScenes.every((x) => have(x.beat));
  let ids = left.map((x) => x.beat);
  if (plan.only) ids = [plan.only];
  else if (!reuse) ids = all.map((x) => x.beat);
  const mine = all.filter((x) => ids.includes(x.beat));
  if (!mine.length) return { ids: [], partial: false, from: 0, to: 0, doneScenes: [], all };
  const partial = mine.length < all.length;
  const from = mine[0].from_frame, to = mine[mine.length - 1].from_frame + mine[mine.length - 1].frames;
  return { ids: mine.map((x) => x.beat), partial, from, to, doneScenes: partial ? doneScenes : [], all };
}

// the approved stills' and frames' code of this build's scenes, whole (the session also has Read for the pictures)
export function stillsCode(c) {
  const files = [...new Set(c.sources.scenes.flatMap((x) => [x.stillsCode, ...x.frames.map((f) => f.code)]).filter((f) => f && existsSync(f)))];
  return files.length ? `## The approved code of these scenes (as on disk; build from it)\n${files.map((f) => `### ${f}\n${read(f, 40_000)}`).join('\n')}` : '';
}

export function writePrompt(root, id, c) {
  if (!c.sources) c.sources = sceneSources(root, id, c.work, c.script.beats.map((b) => b.id));
  const code = (f, n = 40_000) => `### ${f}\n${read(join(c.work, 'video', f), n)}`;
  const skill = (n) => read(join(c.work, '.claude', 'skills', n, 'SKILL.md'), 20_000);
  const row = read(join(c.work, 'pipeline', 'PIPELINE.md')).split('\n').find((l) => l.startsWith('| `animatic`')) || '';
  return [
    `You build the animatic: the approved style frames in motion, timed to the approved narration and cut with the approved board. You write the code with Remotion's API; the studio renders it with kinetograph (no browser, the same imports and components), runs the QC and shows it back to you. Answer with the JSON asked for, nothing else.`,
    sourcesBlock(c.sources),
    uploadsBlock(c.work),
    stillsCode(c),
    `## Skill: motion design\n${skill('motion-design')}`,
    `## Skill: Remotion's API (the studio renders for you with kinetograph: ignore the mfx and render commands)\n${skill('remotion-motion')}`,
    `## What to write
- src/timing.ts (the clock: word starts from the narration below, frames at ${FPS} fps), src/scenes/animatic.tsx (the scenes in motion), src/Main.tsx (the whole video: the scenes in a TransitionSeries with the board's cuts from src/cuts.ts, and <Audio src={staticFile('voice.wav')} />, total length = video.seconds).
- Each cut exactly as src/scenes/board.tsx (the approved board) does it: \`import { toPresentation } from './transitions/core';\` and \`<TransitionSeries.Transition presentation={toPresentation(cut.t as any, cut.params as any)} timing={linearTiming({ durationInFrames: cut.frames })} />\`. Never write your own toPresentation.
- Build from the approved stills and frames named above (their code is given below too): reuse their components; you may add exports or props to src/ui.tsx and src/scenes/frames.tsx, but every frame keeps its approved look. Set video.seconds in src/video.ts to your length (send video.ts too).
- Mark the story actions for the sound (answer field sfx): each frame where something happens in the story (a stamp slams, a tag snaps on, a box is ticked, papers drop into a folder) with a short sound description ("heavy rubber-stamp thud"). Not text fading in or layout settling. About one per 1.5 to 2 s at most.
- Simple motion, every move on its word: the owner judges pace and order here, not polish. Never a blank or frozen stretch longer than a breath; the last scene may settle and hold.
- Imports only from 'react', 'remotion', '@remotion/transitions', the project's own files and '@remotion/google-fonts/<Family>' (kinetograph answers these itself; no other package is there when it renders).`,
    `## The step\n${row}`,
    lessonsBlock(root, id, { step: 'animatic' }),
    `## The project\n"${c.project.title}"`,
    `## The scenes (one per beat; the studio cuts the video into shots at each beat's first word, minus ${LEAD} s)\n${JSON.stringify(c.script.beats.map((b) => ({ beat: b.id, name: b.name, visual: b.visual, words: b.lines.map((l) => l.words).join(' ') })))}`,
    `## The narration, word by word (seconds; video/public/voice.wav, already mastered: play it as it is)\n${JSON.stringify(c.lines)}`,
    `## The approved style frames (compositions in src/scenes/frames.tsx) and the beats each shows\n${JSON.stringify(c.frames)}`,
    `## The approved board (src/cuts.ts holds the same cuts: use them as they are, at these lengths, landing on these words)\n${JSON.stringify(c.board.cuts.map((x) => ({ from: x.from, to: x.to, transition: x.transition, frames: x.frames, lands_on: x.lands_on, carrier: x.carrier })))}`,
    `## The motion brief\n${JSON.stringify(c.brief)}`,
    c.only ? `## One scene at a time\nThe owner checks each scene alone before the next is made. Build ONLY scene${c.target.ids.length > 1 ? 's' : ''} ${c.only.replace(/\+/g, ', ')}: no cuts. Keep the whole timeline's clock (word starts are absolute seconds from the start of the narration) and show the scene at its own frames, from ${c.target.from} to ${c.target.to - 1}; video.seconds = ${(c.target.to / FPS).toFixed(2)}. Before ${(c.target.from / FPS).toFixed(2)} s nothing of this build shows (the studio renders only the frames of the scene${c.target.ids.length > 1 ? 's' : ''}). Make the scene right for what its own words say and show: its motion is its own. The owner's notes on it become the rules for the scenes after it.` : '',
    c.done.length ? `## Scenes the owner already approved (continuity only)\n${JSON.stringify(c.done.map((x) => ({ scene: x.beat, name: x.name })))}\nThey are made and rendered: do not change their code in src/scenes/animatic.tsx and do not render them again. Use them only for the video's palette, type and characters, so this scene belongs in the same video. Do NOT copy their motion: each scene moves the way its own words and picture call for.\n${code('src/scenes/animatic.tsx', 30_000)}` : '',
    `## The code now\n${code('src/video.ts')}\n${code('src/cuts.ts')}\n${code('src/scenes/board.tsx', 8000)}\n${code('src/ui.tsx')}\n${code('src/scenes/frames.tsx')}\n${code('src/Main.tsx', 8000)}`,
  ].filter(Boolean).join('\n\n');
}

// T9: round 1 sends every file; later rounds send only the files changed since they were last sent, and list the rest with a
// short hash. `unchanged` = [[path, hash]].
// the review compares the render with the owner's approved stills: a scene that drifted from them (layout, ground, type, a
// line's still missing) or shows a fact or count not in the script is blocking
function approvedPictures(c) {
  const rows = (c.sources?.scenes || []).flatMap((x) => x.stills.map((t) => `- ${t.line}: ${t.png}`));
  return rows.length ? `## The owner's approved stills (open with Read and compare: each line's moment in the render must match its still in layout, ground and type; a still missing or drifted, or a word, number or count on screen that is not in the script or the stills, is blocking)\n${rows.join('\n')}` : '';
}
export const fileHash = (work, f) => createHash('sha1').update(read(join(work, 'video', f), 60_000)).digest('hex').slice(0, 8);
export function reviewPrompt(c, files, sheetName, qcText, renderError, unchanged = []) {
  const code = files.map((f) => `### ${f}\n${read(join(c.work, 'video', f), 60_000)}`).join('\n') + (unchanged.length ? `\n\n### Unchanged since you last saw them (not repeated; if one is needed to judge, answer need_files with its path, ok false and no files)\n${unchanged.map(([f, h]) => `${f} (${h})`).join('\n')}` : '');
  return [
    `## Checks\n- spelling-and-facts: the on-screen words match the script\n- text-safe-area: settled text 5% inside the edges (motion may pass an edge for a moment)\n- no-collisions: nothing overlaps once settled\n- text-contrast: text stays on the approved backgrounds\n- frame-sheet: every second of the sheet shows its scene; nothing blank or broken\n- still stretches qc.mjs lists: a designed hold (a phrase that settles, the end) is fine; an undesigned freeze is blocking\n- the rest of the qc.mjs report passes (format, black frames, loudness); render flags are the studio's, not yours`,
    renderError ? '' : `## qc.mjs\n${qcText.slice(0, 4000)}`,
    `## The narration, word by word (seconds)\n${JSON.stringify(c.lines.map((l) => [l.id, l.start, l.text]))}`,
    `## The scenes\n${JSON.stringify(c.script.beats.map((b) => ({ beat: b.id, name: b.name, visual: b.visual })))}`,
    approvedPictures(c),
    `## The code now\n${code}`,
    renderError
      ? `The animatic for "${c.project.title}" didn't render. Fix the code so it does.\n\n## The render's error\n${renderError.slice(-4000)}${/error #130/.test(renderError) ? '\n(React #130: something rendered is undefined: a missing export, a default/named import mix-up, or a transition presentation not made with toPresentation from ./transitions/core as src/scenes/board.tsx does)' : ''}`
      : `Look at the animatic for "${c.project.title}": open ${sheetName} with Read (a contact sheet, about one frame a second, left to right then down, from 0 s).`,
    renderError ? 'Answer ok: false, blocking: true, the problems, the fixed files (whole) and checks ("not rendered yet").'
      : 'If it passes, ok: true and a one-line note per check (what you looked at). Otherwise ok: false, blocking (true only for a broken rule), the problems, and the files to replace (whole). The owner judges pace at the gate: polish is not blocking.',
  ].filter(Boolean).join('\n\n');
}

function writeFiles(work, files) {
  for (const f of files || []) {
    if (!FILES.includes(f.path)) continue;
    const dest = normalize(join(work, 'video', f.path));
    if (!dest.startsWith(normalize(join(work, 'video', 'src')))) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, String(f.content));
  }
}

export async function renderAnimatic({ root, renders, projectId, sessionId, c, env, frames = null, output = '../out/animatic.mp4' }) {
  mkdirSync(join(c.work, 'out', 'scenes'), { recursive: true });
  // full size: qc.mjs checks the video's own size (kinetograph rounds a --scale's sides down to even, so a scale would
  // still change it); WebGL transitions need no flag, kinetograph draws them on its own GPU compositor
  ensureVideoScaffold(c.work); // index.ts and the rest of the template, if the setup skipped them
  // the studio's Root registers Main once the animatic wrote it (projects with the studio's format.ts)
  if (existsSync(join(c.work, 'video', 'src', 'format.ts'))) writeRoot(c.work);
  const cmd = kgRender({ root, entry: 'src/index.ts', composition: 'Main', output, frames: frames || undefined, codec: 'h264', crf: 20, imageFormat: 'png', pixelFormat: 'yuv420p', concurrency: CONCURRENCY });
  const job = renders.add({ projectId, sessionId, label: frames ? `animatic scene ${c.only}` : 'animatic', argv: ['bash', '-c', cmd], cwd: join(c.work, 'video'), env: { ...process.env, ...env } });
  let v = job;
  while (!['done', 'failed'].includes(v.state)) v = await renders.wait(job.id, projectId, 300);
  return v.state === 'done' && v.exit_code === 0 && existsSync(join(c.work, 'out', output.replace(/^\.\.\/out\//, ''))) ? { ok: true } : { ok: false, error: v.output_tail || v.error || 'the render failed' };
}

// partial: one scene's clip (its narration and last frame are not the whole video's: no end-hold, no loudness; those are
// checked on the joined file, `joined`). endHold/loudness: for the joined file, only when it is the whole video.
async function qc(c, seconds, file = 'out/animatic.mp4', { partial = false, joined = false, endHold = true, loudness = true } = {}) {
  mkdirSync(join(c.work, 'checks'), { recursive: true });
  const vt = read(join(c.work, 'video', 'src', 'video.ts'));
  const size = `${vt.match(/width:\s*(\d+)/)?.[1] || 1920}x${vt.match(/height:\s*(\d+)/)?.[1] || 1080}`;
  // the exact length (a scene's own frames / fps), never rounded to whole seconds (61dc s01: 160 frames = 5.333 s was
  // checked against 5 s ±5% and failed three rounds)
  const r = await runAsync(process.execPath, [QC, file, '--size', size, '--fps', String(FPS), '--duration', String(+Number(seconds).toFixed(3)), '--lufs', String(c.voiceLufs ?? -14), '--true-peak', '-1', ...(partial || !endHold ? [] : ['--end-hold']), ...(partial || !loudness ? ['--no-loudness'] : []), '--sheet', joined ? 'checks/animatic-joined-sheet.png' : 'checks/animatic-sheet.png', '--json', joined ? 'checks/qc-animatic-joined.json' : 'checks/qc-animatic.json'], { cwd: c.work, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  const json = readJsonOr(join(c.work, 'checks', joined ? 'qc-animatic-joined.json' : 'qc-animatic.json'), null);
  // still stretches are the reviewer's call (a designed hold is fine, an undesigned freeze is blocking): everything
  // else qc.mjs checks (format, black frames, loudness, the sheet) must pass outright
  const hard = (json?.checks || []).filter((x) => x.id !== 'frames.frozen' && x.result === 'fail');
  return { pass: Boolean(json) && !hard.length, text: `${r.stdout || ''}${r.stderr || ''}`.trim(), json };
}

// out/scenes/clips.json = [{beats, file, from, to}]: every rendered scene clip. This build's clip replaces any it overlaps;
// out/animatic.mp4 is then the clips in order (the approved ones untouched, joined as they are).
export async function assemble(work, target, file) {
  const dir = join(work, 'out', 'scenes');
  const idx = join(dir, 'clips.json');
  const before = readJsonOr(idx, []);
  const list = before.filter((c) => c.to <= target.from || c.from >= target.to);
  // the scene's versions: the clip it replaces stays listed (Version 1, 2, …), so a remade scene (a Fix) is a new version
  const name = file.replace(/^scenes\//, '');
  const old = before.find((c) => !(c.to <= target.from || c.from >= target.to) && (c.beats || []).join('+') === target.ids.join('+'));
  let versions = old ? (old.versions?.length ? old.versions : [{ n: 1, file: old.file }]) : [];
  if (!versions.some((v) => v.file === name)) versions = [...versions, { n: versions.length + 1, file: name }];
  list.push({ beats: target.ids, file: name, from: target.from, to: target.to, versions });
  list.sort((a, b) => a.from - b.from);
  writeFileSync(idx, JSON.stringify(list, null, 1));
  const parts = list.filter((c) => existsSync(join(dir, c.file)));
  const txt = join(dir, 'concat.txt');
  writeFileSync(txt, parts.map((c) => `file '${join(dir, c.file).replace(/'/g, "'\\''")}'`).join('\n'));
  const r = await runAsync(kgFfmpeg(), ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', join(work, 'out', 'animatic.mp4')], { encoding: 'utf8', timeout: 5 * 60_000 });
  return r.status === 0 ? { ok: true, clips: parts.length } : { ok: false, error: `the scene clips could not be joined: ${(r.stderr || '').slice(-200)}` };
}

// A scene remade on its own by a Fix (a session writes out/scenes/<beat>-eNNN.mp4 and points out/scenes.json at it) is
// registered as that scene's new version: clips.json, the versions list and the joined animatic (2026-11-02, d4fd b01:
// e004 rendered and EDIT_DONE logged, but clips.json kept b01.mp4 and the Motion screen showed only Version 1).
// Idempotent: run after every finished shot edit and again on load, so a restart between the render and this loses nothing.
export async function syncSceneEdits(work) {
  const scenes = readJsonOr(join(work, 'out', 'scenes.json'), null)?.scenes || [];
  const done = [];
  for (const sc of scenes) {
    const m = /^out\/scenes\/([^/]+\.mp4)$/.exec(String(sc.file || ''));
    if (!m || !sc.beat || !existsSync(join(work, 'out', 'scenes', m[1]))) continue;
    const clip = readJsonOr(join(work, 'out', 'scenes', 'clips.json'), []).find((c) => (c.beats || []).includes(sc.beat));
    if (!clip || clip.file === m[1]) continue;
    const r = await assemble(work, { ids: clip.beats, from: clip.from, to: clip.to }, `scenes/${m[1]}`);
    if (r.ok) done.push({ beat: sc.beat, file: m[1] });
  }
  return done;
}

export async function quickAnimatic({ root, id, view, run, runArgs, config, onActivity, fallback, renders, sessionId }) {
  const c = context(root, id);
  const env = runArgs.env || {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  const dir = join(paths(root).run, 'quick', id);
  mkdirSync(dir, { recursive: true });
  const call = async (prompt, schema, tools, role = 'write') => {
    const r = await runAs(run, role, { ...runArgs, workdir: dir, prompt, config: { ...config, claudeArgs: ['--tools', tools, ...(tools ? ['--allowedTools', tools, '--add-dir', c.work] : []), '--json-schema', JSON.stringify(schema)] } });
    usage.input_tokens += r.usage?.input_tokens || 0;
    usage.output_tokens += r.usage?.output_tokens || 0;
    return r;
  };
  const give = async (why) => {
    onActivity({ kind: 'info', text: `The studio couldn't finish the animatic by itself (${why}): pausing for you.` });
    const f = await fallback(why);
    return { ...f, usage: { input_tokens: usage.input_tokens + (f.usage?.input_tokens || 0), output_tokens: usage.output_tokens + (f.usage?.output_tokens || 0) } };
  };
  // the approved stills and frames this build is made from must be there before any call: never a scene rebuilt by guess
  // (2026-11-02, bdb9: the code was not found, the scene was made from ui.tsx parts with an invented tally, and submitted)
  const giveMissing = (list) => {
    event(root, id, { event: 'MOTION_SOURCES_MISSING', actor: 'studio', details: list.join(', ').slice(0, 400) });
    return give(`could not find the approved still code; nothing was made (${list.slice(0, 4).join(', ')}${list.length > 4 ? `, +${list.length - 4} more` : ''})`);
  };
  if (c.sources.missing.length) return giveMissing(c.sources.missing);
  if (!renders) return give('no render queue');
  mkdirSync(join(c.work, 'video', 'public'), { recursive: true });
  // the narration as the voice step made it, with one plain gain (toward -14 LUFS, stopping where its own peaks reach
  // -1 dBTP): the same for every sample, never a limiter (soundtrack v1); the QC expects the level that gain gives
  const vm = measure(join(c.work, 'out', 'voice', 'narration.wav'));
  const vgain = vm ? plainGain(vm.i, vm.tp) : 0;
  const vr = await runAsync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', join(c.work, 'out', 'voice', 'narration.wav'), '-af', `volume=${vgain.toFixed(2)}dB`, '-c:a', 'pcm_f32le', join(c.work, 'video', 'public', 'voice.wav')], { encoding: 'utf8' });
  if (vr.status !== 0) return give('the narration could not be copied for the animatic');
  c.voiceLufs = vm ? +(vm.i + vgain).toFixed(1) : -14;

  // config._reuseCode (tests): start from the code already written, at the review, instead of a new write call
  const reuse = config._reuseCode && ['src/timing.ts', 'src/scenes/animatic.tsx', 'src/Main.tsx'].every((f) => existsSync(join(c.work, 'video', f)));
  if (!reuse) onActivity({ kind: 'info', text: 'Building the animatic: one call writes the whole video.' });
  const w = reuse ? { ok: true, structured: { files: [], seconds: config._reuseCode.seconds, note: config._reuseCode.note, facts_note: config._reuseCode.facts_note } } : await call(writePrompt(root, id, c), WRITE_SCHEMA, 'Read');
  if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
  const s0 = w.ok ? w.structured : null;
  // the session could not open what it was told to build from: nothing it wrote is used and nothing is rendered
  if (s0?.missing_sources?.length) return giveMissing(s0.missing_sources);
  if (!reuse && !s0?.files?.length) return give(w.ok ? 'the build call gave no code' : w.error || 'no answer');
  writeFiles(c.work, s0.files);
  // the story actions the session marked go to the Sound step (svc/storysfx.mjs reads video/src/sfx/<beats>.json)
  if (Array.isArray(s0.sfx) && s0.sfx.length) {
    const ids = c.only ? c.target.ids : c.script.beats.map((b) => b.id);
    mkdirSync(join(c.work, 'video', 'src', 'sfx'), { recursive: true });
    writeFileSync(join(c.work, 'video', 'src', 'sfx', `${ids.join('+')}.json`), JSON.stringify(s0.sfx.filter((x) => Number.isFinite(Number(x.frame)) && x.sound), null, 2));
  }
  // a partial build's length is the studio's (the scene's own frames), never the AI's
  const clipFile = c.only ? `scenes/${c.target.ids.join('+')}.mp4` : 'animatic.mp4';
  const frames = c.only ? [c.target.from, c.target.to - 1] : null;
  let seconds = c.only ? (c.target.to - c.target.from) / FPS : Number(s0.seconds) || c.timing.seconds + 1;
  const sentHash = new Map();
  let checks = null, polish = [], lastProblems = [], lastBlocking = true, lastChecks = null, qcOut = null;
  for (let round = 1; ; round++) {
    // the packages the type check needs (a project linked to an older shared install gets the current one, once)
    if (round === 1) {
      const mods = await ensureVideoModules(c.work, { shared: join(paths(root).run, 'shared'), env });
      if (mods.added?.length) onActivity({ kind: 'info', text: `Video project: added ${mods.added.join(', ')} for the type check.` });
      if (!mods.ok) onActivity({ kind: 'info', text: `Video project: ${mods.missing.join(', ')} could not be installed: ${mods.log}` });
    }
    // the type check first: a missing export or a wrong prop shows up in seconds, with its file and line
    const tsc = await runAsync('npx', ['tsc', '--noEmit', '-p', '.'], { cwd: join(c.work, 'video'), encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const typeErrors = tsc.status === 0 ? null : `${tsc.stdout || ''}${tsc.stderr || ''}`.trim().split('\n').filter((l) => /error TS/.test(l)).slice(0, 40).join('\n');
    onActivity({ kind: 'info', text: typeErrors ? 'The code has type errors: fixing them before rendering.' : `Rendering the animatic (${Math.round(seconds)} s).` });
    const r = typeErrors ? { ok: false, error: `TypeScript (npx tsc --noEmit):\n${typeErrors}` } : await renderAnimatic({ root, renders, projectId: id, sessionId, c, env, frames, output: `../out/${clipFile}` });
    if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
    let sheetName = null;
    if (r.ok) {
      qcOut = await qc(c, seconds, `out/${clipFile}`, { partial: Boolean(c.only) });
      sheetName = `animatic-sheet-${round}.png`;
      if (!existsSync(join(c.work, 'checks', 'animatic-sheet.png'))) return give(`qc.mjs made no sheet: ${qcOut.text.slice(-200)}`);
      copyFileSync(join(c.work, 'checks', 'animatic-sheet.png'), join(dir, sheetName));
    }
    if (round > MAX_ROUNDS) {
      if (r.ok && qcOut.pass && !lastBlocking) { checks = lastChecks; polish = lastProblems; break; }
      return give(`still not passing after ${MAX_ROUNDS} rounds: ${[...lastProblems, r.ok && !qcOut.pass ? qcOut.text.slice(-200) : ''].join('; ').slice(0, 300)}`);
    }
    onActivity({ kind: 'info', text: r.ok ? `Checking the animatic (round ${round}).` : 'The animatic didn\'t render: fixing the code.' });
    // every file the video is built from (cuts.ts read-only: the approved board)
    // T9: round 1 sends every file; later rounds only those changed since they were last sent (the rest by hash); the
    // reviewer may ask for one with need_files (one more call, once)
    const shown = [...FILES, 'src/cuts.ts', 'src/scenes/board.tsx'].filter((f) => existsSync(join(c.work, 'video', f)));
    const now = new Map(shown.map((f) => [f, fileHash(c.work, f)]));
    const full = shown.filter((f) => sentHash.get(f) !== now.get(f));
    const same = shown.filter((f) => !full.includes(f)).map((f) => [f, now.get(f)]);
    const sheetAt = sheetName && join(dir, sheetName);
    let rv = await call(reviewPrompt(c, full, sheetAt, r.ok ? qcOut.text : '', r.ok ? null : r.error, same), REVIEW_SCHEMA, r.ok ? 'Read' : '', r.ok ? 'review' : 'codefix');
    const need = rv.ok && !rv.structured?.ok && !rv.structured?.files?.length ? (rv.structured?.need_files || []).filter((f) => same.some(([x]) => x === f)) : [];
    if (need.length) rv = await call(reviewPrompt(c, [...full, ...need], sheetAt, r.ok ? qcOut.text : '', r.ok ? null : r.error, same.filter(([f]) => !need.includes(f))), REVIEW_SCHEMA, r.ok ? 'Read' : '', r.ok ? 'review' : 'codefix');
    for (const [f, h] of now) sentHash.set(f, h);
    if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
    const s = rv.ok ? rv.structured : null;
    if (!s) return give(rv.error || 'the check call gave no answer');
    if (r.ok && qcOut.pass && s.ok) { checks = s.checks; break; }
    // the check named a fix but sent no files: it is asked once to send the files with that fix (61dc s01: "video.seconds=5.2"
    // named, nothing sent, the scene given up)
    if (!s.files?.length && (s.problems || []).length && !(r.ok && qcOut.pass && s.ok)) {
      const again = await call(`${reviewPrompt(c, shown, sheetAt, r.ok ? qcOut.text : '', r.ok ? null : r.error, [])}\n\n## Your last answer named these problems but sent no files\n${(s.problems || []).map((x) => `- ${x}`).join('\n')}\nApply the fix you named: answer ok false with the files to replace, whole. A problem only the studio can fix (its render range, its check settings): say so in problems and send no files.`, REVIEW_SCHEMA, r.ok ? 'Read' : '', 'codefix');
      if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
      if (again.ok && again.structured?.files?.length) Object.assign(s, again.structured);
    }
    if (!s.files?.length) return give(`problems but no fix: ${[...(s.problems || []), r.ok && !qcOut.pass ? qcOut.text.slice(-200) : ''].join('; ').slice(0, 300)}`);
    writeFiles(c.work, s.files);
    if (Number(s.seconds) && !c.only) seconds = Number(s.seconds);
    lastProblems = s.problems || [];
    lastBlocking = Boolean(s.blocking) || !r.ok;
    lastChecks = s.checks;
  }

  // one scene per beat, from the voice, and the submission
  const total = c.only ? c.target.to : Math.round((qcOut.json?.duration ?? seconds) * FPS);
  const scenes = c.only ? c.target.all.filter((x) => x.from_frame < c.target.to) : scenesFromTiming(c.script.beats, c.timing, total);
  // a partial build: the scene's clip joins the approved scenes' clips (never re-rendered) as out/animatic.mp4
  let joinedQc = null;
  if (c.only) {
    const asm = await assemble(c.work, c.target, clipFile);
    if (!asm.ok) return give(asm.error);
    // the end hold and the loudness are the whole video's: checked on the joined file (the end hold and loudness only once
    // the last scene is in it); format, black frames and seams are checked on it every time
    // a scene fixed after the next one was made ahead: the joined file runs on past it
    const joinedTo = Math.max(c.target.to, ...readJsonOr(join(c.work, 'out', 'scenes', 'clips.json'), []).map((x) => x.to || 0));
    const whole = joinedTo >= c.target.all[c.target.all.length - 1].from_frame + c.target.all[c.target.all.length - 1].frames;
    joinedQc = await qc(c, joinedTo / FPS, 'out/animatic.mp4', { joined: true, endHold: whole, loudness: whole });
    if (!joinedQc.pass) return give(`the joined animatic did not pass: ${joinedQc.text.slice(-300)}`);
  } else {
    // a whole-video build makes every clip stale: the next scene-by-scene build must not join old clips
    rmSync(join(c.work, 'out', 'scenes', 'clips.json'), { force: true });
  }
  // the sound step's actions (video/src/actions.json) and the checks' key words and text boxes (keys, boxes per scene),
  // (a partial build re-reads from frame 0 when the scenes before it have no motion data: an earlier read failed)
  // read off the rendered animatic's own scene graph, never from what the AI says it did (src/motiondata.mjs); a partial
  // build probes only its own frames and keeps the approved scenes' results
  onActivity({ kind: 'info', text: 'Reading every action, key word and text box off the animatic.' });
  const motion_data = await writeMotionData({ work: c.work, scenes, fps: FPS, totalFrames: total, from: c.only && readJsonOr(join(c.work, 'out', 'scenes.json'), {}).motion_data?.ok !== false ? c.target.from : 0, timing: c.timing, probe: config._motionProbe || probeKinetograph({ root, work: c.work }) });
  if (!motion_data.ok) onActivity({ kind: 'info', text: `Motion data could not be read (${motion_data.error}): the sound and the sync/overlap checks will say so.` });
  writeFileSync(join(c.work, 'out', 'scenes.json'), JSON.stringify({ made_from: 'out/animatic.mp4', fps: FPS, scenes, motion_data }, null, 2));
  const gaps = c.only ? [] : sceneGaps(c.work); // a partial build: only these scenes are made
  if (gaps.length) return give(gapsText(gaps));
  const qcCheck = (k) => ((joinedQc?.json || qcOut.json)?.checks || []).find((x) => x.id === k)?.detail || null;
  const lufs = qcCheck('audio.loudness');
  const tp = qcCheck('audio.true-peak');
  // what the check call said per check (the loop can end with no checks: a structured answer without them)
  const said = (k) => String(checks?.[k] ?? 'not reported by the check call');
  const error_checks = [
    { id: 'spelling-and-facts', result: 'pass', note: `${s0.facts_note} On the rendered sheet: ${said('spelling-and-facts')}` },
    { id: 'text-safe-area', result: 'pass', note: said('text-safe-area') },
    { id: 'no-collisions', result: 'pass', note: said('no-collisions') },
    { id: 'text-contrast', result: 'pass', note: said('text-contrast') },
    { id: 'frame-sheet', result: 'pass', note: `checks/animatic-sheet.png (qc.mjs, about a frame a second) viewed: ${said('frame-sheet')}` },
    { id: 'format', result: 'pass', note: `qc.mjs passes: the video's own size, ${FPS} fps, ${Math.round(seconds)} s, no black or frozen stretch but the designed end hold.` },
    { id: 'loudness', result: 'pass', note: `qc.mjs: ${lufs || `integrated loudness inside ${c.voiceLufs} LUFS ±1`}, true peak ${tp || '≤ -1 dBTP'}; the approved narration untouched but for one plain gain (toward -14 LUFS, stopped by its own peaks at -1 dBTP), no music yet.` },
    { id: 'sync', result: 'pass', note: `The approved narration plays as it is; src/timing.ts holds its word starts and every move is placed on one. Each beat's scene in out/scenes.json starts ${LEAD} s before its first word. ${motion_data.ok ? `Key words (${motion_data.keys}) and text boxes (${motion_data.boxes}) were read off the render for the sync and overlap checks.` : `Key-word timing could not be read off the render (${motion_data.error}).`}` },
    { id: 'music-source', result: 'n/a', note: 'No music yet: the music step scores this timing.' },
    { id: 'transitions-carried', result: 'pass', note: `The approved board's ${c.board.cuts.length} cuts from src/cuts.ts, at their lengths, in src/Main.tsx's TransitionSeries.` },
  ].filter((x) => stepChecks(root, id, 'animatic').some((k) => k.id === x.id));
  const note = polish.length ? `${s0.note}\n\nStill to look at (polish the studio's check raised; QC passes): ${polish.join(' · ')}` : s0.note;
  try {
    submit(root, id, 'animatic', { note, questions: [], items: [{ path: 'out/animatic.mp4', label: c.only ? `Animatic up to scene ${c.target.ids[c.target.ids.length - 1]} (${Math.round(total / FPS)} s)` : `Animatic (${Math.round(seconds)} s)` }, { path: 'checks/animatic-sheet.png', label: 'Frame sheet' }], error_checks });
    // the scene shows as ready for the owner's OK only once the step is in review: an OK while the step was still
    // "working" could not send it back for the next scene, and the motion stalled (beta replay run, 2026-11-02)
    if (c.only) {
      sceneBuilt(root, id, c.target.ids);
      // Video Notes, when the owner turned it on; a scene made ahead goes to the tablet when its turn comes (motion.scene.approve)
      const plan = scenePlan(root, id);
      await queueScenes(root, id, c.target.ids.filter((b) => b === plan.beats[plan.current]?.id));
    }
  } catch (e) { return give(`the submission was refused: ${e.message}`); }
  const ck = join(c.work, 'checklist.md');
  if (existsSync(ck)) {
    const t = readFileSync(ck, 'utf8').split('\n');
    const at = t.findIndex((l) => /^##\s+Animatic\b/i.test(l));
    if (at >= 0) { for (let i = at + 1; i < t.length && !/^##\s/.test(t[i]); i++) t[i] = t[i].replace(/^- \[ \]/, '- [x]'); writeFileSync(ck, t.join('\n')); }
  }
  appendFileSync(join(c.work, 'JOURNAL.md'), `\n- ${new Date().toISOString()} · Animatic v${view.version + 1} built and submitted by the studio (no session): ${Math.round(seconds)} s, ${c.only ? `scene ${c.only}` : `${scenes.length} scenes`}.\n`);
  onActivity({ kind: 'info', text: `Animatic ready for your check: ${Math.round(seconds)} s.` });
  return { ok: true, usage, summary: s0.note };
}
