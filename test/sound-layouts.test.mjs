import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { motionCodeFiles, storyPrompt, storyActionsFor } from '../src/svc/storysfx.mjs';
import { emptyWhy, shotsOf } from '../src/svc/sfx.mjs';

function project() {
  const w = mkdtempSync(join(tmpdir(), 'lay-'));
  for (const d of ['video/src/scenes', 'out/scenes', 'voice', 'sound']) mkdirSync(join(w, d), { recursive: true });
  for (const f of ['timing.ts', 'Main.tsx', 'scenes/animatic.tsx', 'scenes/anim_b02.tsx', 'scenes/sf01.tsx', 'scenes/st_b02.tsx', 'scenes/anim_b03.v3.tsx.bak']) writeFileSync(join(w, 'video/src', f), `// ${f}`);
  writeFileSync(join(w, 'out/scenes/s01-e011.mp4'), 'x'); writeFileSync(join(w, 'out/scenes/s02-v2.mp4'), 'x');
  writeFileSync(join(w, 'out/scenes.json'), JSON.stringify({ fps: 30, scenes: [{ key: 's01', beat: 'b01', from_frame: 0, frames: 90, file: 'out/scenes/s01-e011.mp4' }, { key: 's02', beat: 'b02', from_frame: 90, frames: 60, file: 'out/scenes/s02-v2.mp4' }] }));
  writeFileSync(join(w, 'voice/timing.json'), JSON.stringify({ lines: [] }));
  return w;
}

test('the approved scene code is found in the anim_<beat> layout (bdb9)', () => {
  const w = project();
  assert.deepEqual(motionCodeFiles(w), ['timing.ts', 'Main.tsx', 'scenes/animatic.tsx', 'scenes/anim_b02.tsx']);
  const p = storyPrompt(w, [{ key: 's02', beat: 'b02', from_frame: 90, frames: 60 }], { cap: 4, note: 'the UNANIMOUS stamp' });
  assert.match(p, /anim_b02\.tsx/);
  assert.match(p, /owner's note[\s\S]*UNANIMOUS stamp/);
});

test('story actions without probes, the note asked; shots use the scene clips', async () => {
  const w = project();
  let asked = '';
  const st = await storyActionsFor(w, { ask: async (prompt) => { asked = prompt; return { ok: true, structured: { actions: [{ shot: 's02', frame: 100, what: 'stamp', sound: 'rubber stamp thud', importance: 3 }] } }; }, note: 'stamp it' });
  assert.equal(st.actions.length, 1);
  assert.match(asked, /stamp it/);
  const shots = shotsOf(w, { shots: ['s01', 's02'], cues: [] });
  assert.equal(shots[1].clip.path, join(w, 'out/scenes/s02-v2.mp4'));
  assert.equal(shots[1].clip.from_sec, 0);
});

test('an empty sound plan always says why', () => {
  const w = project();
  assert.match(emptyWhy(w).why, /no sound moments in the 2 approved scenes/);
  writeFileSync(join(w, 'sound/sfx-plan.json'), JSON.stringify({ cues: [], shots: [], why: 'the story call failed' }));
  assert.equal(emptyWhy(w).why, 'the story call failed');
});

test('a library sound must fit the action: verb in its name, same material', async () => {
  const { matchLibrary } = await import('../src/svc/sfx.mjs');
  const it = (name) => ({ name, prompt: name, tokens: new Set(name.toLowerCase().split(/[^a-z0-9]+/)), abs: `/x/${name}.mp3` });
  const lib = [it('big block letters landing on paper'), it('long paper tear rip'), it('armful of cards and plastic swept off a table'), it('large sheet of paper pulled quickly off a desk'), it('four small paper pin clicks')];
  assert.equal(matchLibrary('big paper rip', 0.6, lib).name, 'long paper tear rip');
  assert.match(matchLibrary('big paper rip', 0.6, lib).match, /^tear \+ paper/);
  assert.equal(matchLibrary('paper fold swish', 0.6, lib), null);
  assert.equal(matchLibrary('plug yanked from socket with electric zap', 0.6, lib), null);
  assert.equal(matchLibrary('roller blind snap up', 0.6, lib, { what: 'page snaps up' }), null);
});

test('a ringtone fits only a phone ringing', async () => {
  const { matchLibrary } = await import('../src/svc/sfx.mjs');
  const it = (name) => ({ name, prompt: name, tokens: new Set(name.toLowerCase().split(/[^a-z0-9]+/)), abs: `/x/${name}.mp3` });
  const lib = [it('rapid cascade of phone ringtones and electronic blips building')];
  assert.equal(matchLibrary('camera lock-on beep click', 0.6, lib, { what: 'eye locks onto the plate' }), null);
  assert.ok(matchLibrary('phone ringtones and blips', 0.6, lib, { what: 'a phone rings' }));
});
