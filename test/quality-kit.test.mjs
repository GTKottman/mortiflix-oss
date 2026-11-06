// The audio analysis kit (doc 15 A1) measured against signals whose answers are known by arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sine, sweep, impulse, silence, bursts, concat, writeWav, readWav, peak, rms, nullTest, spectrum, strongest, onsets, RATE } from './quality/kit.mjs';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

test('peak and RMS of sines are what the arithmetic says', () => {
  near(peak(sine({ db: -20 })).db, -20, 0.001, 'peak of a −20 dBFS sine');
  near(rms(sine({ db: 0 })).db, -3.0103, 0.001, 'RMS of a full-scale sine');
  near(rms(sine({ db: -20 })).db, -23.0103, 0.001, 'RMS of a −20 dBFS sine');
  // a sine at rate/4 with phase π/4: every sample is 3 dB under the true peak (the sample-peak under-read, BS.1770)
  near(peak(sine({ freq: RATE / 4, db: 0, phase: Math.PI / 4 })).db, -3.0103, 0.001, 'sample peak at fs/4, 45°');
  assert.equal(peak(silence()).db, -Infinity);
  const p = peak(impulse({ at: 0.5, db: -6 }));
  near(p.db, -6, 0.001, 'impulse level');
  assert.equal(p.at, 0.5);
});

test('null test: identical, gain and offset', () => {
  const a = sine({ db: -10 });
  assert.equal(nullTest(a, sine({ db: -10 })).identical, true);
  const quieter = sine({ db: -16 });
  assert.ok(nullTest(a, quieter).peakDb > -20);                      // 6 dB apart: no null
  assert.ok(nullTest(a, quieter, { gainDb: 6 }).peakDb < -100);      // gain matched: nulls (float rounding only)
  const late = concat(silence({ seconds: 0.01 }), a);
  assert.ok(nullTest(a, late, { offset: 480 }).peakDb < -140);        // 10 ms = 480 samples at 48 kHz
  assert.throws(() => nullTest(a, sine({ channels: 1 })), /channel counts/);
});

test('spectrum finds the tones and their levels', () => {
  const [top] = strongest(spectrum(sine({ freq: 1000, db: -12 })));
  near(top.freq, 1000, RATE / 16384, 'frequency');
  near(top.db, -12, 1.5, 'level (Hann scalloping at most 1.42 dB)');
  const lo = sine({ freq: 440, db: -6, channels: 1 }).channels[0];
  const hi = sine({ freq: 5000, db: -20, channels: 1 }).channels[0];
  const two = { rate: RATE, channels: [lo.map((v, i) => v + hi[i])] };
  const peaks = strongest(spectrum(two), 2).map((p) => p.freq).sort((a, b) => a - b);
  near(peaks[0], 440, 10, 'low tone'); near(peaks[1], 5000, 10, 'high tone');
  // a log sweep spends equal time per octave, so its spectrum falls 3 dB per octave: 1 kHz → 4 kHz is 6 dB down
  const bins = spectrum(sweep({ seconds: 2 }), { size: 131072 })   // the whole sweep, zero-padded;
  const band = (f) => { const b = bins.filter((x) => x.freq > f / 1.2 && x.freq < f * 1.2); return 10 * Math.log10(b.reduce((s, x) => s + 10 ** (x.db / 10), 0) / b.length); };
  near(band(1000) - band(4000), 6.02, 1, 'sweep slope');
});

test('onsets land on the sample', () => {
  const at = [0.1, 0.2505, 0.7];
  const got = onsets(bursts({ at, db: -12, length: 0.03 }), { thresholdDb: -60 });
  assert.equal(got.length, 3);
  got.forEach((t, i) => near(t, at[i], 1.5 / RATE, `onset ${i + 1}`));   // the burst starts at sin(0) = 0: next sample
});

test('WAV write → read round trip: float exact, 24-bit within half a step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-kit-'));
  try {
    const s = sweep({ seconds: 0.5 });
    writeWav(join(dir, 'f.wav'), s);
    assert.equal(nullTest(s, readWav(join(dir, 'f.wav'))).identical, true);
    writeWav(join(dir, 'i.wav'), s, { bits: 24 });
    const r = readWav(join(dir, 'i.wav'));
    assert.equal(r.rate, RATE);
    assert.ok(nullTest(s, r).peakDb <= 20 * Math.log10(0.5 / 8388608) + 0.01);
    writeWav(join(dir, 's.wav'), s, { bits: 16 });
    assert.ok(nullTest(s, readWav(join(dir, 's.wav'))).peakDb <= 20 * Math.log10(0.5 / 32768) + 0.01);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
