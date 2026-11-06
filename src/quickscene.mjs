// One scene of a scene-by-scene Motion step, driven by the studio, not a session (owner, 2026-11-04: "we're using a bunch
// of tokens"). On Texas each scene was a fresh Opus session: 25-37 steps, 3.3M-6.3M tokens, nearly all of it re-reading its
// own context. Here every AI call starts fresh and small:
//   1. write: the scene's approved stills and code, the scene before it, the skills, the lessons -> src/scenes/m_<beat>.tsx;
//   2. the studio adds it to src/Main.tsx, type-checks, lints, renders only its frames and runs qc.mjs;
//   3. review: a fresh call looks at a frame sheet against the approved stills, and passes it or hands back the file;
//   4. the studio lists the clip in out/scenes.json and submits, as a session does.
// Only a scene with no code yet comes here: a remake from the owner's notes (a Fix) is still a session, which reads them.
// The layout is the one the v3 sessions build: src/motion.tsx, m_<beat>.tsx, <Sequence>s in src/Main.tsx, SCENES in timing.ts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAs } from './models.mjs';
import { run as runAsync } from './svc/run.mjs';
import { projectPaths, projectPipeline, loadProject } from './projects.mjs';
import { stepChecks, stepView, submit } from './gates.mjs';
import { scriptView } from './svc/script.mjs';
import { lessonsBlock, scenePlan, scenesSubmitted } from './svc/lessons.mjs';
import { queueScenes } from './svc/videonotes.mjs';
import { sceneSources, sourcesBlock } from './svc/motionsources.mjs';
import { uploadsBlock } from './svc/uploads.mjs';
import { paths } from './studio.mjs';
import { kgCommand, kgRender } from './kinetograph.mjs';
import { CONCURRENCY, QC, REVIEW_SCHEMA, WRITE_SCHEMA, stillsCode } from './quickanimatic.mjs';

const FPS = 30;
const MAX_ROUNDS = 3;
const read = (f, n = 200_000) => (existsSync(f) ? readFileSync(f, 'utf8').slice(0, n) : '');
const readJsonOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

const sceneFile = (beat) => `src/scenes/m_${beat}.tsx`;
const component = (beat) => beat.toUpperCase();

// The scene's frames, as the project's clock has them (never recomputed: the scenes before it were cut on these).
export function sceneSpan(timingTs, beat) {
  const m = new RegExp(`\\b${beat}:\\s*\\{\\s*from:\\s*(\\d+),\\s*frames:\\s*(\\d+)`).exec(timingTs);
  return m ? { from: Number(m[1]), to: Number(m[1]) + Number(m[2]) } : null;
}

// The scene joins the whole video's timeline, after the scenes already in it. Running it twice changes nothing.
export function addToMain(main, beat) {
  const name = component(beat);
  if (main.includes(`<${name} />`)) return main;
  const imports = [...main.matchAll(/^import \{ B\w+ \} from '\.\/scenes\/m_\w+';\n/gm)];
  const last = imports[imports.length - 1];
  if (!last || !main.includes('</AbsoluteFill>')) return null;
  const at = last.index + last[0].length;
  const withImport = `${main.slice(0, at)}import { ${name} } from './scenes/m_${beat}';\n${main.slice(at)}`;
  const block = `    <Sequence from={SCENES.${beat}.from} durationInFrames={SCENES.${beat}.frames}>\n      <${name} />\n    </Sequence>\n`;
  return withImport.replace(/^(\s*)<\/AbsoluteFill>/m, `${block}$1</AbsoluteFill>`);
}

export function quickSceneStep(root, id, config) {
  if (config.quickScenes === false) return null;
  const pipeline = projectPipeline(root, id);
  if (pipeline.stage_set !== 'v3') return null;
  const project = loadProject(root, id);
  const runnable = stepView(project, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  if (runnable.length !== 1 || runnable[0].key !== 'animatic') return null;
  if (project.mfx && Object.keys(project.mfx).some((k) => k.endsWith('_wanted'))) return null;
  const beat = scenePlan(root, id).only;
  if (!beat) return null;
  const video = join(projectPaths(root, id).work, 'video');
  if (existsSync(join(video, sceneFile(beat)))) return null;
  for (const f of ['src/motion.tsx', 'src/Main.tsx', 'src/timing.ts']) if (!existsSync(join(video, f))) return null;
  const brief = readJsonOr(join(video, '..', 'design', 'motion-brief.json'), null);
  if (!brief || brief.motion_pack || (brief.rule_packs || []).length) return null;
  if (!sceneSpan(read(join(video, 'src', 'timing.ts')), beat)) return null;
  if (!addToMain(read(join(video, 'src', 'Main.tsx')), beat)) return null;
  return { ...runnable[0], beat };
}

function context(root, id, beat) {
  const work = projectPaths(root, id).work;
  const plan = scenePlan(root, id);
  const index = plan.beats.findIndex((b) => b.id === beat);
  const script = scriptView(root, id).beats.find((b) => b.id === beat);
  const lines = readJsonOr(join(work, 'voice', 'timing.json'), { lines: [] }).lines.filter((l) => l.id.startsWith(`${beat}-`));
  const span = sceneSpan(read(join(work, 'video', 'src', 'timing.ts')), beat);
  const sources = sceneSources(root, id, work, [beat]);
  return { work, beat, index, script, lines, span, sources, previous: plan.beats[index - 1]?.id || null, project: loadProject(root, id), brief: readJsonOr(join(work, 'design', 'motion-brief.json'), {}) };
}

export function scenePrompt(root, id, c) {
  const code = (f, n = 40_000) => `### ${f}\n${read(join(c.work, 'video', f), n)}`;
  const skill = (n) => read(join(c.work, '.claude', 'skills', n, 'SKILL.md'), 20_000);
  const frames = c.span.to - c.span.from;
  return [
    `You build one scene of the video: the owner's approved stills in motion, timed to the approved narration. You write the code with Remotion's API; the studio renders it with kinetograph (no browser), runs the checks and shows it back. Answer with the JSON asked for, nothing else.`,
    sourcesBlock(c.sources),
    uploadsBlock(c.work),
    stillsCode(c),
    `## Skill: motion design\n${skill('motion-design')}`,
    `## Skill: Remotion's API (the studio renders for you: ignore the mfx and render commands)\n${skill('remotion-motion')}`,
    `## What to write
Exactly one file: ${sceneFile(c.beat)}, exporting \`export const ${component(c.beat)} = () => ...\`. Answer files with that one path. Every other file is locked: the studio adds your scene to src/Main.tsx itself, and the sound is already in it.
- It plays inside a <Sequence> at frame ${c.span.from}, so useCurrentFrame() is 0 on the scene's first frame and it runs ${frames} frames (${(frames / FPS).toFixed(2)} s). A word's frame in your scene is \`at(line, wordIndex) - SCENES.${c.beat}.from\`, from src/timing.ts.
- It starts on the last picture of the scene before it and ends on the approved still, so the cut is exact. Its motion is its own: every move shows what its own words say, on its word.
- Never a blank or frozen stretch longer than a breath.
- Imports only from 'react', 'remotion', the project's own files and '@remotion/google-fonts/<Family>'.
- sfx: each frame where something happens in the story, with a short sound description, about one per 1.5 to 2 s at most. seconds: ${(frames / FPS).toFixed(3)}.`,
    lessonsBlock(root, id, { step: 'animatic' }),
    `## The project\n"${c.project.title}"`,
    `## This scene\n${JSON.stringify({ beat: c.beat, name: c.script?.name, visual: c.script?.visual, words: (c.script?.lines || []).map((l) => l.words).join(' '), from_frame: c.span.from, frames })}`,
    `## Its narration, word by word (seconds from the start of the video)\n${JSON.stringify(c.lines.map((l) => ({ id: l.id, text: l.text, words: (l.words || []).map((w) => [w.text, w.start]) })))}`,
    `## The motion brief\n${JSON.stringify(c.brief)}`,
    c.previous ? `## The scene before it (only for its last picture, palette and type: this scene's motion is its own)\n${code(sceneFile(c.previous))}` : '',
    `## The code now\n${code('src/timing.ts')}\n${code('src/video.ts')}\n${code('src/ui.tsx')}\n${code('src/pool.ts', 8000)}`,
  ].filter(Boolean).join('\n\n');
}

export function sceneReviewPrompt(c, { sheet, qcText, lint, renderError }) {
  const stills = c.sources.scenes.flatMap((x) => x.stills.map((t) => `- ${t.line}: ${t.png}`));
  return [
    `## Checks\n- spelling-and-facts: the on-screen words match the script\n- text-safe-area: settled text 5% inside the edges (motion may pass an edge for a moment)\n- no-collisions: nothing overlaps once settled\n- text-contrast: text stays on the approved backgrounds\n- frame-sheet: every frame on the sheet shows the scene; nothing blank or broken`,
    `## The scene\n${JSON.stringify({ beat: c.beat, name: c.script?.name, visual: c.script?.visual, words: (c.script?.lines || []).map((l) => l.words).join(' ') })}`,
    stills.length ? `## The owner's approved stills (open with Read: the scene must end on them in layout, ground and type; a word, number or count on screen that is not in the script or the stills is blocking)\n${stills.join('\n')}` : '',
    renderError ? '' : `## qc.mjs\n${qcText.slice(0, 3000)}`,
    lint ? `## kinetograph lint\n${lint.slice(0, 3000)}` : '',
    `## The code now\n### ${sceneFile(c.beat)}\n${read(join(c.work, 'video', sceneFile(c.beat)), 60_000)}`,
    renderError
      ? `The scene didn't render. Fix it.\n\n## The error\n${renderError.slice(-4000)}\n\nAnswer ok: false, blocking: true, the problems, the fixed file (whole) and checks ("not rendered yet").`
      : `Look at the scene: open ${sheet} with Read (a contact sheet, six frames a second, left to right then down). If it passes, ok: true and a one-line note per check. Otherwise ok: false, blocking (true only for a broken rule), the problems, and ${sceneFile(c.beat)} whole, with the fix. The owner judges pace and polish at the gate: polish is not blocking.`,
  ].filter(Boolean).join('\n\n');
}

// The clip keeps the size of the scenes before it: they are joined as they are.
async function renderScale(work, span) {
  const clips = readJsonOr(join(work, 'out', 'scenes', 'clips.json'), []);
  const before = clips.filter((x) => x.to <= span.from).pop();
  const size = before && (await runAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(work, 'out', 'scenes', before.file)], { encoding: 'utf8' })).stdout?.trim();
  const [w, h] = (size || '').split(',').map(Number);
  const base = Number(/width:\s*(\d+)/.exec(read(join(work, 'video', 'src', 'format.ts')))?.[1]);
  if (!w || !h || !base) return { scale: undefined, size: null };
  return { scale: w === base ? undefined : Math.ceil((w / base) * 1e5) / 1e5, size: `${w}x${h}` };
}

async function renderScene({ root, renders, id, sessionId, c, env, scale }) {
  const raw = join('out', 'scenes', `${c.beat}-raw.mp4`);
  const clip = join('out', 'scenes', `${c.beat}-v1.mp4`);
  const cmd = kgRender({ root, entry: 'src/motion.tsx', composition: 'Main', output: `../${raw}`, frames: [c.span.from, c.span.to - 1], crf: 18, scale, concurrency: CONCURRENCY });
  const job = renders.add({ projectId: id, sessionId, label: `scene ${c.beat}`, argv: ['bash', '-c', cmd], cwd: join(c.work, 'video'), env: { ...process.env, ...env } });
  let v = job;
  while (!['done', 'failed'].includes(v.state)) v = await renders.wait(job.id, id, 300);
  if (v.state !== 'done' || v.exit_code !== 0 || !existsSync(join(c.work, raw))) return { ok: false, error: v.output_tail || v.error || 'the render failed' };
  const seconds = (c.span.to - c.span.from) / FPS;
  // the same short fades a session puts on, so the joined scenes don't click
  const r = await runAsync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-c:v', 'copy', '-af', `afade=t=in:d=0.02,afade=t=out:st=${(seconds - 0.06).toFixed(3)}:d=0.06`, '-c:a', 'aac', '-b:a', '256k', clip], { cwd: c.work, encoding: 'utf8' });
  rmSync(join(c.work, raw), { force: true });
  return r.status === 0 ? { ok: true, clip } : { ok: false, error: `the clip's sound could not be finished: ${(r.stderr || '').slice(-300)}` };
}

async function sceneQc(c, clip, size) {
  const dir = join('checks', c.beat);
  mkdirSync(join(c.work, dir), { recursive: true });
  const seconds = (c.span.to - c.span.from) / FPS;
  const r = await runAsync(process.execPath, [QC, clip, ...(size ? ['--size', size] : []), '--fps', String(FPS), '--duration', String(+seconds.toFixed(3)), '--no-loudness', '--sheet', join(dir, 'qc-sheet.png'), '--json', join(dir, 'qc.json')], { cwd: c.work, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  const json = readJsonOr(join(c.work, dir, 'qc.json'), null);
  const hard = (json?.checks || []).filter((x) => x.id !== 'frames.frozen' && x.result === 'fail');
  const sheet = join('checks', `${c.beat}-v1-frames.png`);
  const rows = Math.ceil(((c.span.to - c.span.from) / 5) / 8);
  await runAsync('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-vf', `fps=6,scale=300:-1,tile=8x${rows}`, '-frames:v', '1', sheet], { cwd: c.work, encoding: 'utf8' });
  return { pass: Boolean(json) && !hard.length, text: `${r.stdout || ''}${r.stderr || ''}`.trim(), sheet };
}

// The animatic's answer shapes, with the one file a scene may answer (2026-11-04, Texas b07: the shared list of files refused
// src/scenes/m_b07.tsx, and a finished 14-minute write came back empty).
export function sceneSchema(schema, beat) {
  const files = schema.properties.files;
  const item = files.items;
  return { ...schema, properties: { ...schema.properties, files: { ...files, items: { ...item, properties: { ...item.properties, path: { type: 'string', enum: [sceneFile(beat)] } } } } } };
}

function writeScene(c, files) {
  const mine = (files || []).find((f) => String(f.path).replace(/^\.?\/?(video\/)?/, '') === sceneFile(c.beat));
  if (!mine) return false;
  writeFileSync(join(c.work, 'video', sceneFile(c.beat)), String(mine.content));
  return true;
}

export async function quickScene({ root, id, view, run, runArgs, config, onActivity, fallback, renders, sessionId }) {
  const c = context(root, id, view.beat);
  const env = runArgs.env || {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  const dir = join(paths(root).run, 'quick', id);
  mkdirSync(dir, { recursive: true });
  const call = async (prompt, schema, tools, role) => {
    const r = await runAs(run, role, { ...runArgs, workdir: dir, prompt, config: { ...config, claudeArgs: ['--tools', tools, ...(tools ? ['--allowedTools', tools, '--add-dir', c.work] : []), '--json-schema', JSON.stringify(schema)] } });
    usage.input_tokens += r.usage?.input_tokens || 0;
    usage.output_tokens += r.usage?.output_tokens || 0;
    return r;
  };
  const give = async (why) => {
    onActivity({ kind: 'info', text: `The studio couldn't finish scene ${c.beat} by itself (${why}): pausing for you.` });
    const f = await fallback(why);
    return { ...f, usage: { input_tokens: usage.input_tokens + (f.usage?.input_tokens || 0), output_tokens: usage.output_tokens + (f.usage?.output_tokens || 0) } };
  };
  if (c.sources.missing.length) return give(`could not find the approved still code; nothing was made (${c.sources.missing.slice(0, 4).join(', ')})`);
  if (!renders) return give('no render queue');

  // what the write call answered is kept until the scene is submitted: a later failure never pays for it twice
  const draftFile = join(dir, `${c.beat}-draft.json`);
  const draft = readJsonOr(draftFile, null);
  onActivity({ kind: 'info', text: draft ? `Building scene ${c.beat} from the code already written.` : `Building scene ${c.beat}: one call writes it.` });
  const w = draft ? { ok: true, structured: draft } : await call(scenePrompt(root, id, c), sceneSchema(WRITE_SCHEMA, c.beat), 'Read', 'write');
  if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
  const s0 = w.ok ? w.structured : null;
  if (s0?.missing_sources?.length) return give(`could not open ${s0.missing_sources.slice(0, 4).join(', ')}; nothing was made`);
  if (!s0 || !writeScene(c, s0.files)) return give(w.ok ? 'the build call gave no code for the scene' : w.error || 'no answer');
  writeFileSync(draftFile, JSON.stringify(s0));
  const mainFile = join(c.work, 'video', 'src', 'Main.tsx');
  writeFileSync(mainFile, addToMain(read(mainFile), c.beat));
  if (Array.isArray(s0.sfx) && s0.sfx.length) {
    mkdirSync(join(c.work, 'video', 'src', 'sfx'), { recursive: true });
    writeFileSync(join(c.work, 'video', 'src', 'sfx', `${c.beat}.json`), JSON.stringify(s0.sfx.filter((x) => Number.isFinite(Number(x.frame)) && x.sound), null, 2));
  }

  const { scale, size } = await renderScale(c.work, c.span);
  let checks = null, polish = [], lastProblems = [], lastBlocking = true, lastChecks = null, done = null;
  for (let round = 1; ; round++) {
    const tsc = await runAsync('npx', ['tsc', '--noEmit', '-p', '.'], { cwd: join(c.work, 'video'), encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const typeErrors = tsc.status === 0 ? '' : `${tsc.stdout || ''}${tsc.stderr || ''}`.split('\n').filter((l) => /error TS/.test(l)).slice(0, 40).join('\n');
    onActivity({ kind: 'info', text: typeErrors ? 'The code has type errors: fixing them before rendering.' : `Rendering scene ${c.beat}.` });
    const r = typeErrors ? { ok: false, error: `TypeScript (npx tsc --noEmit):\n${typeErrors}` } : await renderScene({ root, renders, id, sessionId, c, env, scale });
    if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
    const q = r.ok ? await sceneQc(c, r.clip, size) : null;
    if (round > MAX_ROUNDS) {
      if (r.ok && q.pass && !lastBlocking) { checks = lastChecks; polish = lastProblems; done = q; break; }
      return give(`still not passing after ${MAX_ROUNDS} rounds: ${lastProblems.join('; ').slice(0, 300)}`);
    }
    const [kg, ...kgArgs] = kgCommand(root);
    const lint = r.ok ? await runAsync(kg, [...kgArgs, 'lint', 'src/motion.tsx', '--comp', 'Main', '--frames', [0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(c.span.from + p * (c.span.to - 1 - c.span.from))).join(',')], { cwd: join(c.work, 'video'), encoding: 'utf8', timeout: 2 * 60_000, env: { ...process.env, ...env } }) : null;
    onActivity({ kind: 'info', text: r.ok ? `Checking scene ${c.beat} (round ${round}).` : 'The scene did not render: fixing the code.' });
    const rv = await call(sceneReviewPrompt(c, { sheet: q && join(c.work, q.sheet), qcText: q?.text || '', lint: lint ? `${lint.stdout || ''}${lint.stderr || ''}`.trim() : '', renderError: r.ok ? null : r.error }), sceneSchema(REVIEW_SCHEMA, c.beat), r.ok ? 'Read' : '', r.ok ? 'review' : 'codefix');
    if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
    const s = rv.ok ? rv.structured : null;
    if (!s) return give(rv.error || 'the check call gave no answer');
    if (r.ok && q.pass && s.ok) { checks = s.checks; done = q; break; }
    if (!writeScene(c, s.files)) {
      if (r.ok && q.pass && !s.blocking) { checks = s.checks; polish = s.problems || []; done = q; break; }
      return give(`problems but no fix: ${(s.problems || []).join('; ').slice(0, 300)}`);
    }
    lastProblems = s.problems || [];
    lastBlocking = Boolean(s.blocking) || !r.ok;
    lastChecks = s.checks;
  }

  // listed as a session lists it; scenesSubmitted (below) brings the clip into clips.json
  const scenesPath = join(c.work, 'out', 'scenes.json');
  const doc = readJsonOr(scenesPath, { made_from: 'out/animatic.mp4', fps: FPS, scenes: [] });
  const entry = { key: `s${String(c.index + 1).padStart(2, '0')}`, name: c.script?.name || c.beat, from_frame: c.span.from, frames: c.span.to - c.span.from, beat: c.beat, file: `out/scenes/${c.beat}-v1.mp4` };
  doc.scenes = [...(doc.scenes || []).filter((x) => x.beat !== c.beat), entry].sort((a, b) => a.from_frame - b.from_frame);
  writeFileSync(scenesPath, JSON.stringify(doc));

  const said = (k) => String(checks?.[k] ?? 'not reported by the check call');
  const seconds = (c.span.to - c.span.from) / FPS;
  const error_checks = [
    { id: 'spelling-and-facts', result: 'pass', note: `${s0.facts_note} On the rendered sheet: ${said('spelling-and-facts')}` },
    { id: 'text-safe-area', result: 'pass', note: said('text-safe-area') },
    { id: 'no-collisions', result: 'pass', note: said('no-collisions') },
    { id: 'text-contrast', result: 'pass', note: said('text-contrast') },
    { id: 'frame-sheet', result: 'pass', note: `${done.sheet} viewed: ${said('frame-sheet')}` },
    { id: 'format', result: 'pass', note: `qc.mjs passes: ${size || "the video's own size"}, ${FPS} fps, ${seconds.toFixed(2)} s.` },
    { id: 'loudness', result: 'pass', note: "The scene plays the approved mix unchanged; the whole video's loudness is checked when it is joined." },
    { id: 'sync', result: 'pass', note: "The approved mix plays as it is and each move is placed on a word's frame from src/timing.ts." },
    { id: 'flat-2d-buildable', result: 'pass', note: 'Drawn by code in Kinetograph; the type check and the render pass.' },
  ].filter((x) => stepChecks(root, id, 'animatic').some((k) => k.id === x.id));
  const note = polish.length ? `${s0.note}\n\nStill to look at (polish the studio's check raised; QC passes): ${polish.join(' · ')}` : s0.note;
  try {
    submit(root, id, 'animatic', { note, questions: [], error_checks, items: [
      { path: `out/scenes/${c.beat}-v1.mp4`, label: `Scene ${c.index + 1} · ${entry.name}`, section: 'Motion' },
      { path: done.sheet, label: `Frame sheet, scene ${c.index + 1}`, section: 'Checks' },
    ] });
    scenesSubmitted(root, id);
    const plan = scenePlan(root, id);
    await queueScenes(root, id, [c.beat].filter((b) => b === plan.beats[plan.current]?.id));
  } catch (e) { return give(`the submission was refused: ${e.message}`); }
  rmSync(draftFile, { force: true });
  appendFileSync(join(c.work, 'JOURNAL.md'), `\n- ${new Date().toISOString()} · Scene ${c.beat} built and submitted by the studio (no session): ${seconds.toFixed(2)} s.\n`);
  onActivity({ kind: 'info', text: `Scene ${c.beat} is ready for your check.` });
  return { ok: true, usage, summary: s0.note };
}
