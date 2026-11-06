// Does this project want music from its voice step, and is that music there? (2026-11-02, Director 1: the voice step was
// approved with no music at all: "Music segments: none planned yet", then "Every line and cue is approved". The plan
// after the voice only ran when Settings › Voice "Eleven Music" was on, and it is off by default, so no cue was ever
// planned, and nothing stopped the step from being approved with none.)
// v3: the voice step makes the narration and the music (its pipeline step lists `work: [..., 'music']`). Planning the
// cues is free (one AI call); making them costs credits and goes through the cost OK (step.confirm_cost {step:'music'}).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths, projectPipeline } from '../projects.mjs';

const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

// The voice step that also makes the music (v3), or null.
export function musicStep(pipeline) {
  if (pipeline?.stage_set !== 'v3') return null;
  return (pipeline.steps || []).find((s) => s.key === 'voice' && Array.isArray(s.work) && s.work.includes('music')) || null;
}

// The brief wants music: a v3 project, whose voice step makes the narration and the music (the v3 intake has no
// "no music" choice; "On-screen text and music only" wants music too).
export function musicExpected(root, id) {
  try { return Boolean(musicStep(projectPipeline(root, id))); } catch { return false; }
}

export const musicCues = (root, id) => {
  const j = readOr(join(projectPaths(root, id).work, 'music', 'cues.json'), null);
  return Array.isArray(j?.cues) ? j.cues : [];
};

// No music planned yet (planning is free). The voice step itself waits for musicHeld (owner 2026-11-03: the music is
// made BEFORE Look). A plain string says why, else null.
export function musicUnplanned(root, id) {
  if (!musicExpected(root, id) || musicCues(root, id).length) return null;
  return 'the music is not planned yet: press Plan the music on Voice & music (free), then make it (you confirm the credits)';
}

// The music is not ready to mix: it is wanted and not every cue is made and OK'd
// (none planned counts). A plain string says why, else null.
export function musicHeld(root, id) {
  if (!musicExpected(root, id)) return null;
  const cues = musicCues(root, id);
  if (!cues.length) return 'the music is not planned yet: press Plan the music (free), then make it (you confirm the credits)';
  const made = (c) => c.file && c.state !== 'stale';
  if (!cues.every(made)) return `the music is planned but not made: ${cues.filter((c) => !made(c)).length} of ${cues.length} cues to make (you confirm the credits)`;
  if (!cues.every((c) => c.state === 'ok')) return `the music is made: OK each cue (${cues.filter((c) => c.state !== 'ok').length} left)`;
  return null;
}
