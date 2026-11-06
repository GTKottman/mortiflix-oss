// The music master (doc 15 A3): loudnorm that keeps the music as it is stays exactly as before; loudnorm that rides
// the level is reported, with why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { masterTo } from '../pipelines/_shared/skills/music/lib/master.mjs';
import { sine, concat, writeWav, readWav, nullTest } from './quality/kit.mjs';

const ffmpeg = !spawnSync('ffmpeg', ['-version']).error;
const skip = ffmpeg ? false : 'ffmpeg is not installed';

test('a mix that only needs turning up: linear, no warning, same sound as before this change', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-master-'));
  try {
    const mix = join(dir, 'mix.wav');
    writeWav(mix, concat(sine({ freq: 220, db: -26, seconds: 4 }), sine({ freq: 330, db: -22, seconds: 4 })));
    const m = masterTo(mix, join(dir, 'master.wav'));
    assert.equal(m.normalization, 'linear');
    assert.deepEqual(m.warnings, []);
    // the old second pass (without print_format) writes the same samples
    const old = join(dir, 'old.wav');
    const p1 = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', mix, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const j = JSON.parse(p1.slice(p1.lastIndexOf('{'), p1.lastIndexOf('}') + 1));
    spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-y', '-i', mix, '-af', `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`, '-ar', '48000', '-c:a', 'pcm_s24le', old]);
    assert.equal(nullTest(readWav(old), readWav(join(dir, 'master.wav'))).identical, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a quiet mix with hot peaks: the ride is reported with the numbers', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-master-'));
  try {
    const mix = join(dir, 'mix.wav');
    // −30 dBFS bed with clicks near full scale: +12 dB would push the peaks far over −1 dBTP
    const s = sine({ freq: 220, db: -30, seconds: 8 });
    for (let t = 0.5; t < 8; t += 1) for (const c of s.channels) for (let i = 0; i < 48; i++) c[Math.round(t * 48000) + i] = 0.9 * Math.sin(Math.PI * i / 48);
    writeWav(mix, s);
    const m = masterTo(mix, join(dir, 'master.wav'));
    assert.equal(m.normalization, 'dynamic');
    assert.equal(m.warnings.length, 1);
    assert.match(m.warnings[0], /ridden up and down/);
    assert.match(m.warnings[0], /over the -1 dBTP limit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
