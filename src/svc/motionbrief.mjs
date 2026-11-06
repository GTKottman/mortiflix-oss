// How the video moves, picked before anything is animated (owner, 2026-10-18: "before animating, we should be able to
// pick a motion pack that tells the AI to use certain kinds of motions. and rule packs so the AI follows specific
// rules"). Kept in project.json `mfx.motion_brief` and written to design/motion-brief.json (the packs' own words, moves
// and rules copied in, so the session has them even if a pack changes later); the animatic stays blocked until it
// exists (gates.mjs). The rule packs are in every session's brief from then on (brief.mjs).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject, projectPaths, projectPipeline, update, event, now } from '../projects.mjs';
import { settle } from '../gates.mjs';
import { listAllPacks } from './packs.mjs';
import { UserError, writeJson } from '../studio.mjs';

const str = (v, n) => String(v ?? '').trim().slice(0, n);

export function getMotionBrief(root, id) {
  return loadProject(root, id).mfx?.motion_brief || null;
}

// motion.brief.set {motion_pack?, rule_packs?, words?}: nothing picked is fine ("the AI decides"), as long as it's said.
export function setMotionBrief(root, id, params = {}, { actor = 'you' } = {}) {
  if (!params || typeof params !== 'object') throw new UserError('motion.brief.set takes an object');
  const all = listAllPacks(root);
  const motionId = params.motion_pack ? str(params.motion_pack, 120) : null;
  const motion = motionId ? all.find((p) => p.kind === 'motion' && p.id === motionId) : null;
  if (motionId && !motion) throw new UserError(`no motion pack "${motionId}"`);
  const ruleIds = Array.isArray(params.rule_packs) ? [...new Set(params.rule_packs.map((r) => str(r, 120)).filter(Boolean))].slice(0, 20) : [];
  const rules = ruleIds.map((r) => all.find((p) => p.kind === 'rule' && p.id === r) || r);
  const missing = rules.filter((r) => typeof r === 'string');
  if (missing.length) throw new UserError(`no rule pack "${missing[0]}"`);
  const saved = {
    motion_pack: motion ? { id: motion.id, name: motion.name, moves: motion.moves, easing: motion.easing, pace: motion.pace, words: motion.words, dir: motion.dir } : null,
    rule_packs: rules.map((r) => ({ id: r.id, name: r.name, rules: r.rules, words: r.words, dir: r.dir })),
    words: str(params.words, 2000),
    at: now(),
  };
  // the step waiting for this pick can start now: the project goes back in the queue
  update(root, id, (p) => { p.mfx ||= {}; p.mfx.motion_brief = saved; settle(p, projectPipeline(root, id)); });
  const design = join(projectPaths(root, id).work, 'design');
  mkdirSync(design, { recursive: true });
  writeJson(join(design, 'motion-brief.json'), saved);
  event(root, id, { event: 'MOTION_BRIEF', actor, details: [motion?.name || 'the AI decides the motion', ...saved.rule_packs.map((r) => r.name)].join(' · ') });
  return saved;
}

// The session brief's part: the motion pack and the rule packs, in the owner's words (fenced by the caller).
export function motionBriefText(root, id) {
  const b = getMotionBrief(root, id);
  if (!b) return '';
  const lines = [];
  if (b.motion_pack) lines.push(`Motion pack "${b.motion_pack.name}": ${[b.motion_pack.pace && `pace ${b.motion_pack.pace}`, b.motion_pack.easing && `easing ${b.motion_pack.easing}`].filter(Boolean).join(', ')}`, ...b.motion_pack.moves.map((m) => `- move: ${m}`), b.motion_pack.words);
  else lines.push('Motion: the owner left it to you.');
  for (const r of b.rule_packs) lines.push(`Rule pack "${r.name}":`, ...r.rules.map((x) => `- ${x}`), r.words);
  if (b.words) lines.push(`The owner's words: ${b.words}`);
  return lines.filter(Boolean).join('\n').slice(0, 20_000);
}

// The transitions, picked before any is made (owner, 2026-10-18: the Transitions stage asks first, like the look and the
// motion): a transition pack (its transitions are the ones the board picks from) or the remotion-transitions library,
// plus the owner's words. mfx.transition_brief and design/transition-brief.json; the transitions step waits for it.
export function getTransitionBrief(root, id) {
  return loadProject(root, id).mfx?.transition_brief || null;
}

export function setTransitionBrief(root, id, params = {}) {
  if (!params || typeof params !== 'object') throw new UserError('transition.brief.set takes an object');
  const packId = params.transition_pack ? str(params.transition_pack, 120) : null;
  const pack = packId ? listAllPacks(root, 'transition').find((p) => p.id === packId) : null;
  if (packId && !pack) throw new UserError(`no transition pack "${packId}"`);
  const saved = { transition_pack: pack ? { id: pack.id, name: pack.name, transitions: pack.transitions, words: pack.words, dir: pack.dir } : null, words: str(params.words, 2000), at: now() };
  // the step waiting for this pick can start now: the project goes back in the queue
  update(root, id, (p) => { p.mfx ||= {}; p.mfx.transition_brief = saved; settle(p, projectPipeline(root, id)); });
  const design = join(projectPaths(root, id).work, 'design');
  mkdirSync(design, { recursive: true });
  writeJson(join(design, 'transition-brief.json'), saved);
  event(root, id, { event: 'TRANSITION_BRIEF', actor: 'you', details: pack ? `transition pack ${pack.name}` : 'the transitions library' });
  return saved;
}

export function transitionBriefText(root, id) {
  const b = getTransitionBrief(root, id);
  if (!b) return '';
  const lines = b.transition_pack
    ? [`Transition pack "${b.transition_pack.name}": pick every cut's transition from these (or one inspired by them):`, ...b.transition_pack.transitions.map((t) => `- ${t.name}${t.sec ? ` (${t.sec} s)` : ''}${t.words ? `: ${t.words}` : ''}`), b.transition_pack.words]
    : ['Transitions: from the remotion-transitions library, as the transition-board skill says.'];
  if (b.words) lines.push(`The owner's words: ${b.words}`);
  return lines.filter(Boolean).join('\n').slice(0, 20_000);
}
