// v3: the style frames wait for a look (mfx.look_brief) and the animatic for a motion pick (mfx.motion_brief), but the
// app's v3 screens never ask for either (2026-11-02, Director 1 and 2: the voice approved, "Voice & music: Next", and no
// Look session ever started: style-frames stayed blocked on a look nobody could pick). When a v3 step is held by that pick
// alone, "the AI decides" is saved for it: the look comes from the brief and the owner reviews every frame on Look (and
// every scene on Motion). A pick the owner made is never replaced.
import { loadProject, projectPipeline } from '../projects.mjs';
import { stepView } from '../gates.mjs';
import { setBrief } from './lookbrief.mjs';
import { setMotionBrief } from './motionbrief.mjs';

export const AI_LOOK = 'No look was picked: the AI picks one from the brief (its topic, tone and audience). The owner reviews every style frame on Look.';
export const AI_MOTION = 'the AI decides';

// What the owner already said in the brief (Dir3, 2026-11-02: "chalk on a blackboard, then icy blue" came out as a navy
// halftone look because "the AI decides" ignored it): the brief's answers about the look (look, visual, style, colour,
// type, tone, mood...) and about the motion (motion, animation, pace, transitions...), as "question: answer" lines.
const LOOK_RX = /\b(look|looks|visual|visuals|style|colou?rs?|palette|fonts?|type|typography|aesthetic|art|world|tone|mood|vibe|feel)\b/i;
const MOTION_RX = /\b(motion|animat\w*|move\w*|pace|pacing|transitions?|cuts?|rhythm|energy)\b/i;
export function briefAnswers(project, rx) {
  const rows = [];
  for (const [key, a] of Object.entries(project.mfx?.answers || {})) {
    const answer = String(a?.answer ?? '').trim();
    if (!answer || !(rx.test(key) || rx.test(String(a?.text || '')))) continue;
    rows.push(`${String(a?.text || key).trim()} ${answer}`);
  }
  return rows;
}

const fromBrief = (rows, rest) => `From the brief, the owner's own answers (follow them exactly):\n${rows.map((r) => `- ${r}`).join('\n')}\n${rest}`;
export function lookWords(project) {
  const rows = briefAnswers(project, LOOK_RX);
  return rows.length ? fromBrief(rows, 'No style pack was picked: the AI decides only what the brief leaves open (exact fonts, exact colours, details). The owner reviews every style frame on Look.') : AI_LOOK;
}
export function motionWords(project) {
  const rows = briefAnswers(project, MOTION_RX);
  return rows.length ? fromBrief(rows, 'No motion pack was picked: the AI decides only what the brief leaves open.') : AI_MOTION;
}

// Only the pick holds the step: it would be ready with one.
function heldByPick(project, pipeline, key, field) {
  if (project.mfx?.[field]) return false;
  const now = stepView(project, pipeline).find((s) => s.key === key);
  if (!now || now.state !== 'blocked') return false;
  const withPick = stepView({ ...project, mfx: { ...(project.mfx || {}), [field]: { at: 'probe' } } }, pipeline).find((s) => s.key === key);
  return withPick?.state === 'ready';
}

// Saves what is missing; returns the picks made (['look'], ['motion'] or []).
export function fillV3Briefs(root, id) {
  const pipeline = projectPipeline(root, id);
  if (pipeline.stage_set !== 'v3') return [];
  const made = [];
  if (heldByPick(loadProject(root, id), pipeline, 'style-frames', 'look_brief')) {
    const p = loadProject(root, id);
    const look = briefAnswers(p, LOOK_RX).find((r) => /look|visual|world|style/i.test(r));
    setBrief(root, id, { words: lookWords(p), ...(look ? { look: look.slice(0, 200) } : {}) }, { actor: 'studio' });
    made.push('look');
  }
  if (heldByPick(loadProject(root, id), pipeline, 'animatic', 'motion_brief')) {
    setMotionBrief(root, id, { words: motionWords(loadProject(root, id)) }, { actor: 'studio' });
    made.push('motion');
  }
  return made;
}
