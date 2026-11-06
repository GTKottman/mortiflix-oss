// The packs picked in the New project window (owner, 2026-10-21: "the user can select the pack at the start and have
// the entire rest of the project use it when needed"). One pack per kind (rule packs: several), kept in project.json
// `mfx.packs`. Each one fills the pick its step would otherwise stop and ask for:
//   style → the look (look-brief.json: the style frames), motion + rule → the motion brief
//   (the animatic, and the rules in every session from then on), transition → the transition brief (the board),
//   sfx → the sound effects in the soundtrack, scoring → the music step's scoring pack (music/theme.json),
//   voice → its words in every session's brief.
import { listAllPacks } from './packs.mjs';
import { setBrief } from './lookbrief.mjs';
import { setMotionBrief, setTransitionBrief } from './motionbrief.mjs';
import { loadTheme, saveTheme } from './theme.mjs';
import { loadProject, update, event } from '../projects.mjs';
import { UserError } from '../studio.mjs';

const str = (v, n) => String(v ?? '').trim().slice(0, n);
// Kinds a project may pick several packs of (the rest: one).
export const MANY = ['rule', 'assets'];

// {kind: id} (rule: [ids]) → the packs, every id checked; nothing picked is fine.
export function cleanPacks(root, packs) {
  if (packs == null) return {};
  if (typeof packs !== 'object' || Array.isArray(packs)) throw new UserError('packs is an object: {kind: pack id}');
  const all = listAllPacks(root);
  const find = (kind, pid) => {
    const p = all.find((x) => x.kind === kind && x.id === pid);
    if (!p) throw new UserError(`no ${kind} pack "${pid}"`);
    if (p.confirmed === false) throw new UserError(`${p.name}: confirm its colours first (packs.confirm): the studio only suggested them from the poster`);
    return p;
  };
  const out = {};
  for (const [kind, v] of Object.entries(packs).slice(0, 20)) {
    const k = str(kind, 40);
    if (MANY.includes(k)) {
      const ids = [...new Set((Array.isArray(v) ? v : [v]).map((x) => str(x, 120)).filter(Boolean))].slice(0, 20);
      if (ids.length) out[k] = ids.map((pid) => find(k, pid));
    } else if (str(v, 120)) out[k] = find(k, str(v, 120));
  }
  return out;
}

// Save the picks and fill the briefs they answer. Call after the project exists, before it starts.
export function setProjectPacks(root, id, picked) {
  const kinds = Object.keys(picked);
  if (!kinds.length) return null;
  const saved = Object.fromEntries(kinds.map((k) => [k, MANY.includes(k) ? picked[k].map((p) => ({ id: p.id, name: p.name })) : { id: picked[k].id, name: picked[k].name }]));
  update(root, id, (p) => { p.mfx ||= {}; p.mfx.packs = saved; });
  if (picked.style) setBrief(root, id, { pack: picked.style.id });
  if (picked.motion || picked.rule) setMotionBrief(root, id, { motion_pack: picked.motion?.id || null, rule_packs: (picked.rule || []).map((p) => p.id) });
  if (picked.transition) setTransitionBrief(root, id, { transition_pack: picked.transition.id });
  if (picked.scoring) saveTheme(root, id, { ...(loadTheme(root, id) || {}), picked_by: 'you', scoring_pack: picked.scoring.id });
  const names = kinds.flatMap((k) => (MANY.includes(k) ? picked[k].map((p) => `${k} ${p.name}`) : [`${k} ${picked[k].name}`]));
  event(root, id, { event: 'PACKS', actor: 'you', details: names.join(' · ') });
  return saved;
}

export function projectPacks(root, id) {
  try { return loadProject(root, id).mfx?.packs || {}; } catch { return {}; }
}

// The scoring and voice packs' words, for every session's brief (fenced by the caller); '' when none.
export function packsBriefText(root, id) {
  const picks = projectPacks(root, id);
  const all = listAllPacks(root);
  const lines = [];
  for (const kind of ['scoring', 'voice']) {
    const p = picks[kind] && all.find((x) => x.kind === kind && x.id === picks[kind].id);
    if (p) lines.push(`${kind === 'scoring' ? 'Scoring' : 'Voice'} pack "${p.name}": ${[p.description, p.words].filter(Boolean).join(' ')}`);
  }
  return lines.join('\n');
}

// project.packs.assets {assets: [ids]}: change a project's asset packs after it started (the style pack and the other picks stay).
// The pool is rebuilt by the caller (svc/pool.mjs buildPool); frames already made are not remade.
export function setAssetPacks(root, id, ids) {
  const picked = cleanPacks(root, { assets: Array.isArray(ids) ? ids : [] }).assets || [];
  update(root, id, (p) => { p.mfx ||= {}; p.mfx.packs ||= {}; if (picked.length) p.mfx.packs.assets = picked.map((x) => ({ id: x.id, name: x.name })); else delete p.mfx.packs.assets; });
  event(root, id, { event: 'PACKS', actor: 'you', details: picked.length ? picked.map((x) => `assets ${x.name}`).join(' · ') : 'no asset packs' });
  return picked.map((x) => ({ id: x.id, name: x.name }));
}
