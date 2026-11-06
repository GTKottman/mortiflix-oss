// The sound planner marks beats like a sound designer: merged, no exits or tiny moves, capped, one sound per kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soundBeats, uniqueCredits, creditsFor } from '../src/svc/sfx.mjs';

test('soundBeats: merge within 150 ms, drop exits/changes/tiny, cap ~1 per 1.75 s, each scene first', () => {
  const acts = [];
  // 60 s, an action every 0.2 s with exits and changes mixed in (like d4fd's 284)
  for (let i = 0; i < 300; i++) {
    const at = +(i * 0.2).toFixed(3);
    const verb = ['slides in', 'appears', 'leaves', 'changes', 'appears'][i % 5];
    acts.push({ shot: `s0${1 + Math.floor(at / 10)}`, at_sec: at, dur_sec: 0.4, what: `${1 + (i % 7)} elements ${verb}` });
    if (i % 3 === 0) acts.push({ shot: `s0${1 + Math.floor(at / 10)}`, at_sec: +(at + 0.05).toFixed(3), dur_sec: 0.4, what: '2 elements appears' }); // a child
  }
  acts.push({ shot: 's01', at_sec: 0.01, dur_sec: 0.033, what: '1 elements appears' }); // tiny
  const b = soundBeats(acts, { seconds: 60 });
  assert.ok(b.length >= 30 && b.length <= 36, `30-36 beats for 60 s, got ${b.length}`);
  assert.ok(b.every((x) => !/leaves|changes/i.test(x.what)));
  for (let i = 1; i < b.length; i++) assert.ok(b[i].at_sec - b[i - 1].at_sec >= 0.5 - 1e-9, 'beats at least 0.5 s apart');
  for (const s of ['s01', 's02', 's03', 's04', 's05', 's06']) assert.ok(b.some((x) => x.shot === s), `${s} has a beat`);
  assert.ok(b.some((x) => x.merged > 1), 'children merged into their beat');
  // one sound per kind: the credits count each prompt+length once
  const cues = b.map((x) => ({ source: 'generate', prompt: x.sound, dur_sec: x.dur_sec }));
  assert.ok(uniqueCredits(cues) <= 2 * creditsFor({ source: 'generate', dur_sec: 0.6 }), 'two kinds: two sounds to pay for');
});
