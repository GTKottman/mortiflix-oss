// One shot per beat (PIPELINE.md, animatic: "out/scenes.json, one scene per beat"). Run 2: the AI folded beat 7 into
// shot 6 ("Fan and cap"); the film had 7 shots for 8 beats and the owner counted them. Pure, no project imports, so
// the gates and the canvas can both use it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The beats with no scene of their own: no scene names the beat, and no scene has its shot id (b07 → s07).
export function beatsWithoutShot(beats, scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  return (Array.isArray(beats) ? beats : []).filter((b) => b && /^b\d{2,3}$/.test(String(b.id))
    && !list.some((sc) => sc && (sc.beat === b.id || sc.key === `s${String(b.id).slice(1)}`)));
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

// For a project's working folder: the beats the animatic left without a shot. Nothing before the animatic, or while
// every scene is a shot made alone (no animatic yet).
export function sceneGaps(work) {
  const scenes = readJson(join(work, 'out', 'scenes.json'))?.scenes;
  if (!Array.isArray(scenes) || !scenes.length || scenes.every((sc) => sc?.file)) return [];
  const beats = readJson(join(work, 'script', 'beats.json'))?.beats;
  return beatsWithoutShot(beats, scenes);
}

export function gapsText(gaps) {
  const names = gaps.map((b) => `${String(b.id).toUpperCase()}${b.name ? ` (${String(b.name).slice(0, 40)})` : ''}`);
  return `one shot per beat: ${names.join(', ')} ${gaps.length === 1 ? 'has' : 'have'} no shot of its own in out/scenes.json. Give every beat its own scene (its own picture, timed to its line), never folded into another shot, then re-render the animatic`;
}
