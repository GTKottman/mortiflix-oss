// The style frames' state file (svc/frames.mjs explains it). Only fs here, so gates.mjs can import framesHeld without a cycle.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths } from '../projects.mjs';
import { writeJson } from '../studio.mjs';

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
export const framesFile = (work) => join(work, 'design', 'frames-state.json');
export const loadFrames = (work) => { const j = readJson(framesFile(work), null); return j && Array.isArray(j.frames) ? j : { version: 1, planned: false, enough: false, frames: [], rounds: [] }; };
export function saveFrames(work, st) {
  mkdirSync(join(work, 'design'), { recursive: true });
  writeJson(framesFile(work), st);
  // what the canvas and the later steps (transitions, animatic) read: only frames that have a picture
  const keep = (st.frames || []).filter((f) => f.current && f.versions.find((v) => v.v === f.current));
  const prev = readJson(join(work, 'design', 'frames.json'), {});
  writeJson(join(work, 'design', 'frames.json'), { ...(prev.using ? { using: prev.using } : {}), frames: keep.map((f) => ({ id: f.id, file: f.versions.find((v) => v.v === f.current).file, label: f.label, beats: f.beats, composition: f.composition, hold_s: f.hold_s, state: f.state, version: f.current })) });
}
export const framesHeld = (root, id) => { try { const st = loadFrames(projectPaths(root, id).work); return st.planned && st.frames.some((f) => !['ok', 'skipped'].includes(f.state)); } catch { return false; } };
export const hasFramesWork = (work) => loadFrames(work).planned;
// The owner's OKs on the style frames (the per-frame store, not the canvas): {ok, total, waiting}, or null with no plan.
// Skipped frames do not count; waiting = made and not decided (review or held).
export const frameOks = (root, id) => {
  try {
    const st = loadFrames(projectPaths(root, id).work);
    if (!st.planned || !st.frames.length) return null;
    const live = st.frames.filter((f) => f.state !== 'skipped');
    return { ok: live.filter((f) => f.state === 'ok').length, total: live.length, waiting: live.filter((f) => ['review', 'held'].includes(f.state)).length };
  } catch { return null; }
};
