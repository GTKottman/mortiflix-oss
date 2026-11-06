// Hearing a song (src/music/listen.mjs): tempo, key and chords from a made-up song whose answers are known.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hearSamples, progressionOf } from '../src/music/listen.mjs';

const SR = 22050;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

// 4/4 at `bpm`: a kick on every beat, a held chord per bar (each note 6 harmonics) over its root an octave down, `bars` bars.
function song({ bpm = 120, bars = 16, chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]] } = {}) {
  const beat = 60 / bpm, n = Math.round(bars * 4 * beat * SR), x = new Float32Array(n);
  for (let b = 0; b < bars * 4; b++) {
    const s = Math.round(b * beat * SR);
    for (let i = 0; i < 0.12 * SR && s + i < n; i++) { const t = i / SR; x[s + i] += 0.8 * Math.exp(-t * 30) * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 40)) * t); }
  }
  for (let k = 0; k < bars; k++) {
    const s = Math.round(k * 4 * beat * SR), len = Math.round(4 * beat * SR);
    const ch = chords[k % chords.length];
    for (const m of [ch[0] - 12, ...ch]) for (let h = 1; h <= 6; h++) {
      const f = hz(m) * h, a = 0.05 * 0.7 ** (h - 1);
      for (let i = 0; i < len && s + i < n; i++) x[s + i] += a * Math.sin(2 * Math.PI * f * i / SR) * Math.min(1, i / 400, (len - i) / 400);
    }
  }
  return x;
}

test('a 120 BPM song in A minor playing Am F C G is heard as that', () => {
  const r = hearSamples(song(), SR);
  assert.ok(Math.abs(r.bpm - 120) < 1.5, `bpm ${r.bpm}`);
  assert.equal(r.key, 'A minor');
  assert.deepEqual(r.chords.slice(0, 4), ['Am', 'F', 'C', 'G']);
  assert.match(r.progression, /^Am F C G ×/);
  assert.ok(Math.abs(r.seconds - 32) < 0.01);
});

test('another tempo and key: 96 BPM, D major, D G A D', () => {
  const r = hearSamples(song({ bpm: 96, bars: 12, chords: [[50, 54, 57], [55, 59, 62], [57, 61, 64], [50, 54, 57]] }), SR);
  assert.ok(Math.abs(r.bpm - 96) < 1.5, `bpm ${r.bpm}`);
  assert.equal(r.key, 'D major');
  assert.deepEqual(r.chords.slice(0, 3), ['D', 'G', 'A']);
});

test('silence has no tempo and says so', () => {
  const r = hearSamples(new Float32Array(SR * 10), SR);
  assert.equal(r.bpm, null);
  assert.deepEqual(r.chords, []);
});

test('progressionOf folds the loop and counts the rest', () => {
  assert.equal(progressionOf(['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G']), 'Am F C G ×2');
  assert.equal(progressionOf(['C', 'C', 'C', 'F']), 'C ×3, then 1 more bar');
  assert.equal(progressionOf(['C', 'F', 'G']), 'C F G');
  assert.equal(progressionOf([]), '');
});
