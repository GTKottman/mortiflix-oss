// The eight Mortiflix Studio stages over a pipeline's steps (owner, 2026-10-18): 1 Script · 2 Voice · 3 Style frames ·
// 4 Transitions · 5 Animatic · 6 Music · 7 Edit · 8 Render. Nothing of a stage is made before the stage before it
// passed its gate (gates.mjs). Each step belongs to one stage (its `stage`, else its key, else what it
// makes). A stage's status is worked out from its steps and its pieces on the canvas, never stored; only the owner's
// Next click ("stage done") and the last stage looked at are kept, in project.json `mfx`.
import { loadProject, projectPipeline, projectPaths, update, event, now } from '../projects.mjs';
import { stepView, respond, answerQuestion, reopen, GateError } from '../gates.mjs';
import { canvasView, loadOwner, nodeAction } from '../canvas.mjs';
import { firstWaits, sceneAheadStart, sceneApprove, sceneAll, sceneBeats, sceneOks, sceneRemaking, scenesSubmitted } from './lessons.mjs';
import { frameOks } from './framestate.mjs';
import { stillOks } from './stills.mjs';
import { musicCues } from './musicneed.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The owner's OKs on the sound effects (sound/sfx-plan.json, what the Sound screen OKs): cut sounds do not count;
// waiting = made and not decided ('ready'). Read here (not from sfx.mjs) to keep stages.mjs out of an import cycle.
function soundOks(root, id) {
  try {
    const plan = JSON.parse(readFileSync(join(projectPaths(root, id).work, 'sound', 'sfx-plan.json'), 'utf8'));
    const cues = (plan.cues || []).filter((c) => c.status !== 'cut');
    return cues.length ? { ok: cues.filter((c) => c.status === 'ok').length, total: cues.length, waiting: cues.filter((c) => c.status === 'ready').length } : null;
  } catch { return null; }
}

// Voice & music: the voice lines (canvas, OK'd on the Voice screen) and the music cues (music/cues.json, music.cue.ok).
function voiceOks(root, id, live) {
  const lines = live.filter((n) => n.kind === 'line');
  const cues = (() => { try { return musicCues(root, id); } catch { return []; } })();
  if (!lines.length && !cues.length) return null;
  return {
    ok: lines.filter((n) => n.owner === 'ok').length + cues.filter((c) => c.state === 'ok').length,
    total: lines.length + cues.length,
    waiting: lines.filter((n) => !n.owner && !n.planned && n.versions?.length && n.state !== 'generating').length + cues.filter((c) => c.state === 'made').length,
  };
}

// Each v3 stage's own OK store (what its screen OKs). Script (beats) and Artcraft (its delivering step) are counted
// from the canvas and the steps, which are their real stores.
const OWN_OKS = { voiceMusic: (root, id, live) => voiceOks(root, id, live), look: frameOks, stills: stillOks, motion: sceneOks, sound: soundOks };

export const STAGES = ['script', 'voice', 'styleFrames', 'transitions', 'animatic', 'music', 'edit', 'render'];
export const STAGE_NAMES = ['Script', 'Voice', 'Style frames', 'Transitions', 'Animatic', 'Music', 'Edit', 'Render'];
// The six stages before 2026-10-18 (script, look, shots, voiceMusic, edit, render) → the eight: a project saved then
// opens on the same work.
export const OLD_STAGE = [0, 2, 4, 5, 6, 7];
const OLD_DONE = { look: ['styleFrames'], shots: ['transitions', 'animatic'], voiceMusic: ['voice', 'music'] };
export const STAGE_EDIT = 6;
export const STAGE_RENDER = 7;
export const STAGE_MUSIC = 5;
const DONE = ['approved', 'done', 'skipped'];

// The v3 stage set (a pipeline with "stage_set": "v3"): the app's six stages, then the delivering Artcraft step.
// 0 Script · 1 Voice & music · 2 Look · 3 Stills · 4 Motion · 5 Sound · 6 Artcraft. Steps of a v3 pipeline carry their own
// `stage` key (pipeline.json), so stageOf(step) is right without knowing the pipeline.
export const V3_STAGES = ['script', 'voiceMusic', 'look', 'stills', 'motion', 'sound', 'artcraft'];
export const V3_STAGE_NAMES = ['Script', 'Voice & music', 'Look', 'Stills', 'Motion', 'Sound', 'Artcraft'];
const V3_BY_KEY = { brief: 0, script: 0, voice: 1, 'style-frames': 2, look: 2, stills: 3, animatic: 4, sound: 5, artcraft: 6 };
const V3_KINDS = [['beat'], ['line', 'cue'], ['frame'], [], ['shot'], [], []];
const V3_NOUN = ['scenes', 'voice lines', 'style frames', 'stills', 'shots', 'sounds', ''];

const BY_KEY = {
  brief: 0, script: 0, genre: 0, blueprint: 0,
  voice: 1, narration: 1,
  'style-frames': 2, directions: 2, look: 2,
  transitions: 3,
  animatic: 4, shots: 4,
  music: 5, score: 5, instruments: 5, mix: 5,
  build: 6,
  final: 7,
};
// The canvas pieces each stage shows (doc 35): the node kinds counted for its "made / total" (shots only on stage 3:
// the transition board never inflates the shot count, owner's first run "0/8" → "3/11"), and the kinds whose pieces
// can wait for the owner there.
const KINDS = [['beat'], ['line'], ['frame'], ['transition'], ['shot'], ['cue'], [], []];
const REVIEW_KINDS = [['beat'], ['line'], ['frame'], ['transition'], ['shot'], ['cue'], [], []];
const NOUN = ['scenes', 'voice lines', 'style frames', 'transitions', 'shots', 'cues', '', ''];

// The stage set a pipeline uses: the eight (explainer and the rest) or the v3 stages.
export const EXPLAINER_SET = { id: 'explainer', keys: STAGES, names: STAGE_NAMES, byKey: BY_KEY, kinds: KINDS, reviewKinds: REVIEW_KINDS, noun: NOUN, edit: STAGE_EDIT };
export const V3_SET = { id: 'v3', keys: V3_STAGES, names: V3_STAGE_NAMES, byKey: V3_BY_KEY, kinds: V3_KINDS, reviewKinds: V3_KINDS, noun: V3_NOUN, edit: 99 };
export const stageSet = (pipeline) => (pipeline?.stage_set === 'v3' ? V3_SET : EXPLAINER_SET);

export function stageOf(step, set = null) {
  if (step.stage) {
    if (set?.keys.includes(step.stage)) return set.keys.indexOf(step.stage);
    if (!set && STAGES.includes(step.stage)) return STAGES.indexOf(step.stage);
    if (!set && V3_STAGES.includes(step.stage)) return V3_STAGES.indexOf(step.stage);
  }
  if (set?.id === 'v3') return V3_BY_KEY[step.key] ?? (step.delivers ? 6 : 0);
  if (BY_KEY[step.key] !== undefined) return BY_KEY[step.key];
  if (step.delivers) return STAGE_RENDER;
  if (step.canvas === 'line') return 1;
  if (step.canvas === 'frame') return 2;
  if (step.canvas === 'transition') return 3;
  if (step.canvas === 'shot') return 4;
  if (step.canvas === 'beat') return 0;
  if ((step.work || []).some((w) => ['music', 'instruments'].includes(w))) return STAGE_MUSIC;
  if (step.waits_for_approval) return STAGE_EDIT;
  return 0;
}

export const stageIndex = (v, set = EXPLAINER_SET) => (Number.isInteger(v) && v >= 0 && v < set.keys.length ? v : set.keys.indexOf(v));

// A project's `mfx` saved with the six stages, in the eight (stage index and the stages pressed Next on). Idempotent.
export function upgradeMfx(mfx, set = EXPLAINER_SET) {
  if (!mfx || set.id !== 'explainer' || mfx.stages === STAGES.length) return false;
  if (Number.isInteger(mfx.stage)) mfx.stage = OLD_STAGE[mfx.stage] ?? 0;
  const done = {};
  for (const [k, at] of Object.entries(mfx.stages_done || {})) for (const n of OLD_DONE[k] || [k]) done[n] = at;
  mfx.stages_done = done;
  mfx.stages = STAGES.length;
  return true;
}
// A project's `mfx` as the eight stages see it, without saving (reads).
export function mfxView(project, set = EXPLAINER_SET) {
  const m = structuredClone(project?.mfx || {});
  upgradeMfx(m, set);
  return m;
}

// What the stage bar shows, one StageStatus per stage (protocol.md). `running`: a session is working on this project.
export function stageStatuses(root, id, { running = false, graph = null } = {}) {
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const S = stageSet(pipeline);
  const view = stepView(project, pipeline);
  let g = graph;
  if (!g) { try { g = canvasView(root, id); } catch { g = { nodes: {} }; } }
  const nodes = Object.values(g.nodes || {}).filter((n) => !n.missing);
  const done = mfxView(project, S).stages_done || {};
  const stopped = ['paused', 'cancelled'].includes(project.state) && !(project.state === 'paused' && project.needs_you && !project.needs_you.by_you);
  return S.keys.map((key, i) => {
    const steps = view.filter((s) => stageOf(s, S) === i);
    const pieces = nodes.filter((n) => S.kinds[i].includes(n.kind));
    // a project made before its pipeline had this stage's own step (voice lines from the animatic) still has the stage
    const present = steps.length > 0 || i >= S.edit || pieces.length > 0;
    const live = pieces.filter((n) => n.state !== 'cut');
    const reviewable = nodes.filter((n) => S.reviewKinds[i].includes(n.kind) && n.state !== 'cut');
    const made = live.filter((n) => !n.planned && n.versions?.length);
    const questions = project.questions.filter((q) => !q.answered_at && steps.some((s) => s.key === q.step)).length;
    // Pieces waiting for the owner: a failed remake, or a piece of a step in review that has no OK / Cut yet.
    const reviewKinds = steps.filter((s) => s.state === 'in_review' && s.canvas).map((s) => s.canvas);
    // v3 Look / Stills / Motion keep the owner's OKs in their own stores (frames-state, stills.json, motion scenes), not
    // in the canvas decisions (Dir1 bdb9 2026-11-02: 7 frames OK'd, the status said "7 need you", ok 0, Next locked)
    const own = S.id === 'v3' ? OWN_OKS[key]?.(root, id, live) ?? null : null;
    const undecided = own ? (steps.some((s) => s.state === 'in_review') ? own.waiting : 0) : reviewable.filter((n) => reviewKinds.includes(n.kind) && !n.owner && !n.planned && n.state !== 'generating').length;
    const failed = reviewable.filter((n) => n.state === 'needs you').length;
    const docsInReview = own ? 0 : steps.filter((s) => s.state === 'in_review' && !s.canvas).length; // a stage with its own OK store counts its pieces, not the step
    const need = questions + failed + (done[key] ? 0 : undecided + docsInReview);
    const making = steps.some((s) => ['working', 'changes'].includes(s.state) || (s.state === 'ready' && project.state === 'queued'))
      || pieces.some((n) => n.state === 'generating' && !n.planned) || (running && steps.some((s) => s.state === 'ready'));
    const allDone = steps.length > 0 && steps.every((s) => DONE.includes(s.state));
    const reviewedOrDone = steps.length > 0 && steps.every((s) => DONE.includes(s.state) || s.state === 'in_review');
    let kind = 'notStarted';
    if (!present) kind = 'notStarted';
    else if (stopped && (making || steps.some((s) => s.state === 'ready'))) kind = 'stopped';
    else if (project.state === 'paused' && project.needs_you && !project.needs_you.by_you && steps.some((s) => ['working', 'ready', 'changes'].includes(s.state))) kind = 'needsYou';
    else if (making) kind = 'making';
    else if (need > 0) kind = 'needsYou';
    else if (done[key] || allDone) kind = 'done';
    else if (reviewedOrDone) kind = 'ready';
    // its pieces are all made and nothing waits: ready to check, never "not started" (owner's run: "not started 17/17")
    const allMade = live.length > 0 && made.length === live.length;
    if (kind === 'notStarted' && present && allMade) kind = 'ready';
    const total = pieces.length ? live.length : steps.length;
    const doneCount = pieces.length ? made.length : steps.filter((s) => DONE.includes(s.state) || s.state === 'in_review').length;
    // what the owner OK'd (the app's "2 of 3 looks OK"): pieces with the owner's OK, else steps approved/done/skipped. `done`
    // counts what is made, never what is OK'd (Dir2 2026-11-02: "3 of 3 looks OK" with 0 frames OK'd).
    const okCount = own ? own.ok : pieces.length ? live.filter((n) => n.owner === 'ok').length : steps.filter((s) => DONE.includes(s.state)).length;
    const text = !present ? 'not in this preset'
      : need ? `${need} need${need === 1 ? 's' : ''} you`
        : pieces.length ? `${made.length}/${live.length} ${S.noun[i]}${allMade && kind === 'ready' ? ' ready' : ''}` : '';
    return { kind, done: doneCount, ok: okCount, total: own ? own.total : total, need, text, key, index: i, name: S.names[i], set: S.id, present, steps: steps.map((s) => ({ key: s.key, name: s.name, state: s.state, version: s.version })) };
  });
}

// The owner's Next on a stage: everything in it is kept as it is now. Steps in review are approved (pieces without an
// OK are OK'd as they are; questions take their defaults). `then`: the stage the owner goes to.
export function stageDone(root, id, from, { reason = 'Next' } = {}) {
  const pipeline = projectPipeline(root, id);
  const S = stageSet(pipeline);
  const i = stageIndex(from, S);
  if (i < 0) throw new GateError(`stage must be 0-${S.keys.length - 1} or a stage key`);
  const kept = [];
  const left = [];
  let waits = false;
  // Questions of this stage's steps take their defaults.
  for (const q of loadProject(root, id).questions.filter((x) => !x.answered_at)) {
    const step = pipeline.steps.find((s) => s.key === q.step);
    if (!step || stageOf(step, S) !== i) continue;
    if (q.default === null) { left.push({ question: q.id, why: 'has no default: answer it in the chat' }); continue; }
    answerQuestion(root, id, q.id, null);
    kept.push({ question: q.id, answer: q.default });
  }
  for (const s of stepView(loadProject(root, id), pipeline).filter((x) => stageOf(x, S) === i && x.state === 'in_review')) {
    try {
      // scene by scene: the Motion step is not approved by Next while scenes are left to approve one by one
      if (motionFirstWaits(root, id, pipeline, s.key)) { left.push({ step: s.key, why: 'scenes are still being checked one by one: approve each scene (motion.scene.approve)' }); waits = true; continue; }
      if (s.canvas) {
        const g = canvasView(root, id);
        const owner = loadOwner(root, id);
        for (const n of Object.values(g.nodes).filter((x) => x.kind === s.canvas && !x.missing && !x.planned && x.versions?.length && !owner.decisions[x.id])) {
          nodeAction(root, id, n.id, { action: 'ok' });
        }
      }
      const now2 = stepView(loadProject(root, id), pipeline).find((x) => x.key === s.key);
      if (now2.state === 'in_review') respond(root, id, s.key, now2.version, { verdict: 'approve', overall: `${reason}: kept as it is.` });
      kept.push({ step: s.key, version: s.version });
    } catch (e) {
      left.push({ step: s.key, why: e.message });
    }
  }
  // the stage is not finished while the scene-by-scene pass is open
  if (waits) return { stage: i, key: S.keys[i], kept, left };
  update(root, id, (p) => {
    p.mfx ||= {};
    upgradeMfx(p.mfx, S);
    p.mfx.stages_done = { ...(p.mfx.stages_done || {}), [S.keys[i]]: now() };
  });
  event(root, id, { event: 'STAGE_DONE', actor: 'you', details: `${S.names[i]}: ${reason}` });
  return { stage: i, key: S.keys[i], kept, left };
}

// Leaving Music for Edit (Edit the video) or Render (Get the video): the app builds the edit from the
// graph and renders it with Mortiflix Studio's export (docs 38, 39), so the session never builds or renders a final. Those
// steps are skipped, marked as done in the app.
export function handOverToApp(root, id, how) {
  const pipeline = projectPipeline(root, id);
  const S = stageSet(pipeline);
  return update(root, id, (p) => {
    const skipped = [];
    for (const s of pipeline.steps) {
      if (stageOf(s, S) < S.edit || DONE.includes(p.steps[s.key]?.state)) continue;
      p.steps[s.key] = { ...(p.steps[s.key] || {}), state: 'skipped', by: 'app', how };
      skipped.push(s.key);
    }
    p.mfx ||= {};
    p.mfx.handover = { how, at: now() };
    event(root, id, { event: how === 'get' ? 'GET_THE_VIDEO' : 'EDIT_THE_VIDEO', actor: 'you', details: skipped.length ? `done in the app: ${skipped.join(', ')}` : '' });
    return { how, skipped };
  });
}

// Before going back (doc 30 "going back lists exactly what gets remade"): if something in `stage` changes, which later
// steps and pieces are made again.
export function remakesIf(root, id, stage) {
  const pipeline = projectPipeline(root, id);
  const S = stageSet(pipeline);
  const i = stageIndex(stage, S);
  if (i < 0) throw new GateError(`stage must be 0-${S.keys.length - 1} or a stage key`);
  const view = stepView(loadProject(root, id), pipeline);
  const start = new Set(view.filter((s) => stageOf(s, S) === i).map((s) => s.key));
  const after = new Set(start);
  let grew = true;
  while (grew) { grew = false; for (const s of pipeline.steps) if (!after.has(s.key) && s.after.some((a) => after.has(a))) { after.add(s.key); grew = true; } }
  let g = { nodes: {} };
  try { g = canvasView(root, id); } catch { /* no canvas yet */ }
  return view.filter((s) => after.has(s.key) && !start.has(s.key) && s.version > 0).map((s) => ({
    step: s.key, name: s.name, stage: S.keys[stageOf(s, S)],
    pieces: s.canvas ? Object.values(g.nodes).filter((n) => n.kind === s.canvas && !n.missing && n.versions?.length).length : 0,
  }));
}

// Going back to change a stage: its last reviewed step goes back for changes with the owner's words (gates.reopen),
// and the stages from it on are no longer "done".
export function reopenStage(root, id, stage, text) {
  const pipeline = projectPipeline(root, id);
  const S = stageSet(pipeline);
  const i = stageIndex(stage, S);
  if (i < 0) throw new GateError(`stage must be 0-${S.keys.length - 1} or a stage key`);
  const view = stepView(loadProject(root, id), pipeline).filter((s) => stageOf(s, S) === i && s.review !== 'internal' && ['approved', 'done'].includes(s.state));
  const step = view.at(-1);
  if (!step) throw new GateError(`nothing in ${S.names[i]} is approved yet: say what to change in the chat`);
  const r = reopen(root, id, step.key, { overall: String(text || '').slice(0, 4000) });
  update(root, id, (p) => {
    p.mfx ||= {};
    upgradeMfx(p.mfx, S);
    const d = { ...(p.mfx.stages_done || {}) };
    for (const k of S.keys.slice(i)) delete d[k];
    p.mfx.stages_done = d;
  });
  return { ...r, stage: i, key: S.keys[i] };
}

// v3 scene 1 first: the animatic step of a v3 pipeline cannot be approved (by Next, or by anything else the studio
// does for the owner) until motion.first.approve; the owner's own OK on a one-scene animatic is refused in gates.respond.
export function motionFirstWaits(root, id, pipeline, stepKey) {
  if (pipeline.stage_set !== 'v3' || stepKey !== 'animatic') return false;
  return firstWaits(root, id);
}

// The owner's OK on scene 1 (motion.first.approve, after lessons.firstApprove): the Motion step is sent back so the rest
// of the scenes are made with the lessons: in review it goes back as "changes", approved it is reopened. Not built yet: nothing.
export function restartMotion(root, id, text = 'The scene is approved: make the next scene, with the lessons from the owner\'s notes.') {
  const pipeline = projectPipeline(root, id);
  const S = stageSet(pipeline);
  const step = stepView(loadProject(root, id), pipeline).find((s) => s.key === 'animatic');
  if (!step) return null;
  let r = null;
  if (step.state === 'in_review') r = respond(root, id, 'animatic', step.version, { verdict: 'changes', overall: text });
  else if (['approved', 'done'].includes(step.state)) r = reopen(root, id, 'animatic', { overall: text });
  else return null;
  update(root, id, (p) => {
    const d = { ...(p.mfx?.stages_done || {}) };
    for (const k of S.keys.slice(stageOf(step, S))) delete d[k];
    if (p.mfx) p.mfx.stages_done = d;
  });
  return r;
}

// Where a v3 project's work is: the first stage with a step not yet OK'd (one in review counts), else the last stage.
// Home lists projects by it. A v3 project's mfx.stage is only the stage last opened with stage.set, which the v3 app
// never calls, so it stayed 0 and every v3 project read "Script · waiting for you to OK the script" (2026-11-03: Ice
// had every step OK'd up to Sound and Finish in review).
export function workStage(project, pipeline) {
  const S = stageSet(pipeline);
  const view = stepView(project, pipeline);
  for (let i = 0; i < S.keys.length; i++) {
    const steps = view.filter((s) => stageOf(s, S) === i);
    if (steps.length && !steps.every((s) => DONE.includes(s.state))) return i;
  }
  return S.keys.length - 1;
}

export function saveLastStage(root, id, stage) {
  const S = stageSet(projectPipeline(root, id));
  return update(root, id, (p) => { p.mfx ||= {}; upgradeMfx(p.mfx, S); p.mfx.stage = stage; return stage; });
}

// The scene after the one the owner is checking starts now, with the lessons so far, unless something else waits to run.
// Returns its beat, or null. Only a step in review can go back: a running step comes here again when it ends.
export function startAhead(root, id) {
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  if (pipeline.stage_set !== 'v3' || project.mfx?.motion_restart_pending) return null;
  if (stepView(project, pipeline).find((s) => s.key === 'animatic')?.state !== 'in_review') return null;
  scenesSubmitted(root, id);
  const next = sceneAheadStart(root, id);
  if (!next) return null;
  restartMotion(root, id, `The owner is checking the scene before it: make scene ${next.id} (${next.name}) only, ahead of their OK, with the lessons from the owner's notes so far. Its motion is its own.`);
  return next.id;
}

// A scene remade from notes while the step is busy: the step goes back for it when it is next in review.
function afterThisRun(root, id, text, remake = null) {
  update(root, id, (p) => { p.mfx = { ...(p.mfx || {}), motion_restart_pending: text, ...(remake ? { motion_remake_after: remake } : {}) }; });
}

// The tablet's OK with notes: THIS scene is made again, now or as soon as the scene being made ahead is finished.
export function remakeScene(root, id, beat, text) {
  let sent = null;
  try { sent = restartMotion(root, id, text); } catch { /* the step is busy */ }
  if (!sent) afterThisRun(root, id, text);
  sceneRemaking(root, id, beat);
}

// motion.scene.approve {beat, remakeNext}: the scene is the owner's. The next scene is already made or being made ahead, so
// the owner goes straight on, unless they ask for it to be remade with their notes (they wait for that). With no scene
// left the animatic stays as it is and can be approved.
export function approveScene(root, id, beat, { remakeNext = false } = {}) {
  const r = sceneApprove(root, id, beat);
  if (!r.next) return r;
  const name = sceneBeats(root, id).find((b) => b.id === r.next)?.name || r.next;
  const text = `Scene ${beat} is approved: make scene ${r.next} (${name}) only, with the lessons from the owner's notes. Its motion is its own.`;
  if (r.next_making) {
    if (remakeNext) afterThisRun(root, id, text, r.next);
    return { ...r, remaking: remakeNext };
  }
  if (r.next_ready && !remakeNext) {
    startAhead(root, id);
    return r;
  }
  if (r.next_ready) sceneRemaking(root, id, r.next);
  let sent = null;
  try { sent = restartMotion(root, id, text); } catch { /* not built yet: it builds next */ }
  // the step is still being worked on (its submission not in yet): the runner sends it back once it is in review
  if (!sent) afterThisRun(root, id, text);
  return { ...r, remaking: remakeNext };
}

// motion.scene.all {confirm}: only when the owner asks, and only after the warning (needs_confirm) is confirmed.
export function allScenes(root, id, confirm = false) {
  const r = sceneAll(root, id, confirm);
  if (r.started) { try { restartMotion(root, id, 'The owner chose to make all the other scenes together (they were warned): make every remaining scene now, with the lessons so far.'); } catch { /* not built yet */ } }
  return r;
}
