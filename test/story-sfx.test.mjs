// Sound marks the story's actions (named from the approved motion code or the Motion's own marks), timed by the probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { timeActions, capActions, storyActionsFor, markedActions } from '../src/svc/storysfx.mjs';
import { makePlan, summary } from '../src/svc/sfx.mjs';

function work(t) {
  const w = mkdtempSync(join(tmpdir(), 'story-'));
  t.after(() => rmSync(w, { recursive: true, force: true }));
  const put = (rel, d) => { mkdirSync(join(w, rel, '..'), { recursive: true }); writeFileSync(join(w, rel), typeof d === 'string' ? d : JSON.stringify(d)); };
  put('out/scenes.json', { fps: 30, scenes: [{ key: 's01', beat: 'b01', name: 'The question', from_frame: 0, frames: 120 }, { key: 's02', beat: 'b02', name: 'The filing', from_frame: 120, frames: 180 }] });
  put('out/scenes/clips.json', [{ beats: ['b01'], file: 'b01.mp4', from: 0, to: 120 }, { beats: ['b02'], file: 'b02.mp4', from: 120, to: 300 }]);
  put('out/scenes/b01.mp4', 'x'); put('out/scenes/b02.mp4', 'x');
  put('voice/timing.json', { seconds: 10, lines: [{ id: 'b01-1', text: 'Who gets your chats?', start: 0.2, end: 3, words: [{ text: 'Who', start: 0.2, end: 0.4 }] }, { id: 'b02-1', text: 'It filed for bankruptcy.', start: 4.2, end: 9, words: [] }] });
  put('video/src/scenes/animatic.tsx', 'export const A = () => null; // stamp at 200');
  put('video/src/actions.json', [{ shot: 's01', at_frame: 30, at_sec: 1, dur_sec: 0.3, what: '3 elements appears' }, { shot: 's02', at_frame: 203, at_sec: 6.767, dur_sec: 0.2, what: '$0.1 scales' }]);
  return w;
}

test('timeActions snaps to the nearest probed move within 6 frames; capActions keeps each scene and one length per sound', () => {
  const t = timeActions([{ shot: 's02', frame: 200, what: 'FILED stamp slams', sound: 'heavy rubber-stamp thud', importance: 3 }, { shot: 's02', frame: 260, what: 'tick', sound: 'pen tick', dur_sec: 0.4 }], [{ at_sec: 6.767 }]);
  assert.equal(t[0].at_sec, 6.767); assert.equal(t[0].snapped, true);
  assert.equal(t[1].at_sec, 8.667); assert.equal(t[1].snapped, false);
  const c = capActions([...t, { shot: 's01', at_sec: 1, dur_sec: 1, sound: 'pen tick', what: 'tick 2', importance: 1 }, { shot: 's02', at_sec: 6.9, dur_sec: 1, sound: 'x', what: 'too close', importance: 1 }], { seconds: 10 });
  assert.deepEqual(c.map((a) => a.what), ['tick 2', 'FILED stamp slams', 'tick']);
  assert.equal(c[0].dur_sec, c[2].dur_sec, 'one length per sound');
});

test('the story call names the actions once (cached by the code), the plan marks them, repeats cost once; shots have their own range and clip', async (t) => {
  const w = work(t);
  let calls = 0;
  const ask = async (prompt) => { calls++; assert.match(prompt, /stamp at 200/); assert.match(prompt, /It filed for bankruptcy/); return { ok: true, structured: { actions: [
    { shot: 's01', frame: 31, what: 'TO: ? tag snaps on', sound: 'paper tag snap', importance: 3 },
    { shot: 's02', frame: 200, what: 'FILED stamp slams', sound: 'heavy rubber-stamp thud', importance: 3, dur_sec: 0.8 },
    { shot: 's02', frame: 260, what: 'second stamp', sound: 'heavy rubber-stamp thud', importance: 2, dur_sec: 0.5 },
  ] } }; };
  const a = await storyActionsFor(w, { ask, rawActs: [{ at_sec: 1 }, { at_sec: 6.767 }], seconds: 10 });
  assert.equal(a.actions.length, 3); assert.equal(a.source, 'story call');
  const b = await storyActionsFor(w, { ask, rawActs: [], seconds: 10 });
  assert.equal(calls, 1, 'cached while the code is the same'); assert.equal(b.source, 'story call (cached)');
  const plan = makePlan(w, { story: a.actions, library: join(w, 'nolib') });
  assert.equal(plan.from, 'story');
  assert.deepEqual(plan.cues.map((c) => c.what), ['TO: ? tag snaps on', 'FILED stamp slams', 'second stamp']);
  const sm = summary(plan);
  assert.equal(sm.to_make, 3); assert.equal(sm.sounds_to_make, 2, 'the stamp is made once');
  const shots = plan.shots; // the view: shotsOf already applied
  assert.deepEqual(shots.map((s) => [s.id, s.from, s.to]), [['s01', 0, 4], ['s02', 4, 10]]);
  assert.equal(shots[1].clip.path, join(w, 'out/scenes/b02.mp4'));
});

test('the Motion session\'s own marks are used when every scene has them (no call)', async (t) => {
  const w = work(t);
  mkdirSync(join(w, 'video/src/sfx'), { recursive: true });
  writeFileSync(join(w, 'video/src/sfx/b01.json'), JSON.stringify([{ frame: 30, what: 'tag snaps', sound: 'paper tag snap' }]));
  writeFileSync(join(w, 'video/src/sfx/b02.json'), JSON.stringify([{ frame: 203, what: 'stamp', sound: 'heavy rubber-stamp thud', importance: 3 }]));
  assert.equal(markedActions(w, [{ key: 's01', beat: 'b01', from_frame: 0, frames: 120 }, { key: 's02', beat: 'b02', from_frame: 120, frames: 180 }]).actions.length, 2);
  const r = await storyActionsFor(w, { ask: () => assert.fail('no call'), rawActs: [], seconds: 10 });
  assert.equal(r.source, 'motion marks'); assert.equal(r.actions.length, 2);
  assert.ok(!existsSync(join(w, 'sound/story.json')));
});
