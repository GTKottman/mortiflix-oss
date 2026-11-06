// A demo project ready for "Edit the video" (doc 38): five beats, nine shots cut from one animatic (Shot 4 remade as
// v2, Shot 6 cut on the board), six voice lines with timing, the music with four cues, two stems, three board
// transitions and an attached logo. All media is made locally with ffmpeg (test patterns and quiet tones): no AI, no
// cost. Used by the tests and to try the hand-off in the app:
//   node -e "import('./src/demo-handoff.mjs').then(m => m.makeHandoffDemo(root))"
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ensureStudio, saveConfig } from './studio.mjs';
import { createProject, projectPaths, update } from './projects.mjs';
import { syncCanvas, nodeAction } from './canvas.mjs';

const FPS = 30;
const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
};
const write = (dir, rel, data) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const tone = (dest, seconds, hz, volume = 0.05) => ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`, '-af', `volume=${volume}`, '-c:a', 'pcm_s16le', dest]);

export const DEMO_BEATS = [
  { id: 'b01', name: 'Cold open', words: 'In 2012 a neural network learned to see cats.' },
  { id: 'b02', name: 'The bet', words: 'Then a few labs bet everything on scale.' },
  { id: 'b03', name: 'Winter', words: 'And then the money dried up.' },
  { id: 'b04', name: 'Spring', words: 'Until one model surprised everyone.' },
  { id: 'b05', name: 'Now', words: 'Now it writes, draws and talks back.' },
];
// [scene key, beat, frames]
const SCENES = [['s01', 'b01', 90], ['s02', 'b01', 75], ['s03', 'b02', 90], ['s04', 'b02', 60], ['s05', 'b03', 90], ['s06', 'b03', 60], ['s07', 'b03', 75], ['s08', 'b04', 90], ['s09', 'b05', 105]];

export function makeHandoffDemo(root, { title = 'The Rise of AI' } = {}) {
  ensureStudio(root);
  saveConfig(root, { backend: 'demo', demoDelayMs: 0 });
  const p = createProject(root, { pipeline: 'explainer', title, answers: { topic: 'the rise of AI' } });
  const work = projectPaths(root, p.id).work;
  const frames = SCENES.reduce((a, s) => a + s[2], 0);
  const seconds = frames / FPS;

  write(work, 'script/beats.json', { beats: DEMO_BEATS });
  mkdirSync(join(work, 'out'), { recursive: true });
  ff(['-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=${FPS}:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(work, 'out', 'animatic.mp4')]);
  let at = 0;
  const scenes = SCENES.map(([key, beat, n], i) => { const s = { key, name: `Shot ${i + 1}`, beat, from_frame: at, frames: n }; at += n; return s; });
  write(work, 'out/scenes.json', { made_from: 'out/animatic.mp4', fps: FPS, scenes });

  // Six voice lines (quiet tones), each at its narration time.
  const lines = [['b01-l1', 0.4, 2.2, 'In 2012 a neural network learned to see cats.'], ['b02-l1', 5.6, 2.0, 'Then a few labs bet everything on scale.'],
    ['b03-l1', 10.6, 1.6, 'And then the money dried up.'], ['b03-l2', 13.0, 1.8, 'Projects stalled. People left.'],
    ['b04-l1', 18.4, 2.0, 'Until one model surprised everyone.'], ['b05-l1', 21.6, 2.4, 'Now it writes, draws and talks back.']];
  mkdirSync(join(work, 'voice', 'clips'), { recursive: true });
  lines.forEach(([id, , len], i) => tone(join(work, 'voice', 'clips', `${id}.wav`), len, 300 + i * 40));
  write(work, 'voice/lines.json', { lines: lines.map(([id, , , text]) => ({ id, script: text, file: `voice/clips/${id}.wav` })) });
  write(work, 'voice/timing.json', { lines: lines.map(([id, start, len]) => ({ id, start, end: +(start + len).toFixed(3) })) });

  // The music (quiet), its plan at 120 bpm (a bar = 2 s), four cues and two stems.
  mkdirSync(join(work, 'out', 'music', 'stems'), { recursive: true });
  tone(join(work, 'out', 'music', 'master.wav'), Math.ceil(seconds), 110, 0.03);
  tone(join(work, 'out', 'music', 'stems', 'bass.wav'), Math.ceil(seconds), 55, 0.03);
  tone(join(work, 'out', 'music', 'stems', 'pads.wav'), Math.ceil(seconds), 220, 0.02);
  write(work, 'music/blueprint.json', { bpm: 120, meter: '4/4', bars: 13, sections: [
    { id: 'm01', name: 'Intro', beat: 'b01', start_bar: 1, end_bar: 3 }, { id: 'm02', name: 'Build', beat: 'b02', start_bar: 4, end_bar: 5 },
    { id: 'm03', name: 'Low', beat: 'b03', start_bar: 6, end_bar: 9 }, { id: 'm04', name: 'Lift', beat: 'b04', start_bar: 10, end_bar: 13 }] });

  // The board's transitions: a dissolve into the bet, a dip to black into winter, a plain cut into spring.
  write(work, 'transitions/board.json', { cuts: [{ id: 't01', from_scene: 's02', to_scene: 's03', transition: 'Cross Dissolve' },
    { id: 't02', from_scene: 's04', to_scene: 's05', transition: 'Dip to Black' }, { id: 't03', from_scene: 's07', to_scene: 's08', transition: 'Cut' }] });

  // An attached asset (the logo), as New project would have copied it in.
  mkdirSync(join(work, 'input', 'logo'), { recursive: true });
  ff(['-f', 'lavfi', '-i', 'color=c=0xe8a33d:size=512x512:duration=1', '-frames:v', '1', join(work, 'input', 'logo', 'logo.png')]);
  update(root, p.id, (x) => { x.intake.files.push({ field: 'logo', name: 'logo.png', path: 'input/logo/logo.png' }); });

  syncCanvas(root, p.id);
  // Shot 4 remade on its own (an edit request's new version): v2, a different picture.
  mkdirSync(join(work, 'out', 'shots'), { recursive: true });
  ff(['-f', 'lavfi', '-i', `smptehdbars=size=1920x1080:rate=${FPS}:duration=2`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(work, 'out', 'shots', 's04-v2.mp4')]);
  write(work, 'out/scenes.json', { made_from: 'out/animatic.mp4', fps: FPS, scenes: scenes.map((s) => (s.key === 's04' ? { ...s, file: 'out/shots/s04-v2.mp4' } : s)) });
  syncCanvas(root, p.id);
  nodeAction(root, p.id, 's06', { action: 'cut' });
  return p;
}
