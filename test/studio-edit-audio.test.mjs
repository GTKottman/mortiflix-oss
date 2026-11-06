// The Mortiflix Studio hand-off's audio (doc 15 A4): 24-bit, resampled once by soxr, and Mortiflix Studio gives back what went in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepAudio, studioBin } from '../src/studio-edit.mjs';
import { sine, sweep, writeWav, readWav, nullTest, spectrum, strongest } from './quality/kit.mjs';

const ffmpeg = !spawnSync('ffmpeg', ['-version']).error;
const FC = studioBin()?.cli || '';
const bits = (f) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=bits_per_sample', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim();

test('voice and music go to Mortiflix Studio as 24-bit: a float mix loses nothing above −138 dBFS', { skip: !ffmpeg && 'ffmpeg is not installed' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-fca-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = sweep({ seconds: 2, db: -3 });
  writeWav(join(dir, 'mix.wav'), src);
  prepAudio(join(dir, 'mix.wav'), join(dir, 'out.wav'));
  assert.equal(bits(join(dir, 'out.wav')), '24');
  assert.ok(nullTest(src, readWav(join(dir, 'out.wav'))).peakDb < -138, 'only 24-bit rounding');
});

test('a 44.1 kHz file is resampled once, cleanly (noise and distortion > 100 dB under the tone)', { skip: !ffmpeg && 'ffmpeg is not installed' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-fca-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeWav(join(dir, 'in.wav'), sine({ freq: 1000, db: -1, seconds: 2, rate: 44100 }));
  prepAudio(join(dir, 'in.wav'), join(dir, 'out.wav'));
  const w = readWav(join(dir, 'out.wav'));
  assert.equal(w.rate, 48000);
  const bins = spectrum(w, { from: 0.5, size: 65536 });
  const tone = strongest(bins, 1)[0];
  let rest = 0;
  for (const b of bins) if (Math.abs(b.freq - 1000) > 50 && b.freq > 20) rest += 10 ** (b.db / 10);
  assert.ok(Math.abs(tone.freq - 1000) < 1);
  assert.ok(10 * Math.log10(rest) - tone.db < -100, `noise + distortion ${(10 * Math.log10(rest) - tone.db).toFixed(1)} dB`);
});

test('Mortiflix Studio plays the 24-bit file back as it went in (24-bit export)', { skip: (!ffmpeg || !existsSync(FC)) && 'Mortiflix Studio or ffmpeg is not installed' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-fca-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = sweep({ seconds: 2, db: -3 });
  writeWav(join(dir, 'mix.wav'), src);
  prepAudio(join(dir, 'mix.wav'), join(dir, 'in.wav'));
  const proj = join(dir, 'rt.fcproj');
  const fc = (...a) => { const r = spawnSync(FC, ['--compact', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  fc('--save-as', proj, 'exec', 'file.newProject', '{"name":"rt"}');
  const item = JSON.parse(fc('--project', proj, '--save', 'exec', 'file.import', JSON.stringify({ paths: [join(dir, 'in.wav')] }))).items[0];
  fc('--project', proj, '--save', 'exec', 'file.newSequence', '{"name":"rt","video":1,"audio":2}');
  fc('--project', proj, '--save', 'exec', 'timeline.place', JSON.stringify({ item, track: 'A1', seconds: 0, insert: false, video: false }));
  fc('--project', proj, 'export', join(dir, 'out.wav'), '--preset', 'Waveform Audio 48 kHz 24-bit');
  const r = nullTest(src, readWav(join(dir, 'out.wav')));
  assert.ok(r.peakDb < -130, JSON.stringify(r));   // two 24-bit roundings (ours, then Mortiflix Studio's export): ≤ 2 steps
});
