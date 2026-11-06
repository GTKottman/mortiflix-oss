// How much the owner reviews at a time (owner 2026-11-01: "let them set how many options they would like to see",
// "they should be able to set how many they want each review"). Three user settings in config.json:
//   options.count          1-8, default 4  smart options shown per screen (svc/options.mjs)
//   review.framesPerRound  1-6, default 3  style frames made per round (svc/frames.mjs)
//   review.scenesPerGroup  1-6, default 1  scenes whose stills are made and checked together (svc/stills.mjs)
// Read with settings.get, changed with settings.set (service.mjs). No project-level override.
import { loadConfig, saveConfig, UserError } from '../studio.mjs';

export const LIMITS = {
  optionsCount: { key: 'options.count', min: 1, max: 8, def: 4 },
  framesPerRound: { key: 'review.framesPerRound', min: 1, max: 6, def: 3 },
  scenesPerGroup: { key: 'review.scenesPerGroup', min: 1, max: 6, def: 1 },
};
// A stored value that is not a whole number in range falls back to the default (a hand-edited config never breaks a step).
const pick = (v, L) => (Number.isInteger(v) && v >= L.min && v <= L.max ? v : L.def);

export function reviewSettings(config = {}) {
  return {
    options: { count: pick(config.options?.count, LIMITS.optionsCount) },
    review: { framesPerRound: pick(config.review?.framesPerRound, LIMITS.framesPerRound), scenesPerGroup: pick(config.review?.scenesPerGroup, LIMITS.scenesPerGroup) },
  };
}
export const readReviewSettings = (root) => reviewSettings(loadConfig(root));

function check(v, L) {
  if (!Number.isInteger(v) || v < L.min || v > L.max) throw new UserError(`${L.key} is a whole number from ${L.min} to ${L.max}`);
  return v;
}

// patch: {options?: {count}, review?: {framesPerRound?, scenesPerGroup?}}; anything missing stays as it is, anything out of range is refused.
export function saveReviewSettings(root, patch = {}) {
  const cur = readReviewSettings(root);
  const o = patch.options || {}; const r = patch.review || {};
  const next = {
    options: { count: o.count === undefined ? cur.options.count : check(o.count, LIMITS.optionsCount) },
    review: {
      framesPerRound: r.framesPerRound === undefined ? cur.review.framesPerRound : check(r.framesPerRound, LIMITS.framesPerRound),
      scenesPerGroup: r.scenesPerGroup === undefined ? cur.review.scenesPerGroup : check(r.scenesPerGroup, LIMITS.scenesPerGroup),
    },
  };
  const saved = loadConfig(root);
  saveConfig(root, { options: { ...(saved.options || {}), ...next.options }, review: { ...(saved.review || {}), ...next.review } });
  return readReviewSettings(root);
}
