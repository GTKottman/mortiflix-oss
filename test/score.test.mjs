import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickClock } from '../src/svc/score.mjs';

test('music score: ticks become seconds over the tempo map, after the song\'s offset', () => {
  const at = tickClock({ ppq: 960, offsetSec: 0.5, tempo: [{ tick: 0, bpm: 120 }, { tick: 1920, bpm: 60 }] });
  assert.equal(at(0), 0.5);
  assert.equal(at(960), 1, 'a beat at 120 bpm is half a second');
  assert.equal(at(1920), 1.5);
  assert.equal(at(2880), 2.5, 'a beat at 60 bpm is a second');
});
