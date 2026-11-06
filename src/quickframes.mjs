// The style frames driven by the studio, not a session (owner, 2026-10-19: a session took 2.07M tokens in 26 steps). Every AI call
// starts fresh and small. Since v3 (plan 90, owner's answers 2026-11-01) the Look is made in ROUNDS OF 3 FRAMES, like renders:
//   1. the studio plans the frames from the script's parts (svc/frames.mjs planFrames: one per part, short parts share one, a long
//      part holds its frame longer) and builds the asset pool (svc/pool.mjs);
//   2. ONE call writes the round's frames (up to the owner's frames per round, default 3): the static block (role, Kinetograph contract, the owner's principles, byte-identical
//      every call, so cached) goes in with --append-system-prompt-file; the project block (look, pool lines, parts) and the round
//      block (lessons, the owner's notes on the frames before, the target) are the message;
//   3. the studio renders each frame (kinetograph still, through the render queue) and MEASURES it (svc/inspect.mjs: exact, a hard gate);
//      a failed measurement or render goes back to a small fix call, a few times;
//   4. the frames wait for the owner, who checks off EACH one (frames.ok / frames.fix). What they said on a frame goes into the frames
//      written after it. A frame with notes is remade as a new version (old versions kept).
// Anything it can't finish (a render that keeps failing, checks that keep failing) goes to a session: give().
import { ensureVideoScaffold } from './svc/videoscaffold.mjs';
import { briefBlock } from './svc/briefmap.mjs';
import { uploadsBlock, uploadsHavePictures } from './svc/uploads.mjs';
import { lessonsBlock, listNotes } from './svc/lessons.mjs';
import { runAs } from './models.mjs';
import { run as runAsync } from './svc/run.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { paths, REPO } from './studio.mjs';
import { loadProject, projectPaths, projectPipeline } from './projects.mjs';
import { stepView, stepChecks, submit } from './gates.mjs';
import { scriptView } from './svc/script.mjs';
import { kgStill } from './kinetograph.mjs';
import { styleText } from './svc/packs.mjs';
import { inspectFrame, measureFrame } from './svc/inspect.mjs';
import { buildPool, readPool, poolLines } from './svc/pool.mjs';
import { queueFrames } from './svc/videonotes.mjs';
import { readReviewSettings } from './svc/reviewsize.mjs';
import { ensurePlan, loadFrames, saveFrames, nextAction, hasFramesWork } from './svc/frames.mjs';

// (v3's style-frames step also lists flat-2d-buildable, now "buildable in Kinetograph, from the asset pool": measured here too)
const CHECKS = ['spelling-and-facts', 'text-safe-area', 'no-collisions', 'text-contrast', 'flat-2d-buildable'];
const MAX_FIX = 3; // fix calls for a render that fails (no picture to show)
// Fix calls for measured checks that fail on a frame that DID render: after these the frame is shown to the owner with the
// check's result ("2 boxes overlap by 14 px") and they decide (OK anyway / Fix with a note), never a silent give-up (2026-11-02).
export const MAX_MEASURED_FIX = 2;
const MAX_INSPECT = 3; // AI inspection rounds per frame (the board: repeat review until accepted; here at most 3, then the owner decides)

export function quickFramesStep(root, id, config) {
  if (config.quickFrames === false || config.quickScript === false) return null;
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const step = pipeline.steps.find((s) => s.key === 'style-frames');
  if (!step || step.review !== 'frames') return null;
  const runnable = stepView(project, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  if (runnable.length !== 1 || runnable[0].key !== 'style-frames') return null;
  const work = projectPaths(root, id).work;
  // 'changes' is the owner's OK/Fix on a frame (svc/frames.mjs restarts the step): the studio makes the next round or the remake itself
  if (runnable[0].state === 'changes' && !hasFramesWork(work)) return null;
  if (project.mfx && Object.keys(project.mfx).some((k) => k.endsWith('_wanted'))) return null;
  if (!existsSync(join(work, 'design', 'look-brief.json'))) return null;
  if (!existsSync(join(work, '.claude', 'skills', 'remotion-motion', 'setup.mjs'))) return null;
  if (stepChecks(root, id, 'style-frames').some((c) => !CHECKS.includes(c.id))) return null;
  return runnable[0];
}

const read = (f, n = 200_000) => (existsSync(f) ? readFileSync(f, 'utf8').slice(0, n) : '');
const readJsonOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

// WCAG contrast of two #rrggbb colours (1..21).
export function contrast(a, b) {
  const lum = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
    if (!m) return null;
    const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const x = lum(a), y = lum(b);
  if (x === null || y === null) return null;
  return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
}

const FORMAT = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };

const FRAME_PATH = '^src/(video\\.ts|ui\\.tsx|scenes/sf\\d{2,3}\\.tsx)$';
// The files a call may write: the piece files of the step being made or fixed (style frames sf*.tsx, stills st_b*.tsx),
// never the studio scaffold. Each step passes its own pattern to the fixer and the inspection (2026-11-02: the Stills
// measured-check fix was refused because the fixer only took sf*.tsx).
const filesOf = (pattern) => ({ type: 'array', items: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', pattern }, content: { type: 'string' } } } });
const FILE_SCHEMA = filesOf(FRAME_PATH);
export const WRITE_SCHEMA = {
  type: 'object',
  required: ['files', 'frames', 'look_md', 'note', 'facts_note'],
  properties: {
    files: FILE_SCHEMA,
    frames: { type: 'array', items: { type: 'object', required: ['id', 'why', 'note'], properties: { id: { type: 'string', description: 'sf01, sf02, … exactly as given in the targets' }, why: { type: 'string', description: 'one line: which moment of the part you drew and why it carries the look' }, note: { type: 'string', description: 'for the owner: what this frame is and what to look at; name any principle you broke on purpose and why' }, assets: { type: 'array', items: { type: 'string' }, description: 'the pool ids this frame uses' } } } },
    look_md: { type: 'string', description: 'design/LOOK.md: palette jobs, type, shapes, texture and why (the whole file, extended with this round)' },
    note: { type: 'string', description: 'for the owner: the round in two sentences' },
    facts_note: { type: 'string', description: 'every on-screen word, name and number checked against the script' },
  },
};
const SECTION = { type: 'object', required: ['pass', 'note'], properties: { pass: { type: 'boolean' }, note: { type: 'string', description: 'what you looked at, in one line' }, correction: { type: 'string', description: 'when it fails: the specific correction instruction' } } };
export const SECTIONS = ['visual_design', 'typography', 'technical_quality', 'narrative_quality', 'transition_compatibility'];
const SECTION_NAMES = { visual_design: 'Visual design', typography: 'Typography', technical_quality: 'Technical quality', narrative_quality: 'Narrative quality', transition_compatibility: 'Transition compatibility' };
export const inspectSchema = (pattern = FRAME_PATH) => ({
  type: 'object',
  required: ['sections'],
  properties: {
    sections: { type: 'object', required: ['visual_design', 'typography', 'technical_quality', 'narrative_quality'], properties: Object.fromEntries(SECTIONS.map((k) => [k, SECTION])) },
    files: { ...filesOf(pattern), description: 'only when a section fails: the files to replace, whole, with the corrections made' },
  },
});
export const INSPECT_SCHEMA = inspectSchema();
export const fixSchema = (pattern = FRAME_PATH) => ({ type: 'object', required: ['files', 'note'], properties: { files: filesOf(pattern), note: { type: 'string', description: 'what you changed and why' } } });
export const FIX_SCHEMA = fixSchema();

export function context(root, id) {
  const pp = projectPaths(root, id);
  const work = pp.work;
  const project = loadProject(root, id);
  const script = scriptView(root, id);
  const timing = readJsonOr(join(work, 'voice', 'timing.json'), { seconds: null, lines: [] });
  const look = readJsonOr(join(work, 'design', 'look-brief.json'), {});
  const aspect = project.intake?.answers?.aspect || '16:9';
  const [w, h] = FORMAT[aspect] || FORMAT['16:9'];
  const scenes = script.beats.map((b) => {
    const ls = timing.lines.filter((l) => l.id.startsWith(`${b.id}-`));
    return { id: b.id, name: b.name, words: b.lines.map((l) => l.words).join(' '), visual: b.visual || '', from_sec: ls[0]?.start ?? null, to_sec: ls.at(-1)?.end ?? null };
  });
  const row = read(join(work, 'pipeline', 'PIPELINE.md')).split('\n').find((l) => l.startsWith('| `style-frames`')) || '';
  return { pp, work, project, script, timing, look, aspect, w, h, scenes, row };
}

// ---- block A: static. Byte-identical on every call: no dates, no project names. ----
export const STATIC_PRINCIPLES = () => read(join(REPO, 'pipelines', 'v3', 'design', 'PRINCIPLES.md'), 60_000);
// GROUNDS: style frames alternate their full-bleed ground (the owner's standing rule, for PLANNING the frames); a still keeps
// its scene's approved frame's ground exactly and the stills of one scene never change ground (2026-11-02, 61dc b05-1 and
// b08-1: the inspector applied the alternation to stills and rewrote them from the frame's navy to frost white).
export const STILL_GROUNDS = 'GROUNDS ON STILLS: a still keeps the ground (its full-bleed background colour and texture) of its scene\'s approved style frame exactly, and every still of one scene has that same ground. The alternation of grounds is for planning the style frames only, never for stills: never change a still\'s ground to differ from the still before it.';
export function staticBlock({ stills = false } = {}) {
  return [
    `You design the style frames of a video in the Mortiflix studio. A style frame is ONE finished-quality still of one real moment of the script, in the look the owner picked. You write Remotion-API code (React, TSX); the studio renders it with Kinetograph (a GPU engine that runs Remotion's API itself, no browser) and measures it. Answer with the JSON asked for, nothing else.`,
    `## What you write
- Files, whole: src/video.ts (once: the look's palette and fonts in \`look\`, and \`export const video = { width, height, fps, seconds }\` with the size above, 30 fps and the narration's length), src/ui.tsx (the look's shared pieces: backgrounds, shapes, labels; later rounds may EXTEND it but never restyle what an approved frame uses), and one src/scenes/sfNN.tsx per frame of the round: \`export const SFNN: React.FC\` (SF01 in sf01.tsx) drawing frame 0 at full resolution with the real words of that part of the script.
- Imports only from 'react', 'remotion', '@remotion/google-fonts/<Family>', the asset pool ('../pool' from a scene, './pool' from ui.tsx) and your own files. No network, no randomness except random('seed') from remotion.
- THE ASSET POOL (src/pool.ts, written by the studio from the packs the owner picked). Refer to assets by ID only, exactly as listed: asset('img:skyline') is a picture URL for <Img src>; tex('halftone-dots', {color, scale, opacity}) is style props for a background layer; font('font:heading') is a family name to use in fontFamily (every font file in the pool is already loaded); color('color:accent') is a hex; <Icon id="icon:arrow" color={...} size={96} /> draws an icon in any colour. An id that is not listed, or a font, picture or texture from anywhere else, fails the frame. A font with no file in the pool is loaded with @remotion/google-fonts/<Family>.
- Textures, pictures and depth from the pool are welcome, drawn as they are. Do not invent realistic imagery in code.
- Kinetograph draws the CSS a browser would, but leaves these out (warned, and the frame fails): image-rendering, background-attachment: fixed, vertical writing-mode, multi-column, form controls, iframes, evenodd clip paths, shape(), backdrop-filter other than blur(), mask-image, CSS filters on elements inside an <svg>, text inside an SVG picture, remote URLs and fonts that aren't loaded.
- Safe area: all text at least 5% inside every edge. No text overlapping another text, and none sticking out of its panel. Contrast is measured on the rendered pixels (4.5:1, 3:1 for text 36 px and up).
- The frames of one video are ONE visual identity, consistent across frames while colour, background, composition and intensity may change when the part calls for it.
- ${stills ? STILL_GROUNDS : "ALTERNATE GROUNDS (the owner's standing rule): switch the full-bleed background between the palette's colours (ink, accent, paper) from one frame to the next; never one ground for the whole video, and never a frame on the same ground as the frame before it just to match."} Avoid generic presentation graphics, childish visuals, excessive decoration and repetitive layouts.`,
    `## The owner's principles (copied word for word from their board)
Use these as a strong guide. Break one only on purpose, when this moment calls for it, and say which one and why in \`note\`.

${STATIC_PRINCIPLES()}`,
    `## Lessons and notes
The owner's notes on earlier frames are mistakes never to repeat in the frames after them. They are rules about what the owner is picky about, never a style to copy.`,
  ].join('\n\n');
}

// ---- the AI inspection (plan 90 §1.5 layer 2): the owner's Inspection!! list, one frame, one picture, a fresh call each time ----
export const STATIC_INSPECTION = () => read(join(REPO, 'pipelines', 'v3', 'design', 'INSPECTION.md'), 20_000);
export function staticInspector() {
  return [
    `You inspect ONE style frame of a video in the Mortiflix studio, as the owner's inspector. You get the frame's picture at full size (open it with Read), the studio's exact measurements (they already pass: do not re-measure), and the code that changed. Judge the frame only on the owner's list below, section by section: a section passes or fails, and a failure carries a SPECIFIC correction instruction. When any section fails, also return the code files to replace, whole, with every correction made. Keep everything that passed as it is. Answer with the JSON asked for, nothing else.`,
    `## The owner's inspection list (copied word for word from their board)

${STATIC_INSPECTION()}`,
    `Answer one entry per section: visual_design, typography, technical_quality, narrative_quality, and transition_compatibility ONLY when the message names a neighbouring frame to compare with. Be strict about the owner's list and nothing else: no taste notes, no new rules.`,
  ].join('\n\n');
}

// The picture of a frame's current (for an OK'd frame: approved) version, or null.
export const approvedFile = (c, f) => { const v = f.versions?.find((x) => x.v === f.current); return v ? join(c.work, v.file) : null; };

// ---- block B (project) + C (this round) ----
const frameLine = (f) => `- ${f.id} · covers ${f.beats.join(', ')} · holds ${f.hold_s} s of the video`;
function ownerNotes(root, id) {
  try {
    return listNotes(root, id).notes.filter((n) => /^sf\d+$/.test(n.node) && (n.text || n.image)).slice(-30).map((n) => `- On ${n.node}: ${String(n.text || '(marks only)').slice(0, 400)}`);
  } catch { return []; }
}

export function writePrompt(root, id, c, { targets = null, state = null, fix = false } = {}) {
  const st = state || loadFrames(c.work);
  const pool = readPool(root, id);
  const tgt = targets || (st.frames.length ? nextAction(st).frames : []);
  const sceneOf = (f) => f.beats.map((b) => c.scenes.find((s) => s.id === b)).filter(Boolean);
  const done = st.frames.filter((f) => f.state === 'ok');
  const notes = ownerNotes(root, id);
  const checks = stepChecks(root, id, 'style-frames');
  const style = styleText(c.look.pack_files?.style);
  const pack = c.look.pack_files ? JSON.stringify({ ...c.look.pack_files, style: undefined, pictures: undefined }).slice(0, 3000) : '';
  return [
    // B: this project (changes once)
    `## The project\n"${c.project.title}", a ${projectPipeline(root, id).makes} made in the Mortiflix studio. ${c.w}×${c.h} (${c.aspect}), 30 fps, the narration runs ${c.timing.seconds ?? '?'} s.`,
    `## The look the owner picked (use it as given: the palette exactly)\n${JSON.stringify({ ...c.look, pack_files: undefined }, null, 1)}${pack ? `\nStyle pack: ${pack}` : ''}${style ? `\n\n## The style pack's own rules (the job and rule of every colour, the type and shapes: follow them)\n${style}` : ''}`,
    `## The asset pool (ids to use; ${pool.assets.length} in all)\n${poolLines(pool, { sceneWords: tgt.flatMap(sceneOf).map((s) => `${s.name} ${s.words}`).join(' ') }).join('\n') || '(empty: draw everything with code and the shapes you make)'}`,
    `## Every frame planned for this video (${st.frames.length}, in rounds of ${st.frames.filter((f) => f.round === 1).length || 3}; a long part holds its frame longer)\n${st.frames.map(frameLine).join('\n')}`,
    `## Checks every frame must pass\n${checks.map((x) => `- ${x.id}: ${x.how}`).join('\n')}\n- no-missing-assets: every asset id is in the pool\n- no-layout-errors: Kinetograph draws everything (no "not drawn" warning)`,
    // C: this round
    lessonsBlock(root, id, { step: 'frames' }),
    visualBrief(root, id),
    uploadsBlock(c.work),
    notes.length ? `## What the owner said on the frames before (mistakes not to repeat in these frames)\n${notes.join('\n')}` : '',
    // each OK'd frame by its APPROVED picture only: out/frames also holds the versions the owner rejected (2026-11-02, d4fd:
    // the round-2 writer opened sf02-v3.png, the rejected paper version, instead of the OK'd sf02-v4 on ink)
    done.length ? `## Frames the owner already OK'd (their code is in src/ui.tsx and src/scenes; do not restyle them)\n${done.map((f) => `- ${f.id}: ${f.note || f.label}${approvedFile(c, f) ? `\n  Its approved picture: ${approvedFile(c, f)}` : ''}`).join('\n')}\nUse only these approved pictures as references. The other files in out/frames are older versions the owner rejected: never open them.` : '',
    fix
      ? `## Remake these frames (new versions; keep what the owner did not mention)\n${tgt.map((f) => `### ${f.id} (${f.label})\nThe owner's ${f.fix_notes?.length || 0} note${f.fix_notes?.length === 1 ? '' : 's'}, all at once:\n${(f.fix_notes || []).map((n, i) => `${i + 1}. ${n.text || '(marks only)'}${n.image ? `\n   Their pen marks on the frame are in the picture ${n.image}: open it with Read.` : ''}`).join('\n')}\nIts code now:\n${read(join(c.work, 'video', 'src', 'scenes', `${f.id}.tsx`), 40_000)}`).join('\n\n')}\nAnswer with the changed files whole (src/scenes/<id>.tsx, and src/ui.tsx only if a shared piece must change without restyling an OK'd frame) and one frames[] row per remade frame.`
      : `## This round: write ${tgt.length} frame${tgt.length === 1 ? '' : 's'}\n${tgt.map((f) => `### ${f.id} (composition ${f.composition}, file src/scenes/${f.id}.tsx)\nCovers: ${sceneOf(f).map((s) => `${s.id} "${s.name}" (${s.from_sec ?? '?'}–${s.to_sec ?? '?'} s): ${s.words}`).join(' / ')}\nPick the ONE moment of this part that carries the look best, draw it with its real words, and say why in \`why\`.`).join('\n\n')}\n${done.length ? 'Make these a contrasting moment from the OK\'d frames (a different colour ground, composition or intensity), in the same visual identity.' : 'The first frame fixes the look: make it the strongest moment.'}`,
    `## The project's code now\n### src/video.ts\n${read(join(c.work, 'video', 'src', 'video.ts'), 8_000)}\n### src/ui.tsx\n${read(join(c.work, 'video', 'src', 'ui.tsx'), 40_000) || '(not written yet)'}`,
  ].filter(Boolean).join('\n\n');
}

// Render + measure a list of items (frames or stills), with small fix calls until the studio's measured checks pass. A render that
// keeps failing (no picture) answers {give} after MAX_FIX fix calls. A frame that renders but still fails a measured check after
// MAX_MEASURED_FIX fix calls (or whose fix call gives nothing) is NOT given up: run answers {ok: true, failing: Map(name -> problems)}
// and the caller shows that frame to the owner as held, with the check's result. Returns {run(list), measured, fixes}.
export function makeRenderMeasure({ root, id, c, renders, sessionId, env, signal, config, onActivity, call, apply, fixIds, label = 'style frames', noun = 'style frame', filePath = FRAME_PATH }) {
  const FIX = fixSchema(filePath);
  let fixes = 0;
  let measured = [];
  const run = async (list) => {
    let renderFixes = 0, measureFixes = 0;
    for (;;) {
      onActivity({ kind: 'info', text: `Rendering ${list.length} ${noun}${list.length === 1 ? '' : 's'}.` });
      const r = await renderFrames({ root, renders, projectId: id, sessionId, work: c.work, env, items: list, label });
      if (signal?.aborted) return { stopped: true };
      let problems = [], bad = [];
      if (r.ok) {
        const m = await measureFrames({ root, id, work: c.work, frames: list.map((f) => ({ id: f.composition, label: f.label, name: f.name, scene: f.scene, dir: f.dir, entry: f.entry, keys: f.keys })), output: r.output, probe: config._inspectProbe || null });
        for (const x of m) measured = [...measured.filter((y) => y.id !== x.id), x];
        bad = m.filter((x) => !x.ok);
        problems = bad.flatMap((x) => x.problems.map((p) => `${x.frame}: ${p}`));
        if (!problems.length) return { ok: true, failing: new Map() };
        const show = (why) => {
          onActivity({ kind: 'info', text: `${bad.map((x) => x.frame).join(', ')} still ${bad.length === 1 ? 'fails' : 'fail'} the studio's measured checks${why}: shown to you with the check's result, you decide.` });
          return { ok: true, failing: new Map(bad.map((x) => [x.id, x.problems])) };
        };
        if (measureFixes >= MAX_MEASURED_FIX) return show(` after ${MAX_MEASURED_FIX} fixes`);
        measureFixes++;
        fixes++;
        onActivity({ kind: 'info', text: `The studio's measured checks failed: fixing the code (${measureFixes} of ${MAX_MEASURED_FIX}).` });
        const fx = await call(fixPrompt(c, fixIds || list.map((f) => f.id), problems, null, list, bad, noun), FIX, '', 'codefix');
        if (signal?.aborted) return { stopped: true };
        if (!fx.ok || !fx.structured?.files?.length) return show(` (the fix call ${fx.ok ? 'gave no files' : `failed: ${String(fx.error || 'no answer').slice(0, 120)}`})`);
        apply(fx.structured.files.filter((f) => ![...STUDIO_FILES, 'src/video.ts'].includes(String(f.path))));
        continue;
      }
      if (++renderFixes > MAX_FIX) return { give: `the ${noun}s kept failing to render` };
      fixes++;
      onActivity({ kind: 'info', text: `The ${noun}s didn't render: fixing the code.` });
      const fx = await call(fixPrompt(c, fixIds || list.map((f) => f.id), [], r.error, list, [], noun), FIX, '', 'codefix');
      if (signal?.aborted) return { stopped: true };
      if (!fx.ok || !fx.structured?.files?.length) return { give: fx.ok ? 'the fix call gave no files' : fx.error || 'no answer' };
      // the fixer changes frame code only: the studio's scaffold and the approved look (video.ts) are never replaced
      apply(fx.structured.files.filter((f) => ![...STUDIO_FILES, 'src/video.ts'].includes(String(f.path))));
    }
  };
  return { run, get measured() { return measured; }, fixes: () => fixes };
}

// The measured report the fixer reads: per frame, per failed check, every item with its boxes and by how much (svc/inspect.mjs).
export function measuredReport(bad = []) {
  const line = (i) => i.words || [i.why, i.id && `id ${i.id}`, i.a && `${i.a} / ${i.b}`, i.sides && `sides ${i.sides.join('+')}`, i.box && `box ${i.box.w}×${i.box.h} at ${i.box.x},${i.box.y}`, i.ratio && `${i.fg} on ${i.bg} = ${i.ratio}:1 (needs ${i.need})`, i.word && `missing "${i.word}"`].filter(Boolean).join(', ');
  return bad.map((x) => `### ${x.frame}
${Object.entries(x.checks || {}).filter(([, ch]) => !ch.pass).map(([k, ch]) => `- ${k}: ${ch.note}${(ch.items || []).filter((i) => k !== 'text-contrast' || !i.ok).slice(0, 12).map((i) => `\n  - ${line(i)}`).join('')}`).join('\n')}`).join('\n');
}

// What the owner asked for on the frames being remade: a code fix or an inspection round keeps it, whatever it corrects
// (2026-11-02, d4fd: SF02 v2 was drawn on ink as the owner's note asked; the check round then put it back on cream paper,
// the ground of SF01, undoing the note).
export function ownerKeepBlock(list = []) {
  const rows = (list || []).filter((f) => f.fix_notes?.length).map((f) => `### ${f.id}\n${f.fix_notes.map((n, i) => `${i + 1}. ${n.text || '(pen marks only)'}`).join('\n')}`);
  if (!rows.length) return '';
  return `## What the owner asked for on these frames (it stays: the owner's notes win over every check and every other rule)\n${rows.join('\n')}\nChange only what the failing check needs, in the smallest way. Never change the ground (background colour or texture), the palette, the layout or the composition the owner's notes asked for, and never bring back what they asked to change. If a check cannot pass without undoing a note, keep the note and say so in your note.`;
}

function fixPrompt(c, ids, problems, renderError, list = null, bad = [], noun = 'style frame') {
  const still = noun === 'still';
  const files = list ? [...new Set(list.map((f) => f.scene))] : ids.map((i) => `src/scenes/${i}.tsx`);
  const code = ['src/ui.tsx', ...files].map((f) => `### ${f}\n${read(join(c.work, 'video', f), 60_000)}`).join('\n');
  const studio = ['src/index.ts', 'src/Root.tsx', 'src/format.ts', 'src/scenes/frames.tsx', 'src/video.ts'].map((f) => `### ${f}\n${read(join(c.work, 'video', f), 20_000) || '(missing)'}`).join('\n');
  return [
    renderError ? `The frames ${ids.join(', ')} didn't render. Fix the code so they do.\n\n## The render's error\n${renderError.slice(-4000)}`
      : `The studio MEASURED the frames ${ids.join(', ')} and they fail. These checks are exact and cannot be passed any other way: fix every one.\n\n## What failed\n${problems.map((p) => `- ${p}`).join('\n')}${bad.length ? `\n\n## The measured report (Kinetograph's real boxes, in px of the ${c.w}×${c.h} frame: x,y is the top-left corner)\n${measuredReport(bad)}` : ''}`,
    ownerKeepBlock(list),
    `## The code you may change\n${code}`,
    `## The studio's files (read only: index.ts, Root.tsx, format.ts and scenes/frames.tsx are written by the studio and any change to them is thrown away; video.ts holds the approved look, leave it)\n${studio}`,
    (still ? 'Fix only what failed, in the smallest way: never change a still\'s ground (its full-bleed background: it is its scene\'s approved style frame\'s ground), palette or layout.' : 'Fix only what failed, in the smallest way: never change a frame\'s ground (its full-bleed background), palette or layout to match another frame (the owner alternates grounds on purpose).') + ' Fix only the frame code (src/scenes/<id>.tsx) and, if a shared piece is at fault, src/ui.tsx. Answer with the files to replace, whole, and a one-line note.',
  ].join('\n\n');
}

// The AI inspection of a list of rendered, measured items (style frames or stills): per item a fresh call, up to MAX_INSPECT rounds.
// items: [{id, name, label, beats, scene, dir?, composition, ...}]. prevOf(item) -> {id, label, file} | null (the OK'd neighbour to compare
// with, for transition compatibility). renderMeasure(list) draws and measures again after the inspector's corrections.
// Returns {map: Map(id -> {rounds, sections, unresolved, held?})} | {stopped} | {give: why}.
export async function runInspection({ items, getMeasured, call, inspectorFile, c, onActivity, signal, renderMeasure, writeFiles: apply, prevOf, noun = 'frame', failing = new Map(), filePath = FRAME_PATH }) {
  const INSPECT = inspectSchema(filePath);
  const map = new Map();
  for (const it of items) {
    // a frame that still fails the studio's measured checks is held for the owner as it is: no inspection round on top
    if (failing.has(it.name)) { map.set(it.id, measuredHold(failing.get(it.name))); continue; }
    const prev = prevOf(it);
    let n = 0, last = null;
    for (;;) {
      n++;
      onActivity({ kind: 'info', text: `Checking ${it.id} against your inspection list (round ${n}).` });
      const mm = getMeasured().find((x) => x.id === it.name);
      const res = await call(inspectPrompt(c, it, mm, prev, noun), INSPECT, 'Read', 'review', inspectorFile);
      if (signal?.aborted) return { stopped: true };
      if (!res.ok || !res.structured?.sections) return { give: res.ok ? 'the inspection call gave no answer' : res.error || 'no answer' };
      const secs = res.structured.sections;
      const failed = SECTIONS.filter((k) => secs[k] && secs[k].pass === false);
      last = { rounds: n, sections: Object.fromEntries(SECTIONS.filter((k) => secs[k]).map((k) => [k, { pass: secs[k].pass !== false, note: String(secs[k].note || '').slice(0, 300), ...(secs[k].pass === false ? { correction: String(secs[k].correction || '').slice(0, 500) } : {}) }])), unresolved: [] };
      if (!failed.length) break;
      last.unresolved = failed.map((k) => `${SECTION_NAMES[k]}: ${secs[k].correction || secs[k].note}`.slice(0, 500));
      if (n >= MAX_INSPECT || !res.structured.files?.length) { last.held = true; break; }
      apply(res.structured.files);
      const rm = await renderMeasure([it]);
      if (rm.stopped) return { stopped: true };
      if (rm.give) return { give: rm.give };
      if (rm.failing?.has(it.name)) { failing.set(it.name, rm.failing.get(it.name)); last = { ...measuredHold(rm.failing.get(it.name)), rounds: n }; break; }
    }
    map.set(it.id, last);
  }
  return { map };
}

// The hold for a frame that renders but fails a measured check: its check results, in the studio's words, for the owner.
export const measuredHold = (problems) => ({ rounds: 0, sections: {}, held: true, measured: true, unresolved: (problems || []).map((p) => `Studio check · ${p}`.slice(0, 500)) });

function inspectPrompt(c, it, m, prev, noun = 'frame') {
  const scenes = it.beats.map((b) => c.scenes.find((s) => s.id === b)).filter(Boolean);
  const code = ['src/ui.tsx', it.scene].map((f) => `### ${f}\n${read(join(c.work, 'video', f), 60_000)}`).join('\n');
  return [
    `Inspect the ${noun === 'still' ? 'still' : 'style frame'} ${it.id} (${it.label}). Open ${join(c.work, it.dir || 'out/frames', `${it.name}.png`)} with Read: it is ${c.w}×${c.h}, shown at full size.`,
    `## The part of the script it shows\n${scenes.map((s) => `${s.id} "${s.name}": ${s.words}${s.visual ? ` (planned visual: ${s.visual})` : ''}`).join('\n')}`,
    `## Measured by the studio (exact, already passing: do not re-measure)\n${m ? Object.entries(m.checks).map(([k, x]) => `- ${k}: ${x.note}`).join('\n') : '(none)'}`,
    prev ? `## Transition compatibility: compare with the ${noun} before it\nThe owner's OK'd ${noun} ${prev.id} (${prev.label}) is ${prev.file}: open it with Read. Judge whether the two share geometry, visual continuity and camera behaviour, and whether any typography change between them is explained. ${noun === 'still' ? `${STILL_GROUNDS} So the same ground as the still before is right within a scene, never a fault, and the fault to name is a still on another ground than its scene's approved frame: ask only to put it back on that frame's ground, never onto another.` : `GROUNDS: the owner's standing rule is to ALTERNATE the full-bleed background between the palette's colours (ink, accent, paper) from frame to frame, so a change of ground between the two is wanted and always counts as explained: never ask to put this ${noun} on the ground of the one before. The same ground as the ${noun} before is the fault to name, unless the owner's notes asked for it.`}${it.fix_notes?.length ? ' A change the owner\'s notes below asked for (a new ground, a new colour) IS explained: never ask to undo it.' : ''}` : `There is no OK'd ${noun} before this one: leave out transition_compatibility.`,
    ownerKeepBlock([it]),
    `## The code that drew it\n${code}`,
    'Answer per section. If any section fails, return the files to replace, whole.',
  ].join('\n\n');
}

function writeFiles(work, files, allowed) {
  for (const f of files || []) {
    const p = String(f.path);
    if (STUDIO_FILES.includes(p)) continue; // the studio's own scaffold: never from the AI
    if (!(p === 'src/video.ts' || p === 'src/ui.tsx' || allowed.includes(p))) continue;
    const dest = normalize(join(work, 'video', p));
    if (!dest.startsWith(normalize(join(work, 'video', 'src')))) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, String(f.content));
  }
}

// The studio's own scaffold (2026-11-02, Directors 1 and 2: every style frame failed to render, first for a missing
// src/index.ts, then for Main's NaN length from an AI-written video.ts). src/format.ts (size, rate, length from the
// project and the voice), src/Root.tsx and src/scenes/frames.tsx are written here, never by the AI; src/preflight.tsx is
// the one-still check rendered before any Claude call. Main is registered only once the animatic has written a real one.
export const STUDIO_FILES = ['src/index.ts', 'src/Root.tsx', 'src/format.ts', 'src/preflight.tsx', 'src/scenes/frames.tsx'];

export function writeFormat(work, { w, h, seconds }) {
  const fps = 30;
  const sec = Number(seconds) > 0 ? Math.round(Number(seconds) * 1000) / 1000 : 1;
  writeFileSync(join(work, 'video', 'src', 'format.ts'), `// Written by the studio (quickframes.mjs) from the project's aspect and the voice's length. Do not edit.\nexport const format = { width: ${w}, height: ${h}, fps: ${fps}, seconds: ${sec}, durationInFrames: ${Math.max(1, Math.round(sec * fps))} };\n`);
  writeFileSync(join(work, 'video', 'src', 'preflight.tsx'), `// Written by the studio: the one-still check before the style frames (format + Kinetograph). Do not edit.\nimport React from 'react';\nimport { Composition, AbsoluteFill, registerRoot } from 'remotion';\nimport { format } from './format';\n\nconst Check = () => <AbsoluteFill style={{ backgroundColor: '#101114' }} />;\nregisterRoot(() => <Composition id="Preflight" component={Check} width={format.width} height={format.height} fps={format.fps} durationInFrames={format.durationInFrames} />);\n`);
}

// src/scenes/frames.tsx is the index the transitions and the animatic read: `frames` = every frame's component. The studio writes it
// (and the Root that registers each frame as its own composition) from the frames that exist.
export function writeIndex(work, st) {
  const have = st.frames.filter((f) => existsSync(join(work, 'video', 'src', 'scenes', `${f.id}.tsx`)));
  mkdirSync(join(work, 'video', 'src', 'scenes'), { recursive: true });
  writeFileSync(join(work, 'video', 'src', 'scenes', 'frames.tsx'), `// Written by the studio (quickframes.mjs): one scene file per frame.\nimport React from 'react';\n${have.map((f) => `import { ${f.composition} } from './${f.id}';`).join('\n')}\n\nexport const frames: Record<string, React.FC> = { ${have.map((f) => f.composition).join(', ')} };\n`);
  writeRoot(work);
}

// The studio's Root: Main (once a real one exists: the animatic's, not the template's) and one composition per frame.
export function writeRoot(work) {
  const mainFile = join(work, 'video', 'src', 'Main.tsx');
  const main = existsSync(mainFile) && !readFileSync(mainFile, 'utf8').includes('Replace me with beat one');
  writeFileSync(join(work, 'video', 'src', 'Root.tsx'), `// Written by the studio (quickframes.mjs). Do not edit: size, rate and length come from format.ts.
import { Composition } from 'remotion';
${main ? "import { Main } from './Main';\n" : ''}import { format } from './format';
import { frames } from './scenes/frames';

export const Root = () => (
  <>
${main ? '    <Composition id="Main" component={Main} width={format.width} height={format.height} fps={format.fps} durationInFrames={format.durationInFrames} />\n' : ''}    {Object.entries(frames).map(([id, F]) => (
      <Composition key={id} id={id} component={F} width={format.width} height={format.height} fps={format.fps} durationInFrames={30} />
    ))}
  </>
);
`);
}

// A picture the writer is shown: the last frame the owner OK'd (so the next ones belong with it), else the pack's poster.
function lastPicture(st, c) {
  const ok = st.frames.filter((f) => f.state === 'ok').at(-1);
  const file = ok?.versions.find((v) => v.v === ok.current)?.file;
  return file ? join(c.work, file) : (c.look.pack_files?.pictures || [])[0] || null;
}

export async function renderFrames({ root, renders, projectId, sessionId, work, env, items, label = 'style frames' }) {
  for (const d of new Set(items.map((f) => f.dir || 'out/frames'))) mkdirSync(join(work, d), { recursive: true });
  // One kinetograph still per frame: its CLI draws one composition's one frame a call, each a short process with no browser to start.
  const loop = items.map((f) => `{ ${kgStill({ root, entry: f.entry || 'src/index.ts', composition: f.composition, output: `../${f.dir || 'out/frames'}/${f.name}.png`, frame: 0 })}; } || exit 1`).join(' && ');
  const job = renders.add({ projectId, sessionId, label: `${label} (${items.length})`, argv: ['bash', '-c', loop], cwd: join(work, 'video'), env: { ...process.env, ...env } });
  let v = job;
  while (!['done', 'failed'].includes(v.state)) v = await renders.wait(job.id, projectId, 120);
  return v.state === 'done' && v.exit_code === 0 ? { ok: true, output: String(v.output_tail || '') } : { ok: false, error: v.output_tail || v.error || 'the render failed', output: String(v.output_tail || '') };
}

// The studio's own measured checks on every rendered frame (svc/inspect.mjs): real text boxes from `kinetograph inspect`, contrast
// from the rendered pixels, asset ids against the pool, Kinetograph's "not drawn" warnings. `probe` (tests) replaces the real inspect.
export async function measureFrames({ root, id, work, frames, output = '', probe = null, pool = null }) {
  const sceneCode = (f) => ['src/ui.tsx', f.scene || 'src/scenes/frames.tsx'].map((x) => read(join(work, 'video', x), 100_000)).join('\n');
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const name = f.name || `sf${String(i + 1).padStart(2, '0')}`;
    const dirOf = f.dir || 'out/frames';
    let m;
    try {
      const inspect = await inspectFrame({ root, work, comp: f.id, entry: f.entry || 'src/index.ts', frame: 0, probe: probe ? (fr) => probe(f.id, fr) : null, save: join(work, dirOf, `${name}.inspect.json`) });
      const png = existsSync(join(work, dirOf, `${name}.png`)) ? readFileSync(join(work, dirOf, `${name}.png`)) : null;
      m = measureFrame({ inspect, png, pool: pool || readPool(root, id), code: sceneCode(f), work, warnings: output, keys: f.keys || null });
    } catch (e) { m = { ok: false, checks: {}, problems: [`not measured: ${String(e.message).slice(0, 160)}`], texts: { basis: 'none', list: [] } }; }
    out.push({ frame: f.label || name, id: name, ...m });
  }
  return out;
}

const sum = (a, b = {}) => ({ input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0), output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0), cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0), cache_creation_input_tokens: (a.cache_creation_input_tokens || 0) + (b.cache_creation_input_tokens || 0) });

export async function quickFrames({ root, id, view, run, runArgs, config, onActivity, fallback, renders, sessionId }) {
  const c = context(root, id);
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let calls = 0;
  const dir = join(paths(root).run, 'quick', id);
  mkdirSync(dir, { recursive: true });
  // the static block (A) as a file: the same bytes every call, passed with --append-system-prompt-file so the cache holds it
  const staticFile = join(paths(root).run, 'quick', '_static', 'style-frame-writer.md');
  mkdirSync(dirname(staticFile), { recursive: true });
  const A = staticBlock();
  if (read(staticFile) !== A) writeFileSync(staticFile, A);
  const inspectorFile = join(paths(root).run, 'quick', '_static', 'style-frame-inspector.md');
  const I = staticInspector();
  if (read(inspectorFile) !== I) writeFileSync(inspectorFile, I);
  const call = async (prompt, schema, tools = '', role = 'write', sys = staticFile) => {
    const r = await runAs(run, role, { ...runArgs, workdir: dir, prompt, config: { ...config, claudeArgs: ['--tools', tools, ...(tools ? ['--allowedTools', tools] : []), '--json-schema', JSON.stringify(schema), '--append-system-prompt-file', sys] } });
    usage = sum(usage, r.usage || {}); calls++;
    return r;
  };
  const give = async (why) => {
    onActivity({ kind: 'info', text: `The studio couldn't finish the style frames by itself (${why}): pausing for you.` });
    const f = await fallback(why);
    return { ...f, usage: sum(usage, f.usage || {}) };
  };
  if (!renders) return give('no render queue');

  if (!existsSync(join(c.work, 'video', 'node_modules'))) {
    onActivity({ kind: 'info', text: 'Setting up the video project.' });
    const s = await runAsync(process.execPath, [join(c.work, '.claude', 'skills', 'remotion-motion', 'setup.mjs')], { cwd: c.work, env: { ...process.env, ...(runArgs.env || {}) }, encoding: 'utf8', timeout: 15 * 60_000 });
    if (s.status !== 0) return give(`video setup: ${(s.stderr || s.stdout || '').slice(-300)}`);
  }
  try { buildPool(root, id); } catch (e) { return give(`the asset pool: ${e.message}`); }
  // the template's files the setup skipped (video/src already existed: the pool's pool.ts) — index.ts above all
  try { const added = ensureVideoScaffold(c.work); if (added.length) onActivity({ kind: 'info', text: `Video project: added ${added.join(', ')} from the template.` }); } catch (e) { return give(`the video template: ${e.message}`); }
  const st = ensurePlan(c.work, c.scenes, { perRound: readReviewSettings(root).review.framesPerRound });
  // preflight: the studio's scaffold (format.ts, Root.tsx, frames.tsx) written and ONE local still rendered before any
  // Claude call; a scaffold that cannot draw stops here with the render's own error
  try { writeFormat(c.work, { w: c.w, h: c.h, seconds: c.timing.seconds }); writeIndex(c.work, st); } catch (e) { return give(`the video scaffold: ${e.message}`); }
  if (!config._skipPreflight) {
    const pf = await renderFrames({ root, renders, projectId: id, sessionId, work: c.work, env: runArgs.env || {}, items: [{ entry: 'src/preflight.tsx', composition: 'Preflight', name: 'preflight', dir: 'out/preflight' }], label: 'preflight' });
    if (!pf.ok) return give(`the video scaffold does not render (preflight still): ${String(pf.error || '').slice(-600)}`);
    onActivity({ kind: 'info', text: 'Preflight: the video scaffold renders (one local still).' });
  }
  const act = nextAction(st);
  if (act.kind === 'wait' || act.kind === 'done') return submitFrames({ root, id, c, st, view, onActivity, note: act.kind === 'done' ? 'Every frame is OK.' : 'The frames are waiting for your check.', measured: [], usage, give });

  const fixing = act.kind === 'fix';
  const targets = act.frames;
  for (const f of targets) { if (!fixing) f.state = 'writing'; }
  const ids = targets.map((f) => f.id);
  // The owner keeps deciding while the run works (OK on another frame, Fix with notes): every save of this run reads the frame
  // state again and writes back only the frames it makes, so their decisions are never overwritten (2026-11-02, 61dc: an OK on
  // SF02 and a Fix on SF03 made during SF01's remake were lost when the run saved the state it had read at its start).
  const saveOwn = () => {
    const now = loadFrames(c.work);
    const mine = new Map(st.frames.filter((f) => ids.includes(f.id)).map((f) => [f.id, f]));
    now.frames = now.frames.map((f) => mine.get(f.id) || f);
    now.rounds = st.rounds;
    saveFrames(c.work, now);
    st.frames = now.frames; st.enough = now.enough;
  };
  saveOwn();
  const allowed = ids.map((i) => `src/scenes/${i}.tsx`);
  const pic = fixing ? null : lastPicture(st, c);
  onActivity({ kind: 'info', text: fixing ? `Remaking ${ids.join(', ')} from your notes.` : `Designing round ${act.round}: ${ids.length} frame${ids.length === 1 ? '' : 's'} (${ids.join(', ')}).` });
  let prompt = writePrompt(root, id, c, { targets, state: st, fix: fixing });
  if (pic && existsSync(pic)) prompt += `\n\n## A picture to look at\nOpen ${pic} with Read: ${fixing ? '' : 'it is the pack\'s poster or the last frame the owner OK\'d, so the new frames belong with it.'}`;
  const w = await call(prompt, WRITE_SCHEMA, (pic && existsSync(pic)) || uploadsHavePictures(c.work) ? 'Read' : '');
  if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
  const s0 = w.ok ? w.structured : null;
  if (!s0?.files?.length) { for (const f of targets) if (f.state === 'writing') f.state = 'todo'; saveOwn(); return give(w.ok ? 'the design call gave no files' : w.error || 'no answer'); }
  writeFiles(c.work, s0.files, allowed);
  mkdirSync(join(c.work, 'video', 'src', 'scenes'), { recursive: true });
  const missing = ids.filter((i) => !existsSync(join(c.work, 'video', 'src', 'scenes', `${i}.tsx`)));
  if (missing.length) { for (const f of targets) if (f.state === 'writing') f.state = 'todo'; saveOwn(); return give(`the design call did not write ${missing.join(', ')}`); }
  writeIndex(c.work, st);
  if (s0.look_md) { mkdirSync(join(c.work, 'design'), { recursive: true }); writeFileSync(join(c.work, 'design', 'LOOK.md'), String(s0.look_md)); }

  // render + measure, with small fix calls
  const nextV = (f) => (f.versions.at(-1)?.v || 0) + 1;
  const items = targets.map((f) => ({ ...f, name: `${f.id}-v${nextV(f)}`, scene: `src/scenes/${f.id}.tsx`, v: nextV(f) }));
  const rmk = makeRenderMeasure({ root, id, c, renders, sessionId, env: runArgs.env || {}, signal: runArgs.signal, config, onActivity, call, apply: (files) => writeFiles(c.work, files, allowed), fixIds: ids });
  const renderMeasure = rmk.run;
  const measuredNow = () => rmk.measured;
  const reset = () => { for (const f of targets) if (f.state === 'writing') f.state = 'todo'; saveOwn(); };
  let rm = await renderMeasure(items);
  if (rm.stopped) return { ok: false, error: 'stopped', usage };
  if (rm.give) { reset(); return give(rm.give); }
  const failing = rm.failing || new Map();

  // the AI inspection, frame by frame (the owner's Inspection!! list): a fresh call each, at most MAX_INSPECT rounds, then the frame
  // pauses with the unresolved items in plain words and the owner decides (frames.send_anyway / frames.retry)
  const ins = await runInspection({ items, getMeasured: measuredNow, call, inspectorFile, c, onActivity, signal: runArgs.signal, renderMeasure, writeFiles: (files) => writeFiles(c.work, files, allowed), failing,
    prevOf: (it) => { const p = st.frames.filter((f) => f.state === 'ok' && f.id < it.id).at(-1); return p ? { id: p.id, label: p.label, file: join(c.work, p.versions.find((v) => v.v === p.current).file) } : null; } });
  if (ins.stopped) return { ok: false, error: 'stopped', usage };
  // the inspection could not run (a call failed): the frames are drawn and measured, so they are shown held with the reason
  const inspections = ins.give ? new Map(items.map((it) => [it.id, failing.has(it.name) ? measuredHold(failing.get(it.name)) : { rounds: 0, sections: {}, held: true, unresolved: [`The AI inspection could not run: ${String(ins.give).slice(0, 200)}`] }])) : ins.map;

  // record the versions and put the frames in review
  const metaOf = new Map((s0.frames || []).map((f) => [String(f.id), f]));
  items.forEach((it) => {
    const f = st.frames.find((x) => x.id === it.id);
    const m = measuredNow().find((x) => x.id === it.name);
    f.versions.push({ v: it.v, file: `out/frames/${it.name}.png`, at: new Date().toISOString(), notes: 0, measured: { ok: m?.ok ?? false, problems: m?.problems || [], checks: Object.fromEntries(Object.entries(m?.checks || {}).map(([k, x]) => [k, { pass: x.pass, note: x.note }])) } });
    const insp = inspections.get(it.id);
    f.versions.at(-1).inspection = insp || null;
    f.current = it.v; f.state = insp?.held ? 'held' : 'review'; f.fix_notes = []; f.held = insp?.held ? insp.unresolved : null;
    const mf = metaOf.get(f.id);
    if (mf) Object.assign(f, { why: String(mf.why || '').slice(0, 400), note: String(mf.note || '').slice(0, 800), pool_assets: (mf.assets || []).map(String).slice(0, 30) });
  });
  const measured = measuredNow(); const fixes = rmk.fixes();
  st.rounds.push({ round: act.round, kind: act.kind, frames: ids, at: new Date().toISOString(), calls, fixes, ...usage });
  saveOwn();
  const r = submitFrames({ root, id, c, st, view, onActivity, note: s0.note, facts: s0.facts_note, measured, usage, give, round: act.round, fixes, fixing, ids });
  // the tablet (Video Notes, when the owner turned it on): each made frame as an image item, OK and notes come back through pollTablet
  if (r.ok) { try { await queueFrames(root, id, ids.filter((i) => st.frames.find((f) => f.id === i)?.state === 'review'), { media: config._vnMedia || null }); } catch (e) { console.error(`video notes: ${e.message}`); } }
  return r;
}

// The step goes to the owner with every frame that has a picture; they check each one off (frames.ok / frames.fix).
function submitFrames({ root, id, c, st, view, onActivity, note, facts = '', measured, usage, give, round = null, fixes = 0, fixing = false, ids = [] }) {
  const made = st.frames.filter((f) => f.current);
  if (!made.length) return give('no frame was made');
  const first = (k) => measured.map((m) => m.checks[k]?.note).filter(Boolean)[0];
  const error_checks = [
    { id: 'spelling-and-facts', result: 'pass', note: facts || 'Checked when each frame was written; the studio re-checks the words on the rendered frames.' },
    { id: 'text-safe-area', result: 'pass', note: first('text-safe-area') ? `Measured by the studio from the renderer's text boxes: ${first('text-safe-area')}.` : 'Measured when each frame was made.' },
    { id: 'no-collisions', result: 'pass', note: first('no-collisions') ? `Measured by the studio: ${first('no-collisions')}.` : 'Measured when each frame was made.' },
    { id: 'flat-2d-buildable', result: 'pass', note: `Measured by the studio: ${first('no-missing-assets') || 'asset ids checked against the pool when each frame was made'}; ${first('no-layout-errors') || 'the renderer drew everything'}.` },
    { id: 'text-contrast', result: 'pass', note: first('text-contrast') ? `Measured by the studio on the rendered pixels (WCAG): ${first('text-contrast')}.` : 'Measured on the rendered pixels when each frame was made.' },
  ].filter((x) => stepChecks(root, id, 'style-frames').some((n) => n.id === x.id));
  try {
    submit(root, id, 'style-frames', {
      note: `${note || 'Style frames.'}\n\n${made.filter((f) => f.state === 'ok').length} of ${st.frames.length} frames are OK so far. Check each frame: OK, or Fix with your notes.${st.frames.some((f) => f.state === 'held') ? `\n\nHeld: a check is not satisfied (OK anyway, or Fix with a note):\n${st.frames.filter((f) => f.state === 'held').map((f) => `${f.id}: ${(f.held || []).join(' | ')}`).join('\n')}` : ''}`,
      questions: [],
      items: [...made.map((f) => ({ path: f.versions.find((v) => v.v === f.current).file, label: `${f.label} · v${f.current} · ${f.state === 'ok' ? 'OK' : f.state === 'held' ? 'HELD: a check is not satisfied' : 'to check'}` })), ...(existsSync(join(c.work, 'design', 'LOOK.md')) ? [{ path: 'design/LOOK.md', label: 'Look system' }] : [])],
      error_checks,
    });
  } catch (e) { return give(`the submission was refused: ${e.message}`); }
  const ck = join(c.work, 'checklist.md');
  if (existsSync(ck)) {
    const t = readFileSync(ck, 'utf8').split('\n');
    const at = t.findIndex((l) => /^##\s+Style frames\b/i.test(l));
    if (at >= 0 && !st.frames.some((f) => !['ok', 'skipped'].includes(f.state))) { for (let i = at + 1; i < t.length && !/^##\s/.test(t[i]); i++) t[i] = t[i].replace(/^- \[ \]/, '- [x]'); writeFileSync(ck, t.join('\n')); }
  }
  if (round) {
    const cr = usage.cache_read_input_tokens || 0;
    appendFileSync(join(c.work, 'JOURNAL.md'), `\n- ${new Date().toISOString()} · Style frames round ${round} (${fixing ? 'remake' : 'new'}: ${ids.join(', ')}) made and submitted by the studio: ${fixes} fix${fixes === 1 ? '' : 'es'}; tokens in ${usage.input_tokens}, out ${usage.output_tokens}, cache read ${cr}.\n`);
    onActivity({ kind: 'info', text: `${ids.length} style frame${ids.length === 1 ? '' : 's'} ready for your check (${usage.input_tokens} in / ${usage.output_tokens} out, ${cr} read from the cache).` });
  }
  return { ok: true, usage, summary: note };
}

// What the owner chose under Visual direction in the New project brief (only what they specified).
function visualBrief(root, id) {
  const t = briefBlock(root, id, { only: ['visual'] });
  return t ? `## The owner's visual direction (New project brief; the approved look still wins)\n${t}` : '';
}
