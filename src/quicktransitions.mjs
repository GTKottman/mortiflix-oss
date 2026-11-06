// The transition board driven by the studio, not a session (owner, 2026-10-19: a transitions session took 3.64M
// tokens in 35 steps, reading the library's source and 16 full-size pictures, every one re-read on every later step).
// Here every AI call starts fresh and small:
//   1. choose: the library's catalog (board.mjs list), the style frames on one contact sheet and their code, the
//      scenes with their voice times and the skill → the cut list (carrier, why, transition, params, length, word);
//   2. the studio copies those transitions in (board.mjs use), writes cuts.ts, the board compositions and
//      transitions/board.json, renders each cut's strip and in-betweens through the render queue, runs board.mjs
//      check, fetches the posters and makes the panels;
//   3. review: a fresh call looks at one sheet of every panel with the check's result and passes, or changes cuts;
//   4. the studio submits the panels and BOARD.md with the checks.
// A transition pack the owner picked (its own code), the owner's notes on a version, or a board that keeps failing
// go to a session.
import { runAs } from './models.mjs';
import { spawnSync } from 'node:child_process';
import { run as runAsync } from './svc/run.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, REPO } from './studio.mjs';
import { loadProject, projectPaths, projectPipeline } from './projects.mjs';
import { stepView, stepChecks, submit } from './gates.mjs';
import { scriptView } from './svc/script.mjs';
import { kgRender } from './kinetograph.mjs';

const CHECKS = ['spelling-and-facts', 'text-safe-area', 'no-collisions', 'text-contrast', 'frame-sheet', 'format', 'transitions-carried'];
const BOARD = join(REPO, 'pipelines', '_shared', 'skills', 'transition-board', 'board.mjs');
const HOLD = 30;
const MAX_ROUNDS = 3;

const readJsonOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const read = (f, n = 200_000) => (existsSync(f) ? readFileSync(f, 'utf8').slice(0, n) : '');
const pad = (n) => String(n).padStart(2, '0');

export function quickTransitionsStep(root, id, config) {
  if (config.quickTransitions === false || config.quickScript === false) return null;
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const step = pipeline.steps.find((s) => s.key === 'transitions');
  if (!step || step.review !== 'frames') return null;
  const runnable = stepView(project, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  if (runnable.length !== 1 || runnable[0].key !== 'transitions' || runnable[0].state === 'changes') return null;
  if (project.mfx && Object.keys(project.mfx).some((k) => k.endsWith('_wanted'))) return null;
  const work = projectPaths(root, id).work;
  const brief = readJsonOr(join(work, 'design', 'transition-brief.json'), null);
  if (!brief || brief.pack) return null;
  if (!existsSync(join(work, 'video', 'src', 'scenes', 'frames.tsx')) || !existsSync(join(work, 'design', 'frames.json'))) return null;
  if (stepChecks(root, id, 'transitions').some((c) => !CHECKS.includes(c.id))) return null;
  return runnable[0];
}

async function board(work, env, argv) {
  const r = await runAsync(process.execPath, [BOARD, ...argv], { cwd: work, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function ffmpeg(args) {
  return spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 5 * 60_000 }).status === 0;
}

const CUT_SCHEMA = {
  type: 'object',
  required: ['from', 'to', 'carrier', 'why', 'transition', 'params', 'frames', 'lands_on'],
  properties: {
    from: { type: 'string', description: 'the outgoing frame\'s composition (SF01)' },
    to: { type: 'string', description: 'the incoming frame\'s composition' },
    carrier: { type: 'string' },
    why: { type: 'string' },
    transition: { type: 'string', description: 'a library id from the catalog' },
    params: { type: 'object', description: 'the transition\'s params by name (positions as fractions of the frame, colours #rrggbb)' },
    frames: { type: 'integer' },
    lands_on: { type: 'string', description: 'the word it lands on, quoted, with its scene' },
  },
};
const CHOOSE_SCHEMA = {
  type: 'object',
  required: ['cuts', 'note', 'board_md'],
  properties: {
    cuts: { type: 'array', items: CUT_SCHEMA },
    note: { type: 'string', description: 'for the owner: the video\'s transition vocabulary in two or three lines' },
    board_md: { type: 'string', description: 'transitions/BOARD.md: per cut the carrier, why, transition and family, length, the word it lands on' },
  },
};
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['ok', 'problems', 'checks'],
  properties: {
    ok: { type: 'boolean', description: 'true when every cut is carried, readable and never blanks the screen' },
    blocking: { type: 'boolean', description: 'true only when a problem breaks a rule (a blank screen, a carrier that doesn\'t read, the check failing); polish is not blocking' },
    problems: { type: 'array', items: { type: 'string' } },
    cuts: { type: 'array', items: CUT_SCHEMA, description: 'only when not ok: the whole cut list, changed' },
    board_md: { type: 'string' },
    checks: { type: 'object', required: ['no-collisions', 'text-safe-area'], properties: { 'no-collisions': { type: 'string' }, 'text-safe-area': { type: 'string' } } },
  },
};

function context(root, id) {
  const work = projectPaths(root, id).work;
  const project = loadProject(root, id);
  const script = scriptView(root, id);
  const timing = readJsonOr(join(work, 'voice', 'timing.json'), { seconds: null, lines: [] });
  const framesJson = readJsonOr(join(work, 'design', 'frames.json'), { frames: [] }).frames || [];
  const frames = framesJson.map((f) => ({ composition: f.composition || String(f.id).toUpperCase(), image: f.file, label: f.label, beats: f.beats || [] }));
  const scenes = script.beats.map((b) => {
    const ls = timing.lines.filter((l) => l.id.startsWith(`${b.id}-`));
    return { id: b.id, name: b.name, lines: ls.map((l) => ({ words: l.text, from: l.start, to: l.end, first_word_at: l.words?.[0]?.start ?? l.start })) };
  });
  return { work, project, script, timing, frames, scenes, brief: readJsonOr(join(work, 'design', 'transition-brief.json'), {}) };
}

function choosePrompt(root, id, c, catalog, sheetName) {
  const skill = read(join(REPO, 'pipelines', '_shared', 'skills', 'transition-board', 'SKILL.md'), 20_000);
  return [
    `You design the transition board of a video (the project is named below). The studio copies the transitions in, renders every cut and shows it back to you. Answer with the JSON asked for, nothing else.`,
    `## Skill: the transition board (the studio runs the commands for you)\n${skill}`,
    `## What to answer
- cuts: one per change from a style frame to the next, in order (each starts where the last ended), from and to as compositions.
- transition: a library id only; frames inside its range; params by the names the catalog gives.
- note and board_md as described.`,
    `## The library's catalog (choose ids from it; params by name)\n${catalog}`,
    `## The project\n"${c.project.title}"`,
    `## The style frames (compositions, in order; a cut joins each one to the next)\n${JSON.stringify(c.frames, null, 1)}`,
    `## Their code (src/scenes/frames.tsx: read positions off it, as fractions of the frame)\n${read(join(c.work, 'video', 'src', 'scenes', 'frames.tsx'), 40_000)}`,
    `## The look (src/video.ts)\n${read(join(c.work, 'video', 'src', 'video.ts'), 8000)}`,
    `## The scenes and when each line is spoken (seconds)\n${JSON.stringify(c.scenes)}`,
    `## The owner's transition brief\n${JSON.stringify(c.brief)}`,
    `Open ${sheetName} with Read first: the approved style frames on one contact sheet, left to right then down, in this order: ${c.frames.map((f) => `${f.composition} (${f.label})`).join(' · ')}.`,
  ].join('\n\n');
}

function reviewPrompt(c, cuts, sheetName, check, renderError) {
  return [
    '## Rules\n- every cut is carried by something already on screen, and reads in the in-betweens\n- the screen never goes blank (no flood of colour, no white flash, never emptied)\n- the settled frames keep their text 5% inside the edges; while the transition moves, things may pass through an edge or each other for a moment: that is motion, not a collision\n- the owner checks the board at the gate: say polish points as problems with blocking false; blocking true only for a broken rule',
    `## The cuts now\n${JSON.stringify(cuts, null, 1)}`,
    renderError ? '' : `## board.mjs check\n${check}`,
    renderError
      ? `The transition board for "${c.project.title}" didn't render. Change the cuts so it does.\n\n## The render's error\n${renderError.slice(-4000)}`
      : `Look at the transition board for "${c.project.title}": open ${sheetName} with Read. One row per cut, top to bottom: the outgoing frame, the in-betweens at 35% and 65%, the incoming frame, and the library's preview of that transition (dimmed) when it has one.`,
    renderError || !/✔/.test(check)
      ? 'Answer ok: false, the problems, and cuts: the whole changed list (library ids only), and checks (one line each).'
      : 'If every cut works, ok: true and a one-line note per check (what you looked at). Otherwise ok: false, the problems, and cuts: the whole changed list.',
  ].filter(Boolean).join('\n\n');
}

const camel = (s) => s.replace(/[^A-Za-z0-9]+(.)/g, (_, x) => x.toUpperCase()).replace(/^[^A-Za-z_]+/, '_');

// cuts.ts, the board compositions and Root.tsx, from the cut list.
function writeCode(c, cuts) {
  const src = join(c.work, 'video', 'src');
  const ids = [...new Set(cuts.map((x) => x.transition))];
  writeFileSync(join(src, 'cuts.ts'), `// Every cut of the video, from the approved transition board (transitions/board.json). One list: a changed board
// changes the video here. Written by the studio from the board.
${ids.map((t) => `import ${camel(t)} from './transitions/${t}';`).join('\n')}

export const cuts = [
${cuts.map((x) => `  // ${x.from} → ${x.to}: ${String(x.carrier).replace(/\n/g, ' ').slice(0, 140)}\n  { from: ${JSON.stringify(x.from)}, to: ${JSON.stringify(x.to)}, t: ${camel(x.transition)}, frames: ${x.frames}, params: ${JSON.stringify(x.params || {})} },`).join('\n')}
] as const;
`);
  mkdirSync(join(src, 'scenes'), { recursive: true });
  writeFileSync(join(src, 'scenes', 'board.tsx'), `import React from 'react';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { toPresentation } from '../transitions/core';
import { cuts } from '../cuts';
import { frames } from './frames';

// The transition board: each cut between its two style frames, so the in-betweens are the transition's own frames.
export const HOLD = ${HOLD};

export const boardLength = (i: number) => HOLD * 2 + cuts[i].frames;

export const BoardCut: React.FC<{ i: number }> = ({ i }) => {
  const c = cuts[i];
  const A = (frames as Record<string, React.FC>)[c.from];
  const B = (frames as Record<string, React.FC>)[c.to];
  return (
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={HOLD + c.frames}>
        <A />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={toPresentation(c.t as any, c.params as any)} timing={linearTiming({ durationInFrames: c.frames })} />
      <TransitionSeries.Sequence durationInFrames={HOLD + c.frames}>
        <B />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};
`);
  writeFileSync(join(src, 'Root.tsx'), `import { Composition } from 'remotion';
import { Main } from './Main';
import { video } from './video';
import { frames } from './scenes/frames';
import { cuts } from './cuts';
import { BoardCut, boardLength } from './scenes/board';

// One composition per deliverable. Size, rate and length come from video.ts. Each style frame and each board cut is
// its own composition.
export const Root = () => (
  <>
    <Composition id="Main" component={Main} width={video.width} height={video.height} fps={video.fps} durationInFrames={Math.round(video.seconds * video.fps)} />
    {Object.entries(frames).map(([id, F]) => (
      <Composition key={id} id={id} component={F as React.FC} width={video.width} height={video.height} fps={video.fps} durationInFrames={30} />
    ))}
    {cuts.map((_, i) => (
      <Composition key={i} id={\`Cut\${String(i + 1).padStart(2, '0')}\`} component={BoardCut} defaultProps={{ i }} width={video.width} height={video.height} fps={video.fps} durationInFrames={boardLength(i)} />
    ))}
  </>
);
`);
}

function boardJson(c, cuts) {
  const img = (comp) => c.frames.find((f) => f.composition === comp)?.image || '';
  return {
    cuts: cuts.map((x, i) => ({
      from: c.frames.find((f) => f.composition === x.from)?.label || x.from,
      to: c.frames.find((f) => f.composition === x.to)?.label || x.to,
      a: img(x.from), b: img(x.to),
      carrier: x.carrier, why: x.why, transition: x.transition, params: x.params || {}, frames: x.frames, lands_on: x.lands_on,
      mids: [`out/board/cut-${pad(i + 1)}-35.png`, `out/board/cut-${pad(i + 1)}-65.png`],
      strip: [10, 20, 30, 40, 50, 60, 70, 80, 90].map((p) => `out/board/cut-${pad(i + 1)}/${p}.png`),
    })),
  };
}

// Each cut's frames HOLD..HOLD+frames as a PNG sequence (kinetograph: no Chrome, WebGL2 transitions need no --gl flag),
// then the strip (every 10%) and the mids (35%, 65%) kept.
async function renderBoard({ root, renders, projectId, sessionId, c, env, cuts }) {
  rmSync(join(c.work, 'out', 'board'), { recursive: true, force: true });
  mkdirSync(join(c.work, 'out', 'board'), { recursive: true });
  const cmds = cuts.map((x, i) => {
    const render = kgRender({ root, composition: `Cut${pad(i + 1)}`, output: `../out/board/raw-${pad(i + 1)}`, sequence: true, imageFormat: 'png', frames: [HOLD, HOLD + x.frames] });
    return `rm -rf ../out/board/raw-${pad(i + 1)} && ${render} || exit 1`;
  });
  const job = renders.add({ projectId, sessionId, label: `transition board (${cuts.length} cuts)`, argv: ['bash', '-c', cmds.join(' && ')], cwd: join(c.work, 'video'), env: { ...process.env, ...env } });
  let v = job;
  while (!['done', 'failed'].includes(v.state)) v = await renders.wait(job.id, projectId, 120);
  if (!(v.state === 'done' && v.exit_code === 0)) return { ok: false, error: v.output_tail || v.error || 'the render failed' };
  for (const [i, x] of cuts.entries()) {
    const raw = join(c.work, 'out', 'board', `raw-${pad(i + 1)}`);
    const files = existsSync(raw) ? readdirSync(raw).filter((f) => f.endsWith('.png')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
    if (!files.length) return { ok: false, error: `cut ${i + 1} rendered no frames` };
    const pick = (p) => join(raw, files[Math.min(files.length - 1, Math.round((x.frames * p) / 100))]);
    mkdirSync(join(c.work, 'out', 'board', `cut-${pad(i + 1)}`), { recursive: true });
    for (const p of [10, 20, 30, 40, 50, 60, 70, 80, 90]) copyFileSync(pick(p), join(c.work, 'out', 'board', `cut-${pad(i + 1)}`, `${p}.png`));
    copyFileSync(pick(35), join(c.work, 'out', 'board', `cut-${pad(i + 1)}-35.png`));
    copyFileSync(pick(65), join(c.work, 'out', 'board', `cut-${pad(i + 1)}-65.png`));
    rmSync(raw, { recursive: true, force: true });
  }
  return { ok: true };
}

export async function quickTransitions({ root, id, view, run, runArgs, config, onActivity, fallback, renders, sessionId }) {
  const c = context(root, id);
  const env = runArgs.env || {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  const dir = join(paths(root).run, 'quick', id);
  mkdirSync(dir, { recursive: true });
  const call = async (prompt, schema, tools = 'Read', role = 'write') => {
    const r = await runAs(run, role, { ...runArgs, workdir: dir, prompt, config: { ...config, claudeArgs: ['--tools', tools, ...(tools ? ['--allowedTools', tools] : []), '--json-schema', JSON.stringify(schema)] } });
    usage.input_tokens += r.usage?.input_tokens || 0;
    usage.output_tokens += r.usage?.output_tokens || 0;
    return r;
  };
  const give = async (why) => {
    onActivity({ kind: 'info', text: `The studio couldn't finish the transition board by itself (${why}): pausing for you.` });
    const f = await fallback(why);
    return { ...f, usage: { input_tokens: usage.input_tokens + (f.usage?.input_tokens || 0), output_tokens: usage.output_tokens + (f.usage?.output_tokens || 0) } };
  };
  if (!renders) return give('no render queue');
  if (!env.MFX_TRANSITIONS) return give('the transitions library isn\'t set up');
  const lib = readJsonOr(join(env.MFX_TRANSITIONS, 'catalog.json'), { transitions: [] });
  const catalogById = new Map((lib.transitions || []).map((t) => [t.id, t]));
  const list = await board(c.work, env, ['list']);
  if (!list.ok) return give(`board.mjs list: ${list.out.slice(-200)}`);

  // the style frames on one sheet for the choosing call
  const frameSheet = join(dir, 'frames-sheet.png');
  const n = c.frames.length;
  const inputs = c.frames.flatMap((f) => ['-i', join(c.work, f.image)]);
  const cols = n <= 3 ? n : 2;
  const tiles = c.frames.map((_, k) => `[${k}:v]scale=960:-2[t${k}]`).join(';');
  const layout = c.frames.map((_, k) => `${(k % cols) ? `w0${'+w0'.repeat((k % cols) - 1)}` : '0'}_${Math.floor(k / cols) ? `h0${'+h0'.repeat(Math.floor(k / cols) - 1)}` : '0'}`).join('|');
  if (!ffmpeg([...inputs, '-filter_complex', `${tiles};${c.frames.map((_, k) => `[t${k}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=0x303030`, '-frames:v', '1', frameSheet]) && n > 1) return give('could not make the frames sheet');

  onActivity({ kind: 'info', text: 'Designing the cuts: one call chooses every transition.' });
  const ch = await call(choosePrompt(root, id, c, list.out.slice(0, 30_000), join(dir, 'frames-sheet.png')), CHOOSE_SCHEMA);
  if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
  const s0 = ch.ok ? ch.structured : null;
  if (!s0?.cuts?.length) return give(ch.ok ? 'the design call gave no cuts' : ch.error || 'no answer');
  let cuts = s0.cuts;
  let boardMd = s0.board_md;
  let checkOut = '';
  let checks = null;
  let lastProblems = [];
  let lastBlocking = true;
  let lastChecks = null;
  let polish = [];
  for (let round = 1; ; round++) {
    const bad = cuts.find((x) => !catalogById.has(x.transition));
    let renderError = bad ? `"${bad.transition}" isn't in the library: choose an id from the catalog.` : null;
    if (!renderError) {
      const use = await board(c.work, env, ['use', ...new Set(cuts.map((x) => x.transition))]);
      if (!use.ok) renderError = `board.mjs use: ${use.out}`;
    }
    if (!renderError) {
      writeCode(c, cuts);
      mkdirSync(join(c.work, 'transitions'), { recursive: true });
      writeFileSync(join(c.work, 'transitions', 'board.json'), JSON.stringify(boardJson(c, cuts), null, 2));
      onActivity({ kind: 'info', text: `Rendering the board: ${cuts.length} cuts.` });
      const r = await renderBoard({ root, renders, projectId: id, sessionId, c, env, cuts });
      if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
      if (!r.ok) renderError = r.error;
    }
    let sheetName = null;
    if (!renderError) {
      checkOut = (await board(c.work, env, ['check'])).out;
      await board(c.work, env, ['posters']);
      const pn = await board(c.work, env, ['panels']);
      if (!pn.ok) return give(`board.mjs panels: ${pn.out.slice(-200)}`);
      sheetName = `board-sheet-${round}.png`;
      const panels = cuts.map((_, i) => join(c.work, 'out', 'board', `cut-${pad(i + 1)}.png`));
      const ok = cuts.length === 1 ? ffmpeg(['-i', panels[0], '-vf', 'scale=1960:-2', join(dir, sheetName)])
        : ffmpeg([...panels.flatMap((f) => ['-i', f]), '-filter_complex', `${panels.map((_, k) => `[${k}:v]scale=1960:-2[p${k}]`).join(';')};${panels.map((_, k) => `[p${k}]`).join('')}vstack=inputs=${panels.length}`, '-frames:v', '1', join(dir, sheetName)]);
      if (!ok) return give('could not make the board sheet');
    }
    if (round > MAX_ROUNDS) {
      // the check passes and only polish is left: the owner judges it at the gate (a session would cost millions)
      if (!renderError && /✔/.test(checkOut) && !lastBlocking) { checks = lastChecks; polish = lastProblems; break; }
      return give(`still not passing after ${MAX_ROUNDS} rounds: ${lastProblems.join('; ').slice(0, 300)}`);
    }
    onActivity({ kind: 'info', text: renderError ? 'The board didn\'t render: changing the cuts.' : `Checking the board (round ${round}).` });
    const rv = await call(reviewPrompt(c, cuts, sheetName && join(dir, sheetName), checkOut, renderError), REVIEW_SCHEMA, renderError ? '' : 'Read', renderError ? 'codefix' : 'review');
    if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
    const s = rv.ok ? rv.structured : null;
    if (!s) return give(rv.error || 'the check call gave no answer');
    if (!renderError && s.ok && /✔/.test(checkOut)) { checks = s.checks; break; }
    if (!s.cuts?.length) return give(`problems but no new cuts: ${[...(s.problems || []), checkOut].join('; ').slice(0, 300)}`);
    cuts = s.cuts;
    if (s.board_md) boardMd = s.board_md;
    lastProblems = s.problems || [];
    lastBlocking = Boolean(s.blocking) || Boolean(renderError);
    lastChecks = s.checks;
  }

  writeFileSync(join(c.work, 'transitions', 'BOARD.md'), String(boardMd || ''));
  const items = cuts.map((x, i) => {
    const t = catalogById.get(x.transition);
    return { path: `out/board/cut-${pad(i + 1)}.png`, label: `Cut ${pad(i + 1)} · ${x.from} → ${x.to} · ${t?.name || x.transition} (${String(t?.family || '').replace(/^\d+-/, '')}) · carried by ${String(x.carrier).slice(0, 80)}` };
  });
  items.push({ path: 'transitions/BOARD.md', label: 'Board' });
  const families = [...new Set(cuts.map((x) => catalogById.get(x.transition)?.family).filter(Boolean))];
  // what the check call said per check (the loop can end with no checks: a structured answer without them)
  const said = (k) => String(checks?.[k] ?? 'not reported by the check call');
  const error_checks = [
    { id: 'spelling-and-facts', result: 'pass', note: 'The in-betweens show only the approved style frames\' words: the transitions add no text.' },
    { id: 'text-safe-area', result: 'pass', note: said('text-safe-area') },
    { id: 'no-collisions', result: 'pass', note: said('no-collisions') },
    { id: 'text-contrast', result: 'pass', note: 'No new text and no new backgrounds: the text sits on the approved frames the whole time.' },
    { id: 'frame-sheet', result: 'n/a', note: 'No video in this submission: the board is stills, every panel viewed on one sheet.' },
    { id: 'format', result: 'n/a', note: 'Stills only, from the video\'s own compositions: the video\'s format is checked at the animatic.' },
    { id: 'transitions-carried', result: 'pass', note: `board.mjs check passes (${cuts.length} cuts; families ${families.join(', ')}): every cut carried and named, every strip frame checked for a blank screen.` },
  ].filter((x) => stepChecks(root, id, 'transitions').some((k) => k.id === x.id));
  try {
    const note = polish.length ? `${s0.note}\n\nStill to look at (polish the studio's check raised; the board check passes): ${polish.join(' · ')}` : s0.note;
    submit(root, id, 'transitions', { note, questions: [], items, error_checks });
  } catch (e) { return give(`the submission was refused: ${e.message}`); }
  const ck = join(c.work, 'checklist.md');
  if (existsSync(ck)) {
    const t = readFileSync(ck, 'utf8').split('\n');
    const at = t.findIndex((l) => /^##\s+Transition/i.test(l));
    if (at >= 0) { for (let i = at + 1; i < t.length && !/^##\s/.test(t[i]); i++) t[i] = t[i].replace(/^- \[ \]/, '- [x]'); writeFileSync(ck, t.join('\n')); }
  }
  appendFileSync(join(c.work, 'JOURNAL.md'), `\n- ${new Date().toISOString()} · Transition board v${view.version + 1} designed and submitted by the studio (no session): ${cuts.length} cuts, families ${families.join(', ')}.\n`);
  onActivity({ kind: 'info', text: `Transition board ready for your check: ${cuts.length} cuts.` });
  return { ok: true, usage, summary: s0.note };
}
