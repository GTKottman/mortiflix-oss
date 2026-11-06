// What each scene of a Motion build is made from, by ABSOLUTE path: the owner's approved stills (picture + st_bNN.tsx),
// the approved style frame (picture + sfNN.tsx) and the look's code (video.ts, ui.tsx). 2026-11-02, Dir1 bdb9 and Dir2 d4fd:
// the Motion call runs in run/quick/_shared, the prompt named relative src/... paths, the session looked in
// run/quick/<id>/src/scenes, found nothing, rebuilt the scene from ui.tsx parts (tiny headline, first line missing) and
// invented a 5-mark tally. Rejected versions are never named.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stillState } from './stills.mjs';
import { loadFrames } from './framestate.mjs';
import { projectPipeline } from '../projects.mjs';

export function sceneSources(root, id, work, beats) {
  const src = join(work, 'video', 'src');
  let doc = { lines: {} };
  try { doc = stillState.load(root, id); } catch { /* no stills yet */ }
  let stillsStep = false;
  try { stillsStep = projectPipeline(root, id).steps.some((s) => s.key === 'stills'); } catch { /* no pipeline */ }
  let frames = [];
  try { frames = loadFrames(work).frames.filter((f) => f.state === 'ok' && f.current); } catch { /* no frames */ }
  const scenes = beats.map((b) => {
    const stills = Object.entries(doc.lines || {})
      .filter(([l, e]) => stillState.beatOf(l) === b && e.state === 'ok' && stillState.ver(e))
      .sort(([a], [z]) => a.localeCompare(z, 'en', { numeric: true }))
      .map(([line, e]) => ({ line, png: join(work, stillState.ver(e).file) }));
    const fr = frames.filter((f) => (f.beats || []).includes(b)).map((f) => ({ id: f.id, png: join(work, f.versions.find((v) => v.v === f.current)?.file || ''), code: join(src, 'scenes', `${f.id}.tsx`) }));
    return { beat: b, stills, stillsCode: stills.length && existsSync(join(src, 'scenes', `st_${b}.tsx`)) ? join(src, 'scenes', `st_${b}.tsx`) : null, frames: fr };
  });
  const look = [join(src, 'video.ts'), join(src, 'ui.tsx')];
  // the files a scene must be built from: missing ones fail the build honestly before any call or render
  const missing = [];
  for (const s of scenes) {
    if (stillsStep && !s.stills.length) missing.push(`approved stills of ${s.beat} (none OK'd)`);
    for (const f of [s.stillsCode, ...s.stills.map((x) => x.png), ...s.frames.flatMap((x) => [x.png, x.code])]) if (f && !existsSync(f)) missing.push(f);
  }
  for (const f of look) if (!existsSync(f)) missing.push(f);
  return { src, scenes, look, missing, stillsStep };
}

export function sourcesBlock(s) {
  const rows = s.scenes.map((x) => [
    `### Scene ${x.beat}`,
    x.stills.length ? `The owner's approved stills (one per spoken line, in order):\n${x.stills.map((t) => `- ${t.line}: picture ${t.png}`).join('\n')}\n  Their code: ${x.stillsCode} (export \`stills\`, keyed by line id)` : '',
    x.frames.length ? `Its approved style frame${x.frames.length > 1 ? 's' : ''}:\n${x.frames.map((f) => `- ${f.id}: picture ${f.png}\n  code ${f.code}`).join('\n')}` : '',
  ].filter(Boolean).join('\n'));
  return [
    `## What each scene is built from (open these exact paths with Read, before writing anything)\nThe project's video code is in ${join(s.src, '..')}; every src/... path in this prompt means ${s.src}/... (answer file paths as src/...). Your working folder is NOT the project: never look for files relative to it.`,
    ...rows,
    `The look's code: ${s.look.join(' and ')}.`,
    s.scenes.some((x) => x.stills.length)
      ? `Build each scene FROM its approved stills' code (a scene with no stills: from its approved style frame's code): import or copy their components and keep the layout, ground (background colour and texture), type (font, size, weight, case, line breaks) and every piece exactly as on the approved pictures. Add ONLY motion: how those pieces enter, move and hand over from one line's still to the next on its words. Every line's still is on screen while its words are spoken; none is dropped, shrunk or moved to another place. The pictures are the target: the scene's frames at each line must match them. Other files in design/stills, out/frames and src/scenes are versions the owner rejected or other scenes: never open them.`
      : `Build each scene FROM its approved style frame's code: import or copy its components and keep the layout, ground (background colour and texture), type (font, size, weight, case, line breaks) and every piece exactly as on the approved picture. Add ONLY motion: how those pieces enter, move and change on the scene's words. A frame covering several scenes is the look of each of them; every scene's own words are on screen while they are spoken. The picture is the target. Other files in design/stills, out/frames and src/scenes are versions the owner rejected or other scenes: never open them.`,
    `No new facts: every word, name, number, count, date and quantity on screen comes from the script or the approved stills. Never add a countable thing (tally marks, a number of icons, dots or bars standing for an amount) that the script or the stills do not show.`,
    `If any path above cannot be opened, write nothing: answer files [] and list the paths in missing_sources. The studio then stops this scene honestly; never rebuild a scene from memory, from ui.tsx alone or from the picture by eye.`,
  ].join('\n\n');
}
