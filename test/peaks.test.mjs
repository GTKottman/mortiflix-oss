import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function harness(t, root) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  return async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    return out.find((m) => m.id === id);
  };
}

test('audio.peaks: buckets, cap, cache, path safety', { skip: !hasFfmpeg }, async (t) => {
  const root = tempStudio(t);
  const call = harness(t, root);
  mkdirSync(join(root, 'media'), { recursive: true });
  const wav = join(root, 'media', 'tone.wav');
  // 1 s of silence-free sine at an eighth volume x4 = 0.5, then 1 s of silence
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-filter_complex', '[0]volume=4[a];[1]atrim=0:1[b];[a][b]concat=n=2:v=0:a=1', '-ac', '1', wav]);
  assert.equal(r.status, 0, String(r.stderr));

  const a = await call('audio.peaks', { path: wav, buckets: 10 });
  assert.ok(a.ok, JSON.stringify(a));
  assert.equal(a.result.peaks.length, 10);
  assert.ok(Math.abs(a.result.duration_s - 2) < 0.1, `duration ${a.result.duration_s}`);
  assert.ok(a.result.peaks[2] > 0.4 && a.result.peaks[2] < 0.55, `loud half ${a.result.peaks[2]}`);
  assert.ok(a.result.peaks[8] < 0.01, 'silent half');
  assert.equal(a.result.cached, false);

  const b = await call('audio.peaks', { path: 'media/tone.wav', buckets: 10 }); // studio-relative, same key
  assert.equal(b.result.cached, true);
  assert.deepEqual(b.result.peaks, a.result.peaks);
  assert.equal(readdirSync(join(root, 'state', 'cache', 'peaks')).length, 1);

  const d = await call('audio.peaks', { path: wav });
  assert.equal(d.result.peaks.length, 400);
  const big = await call('audio.peaks', { path: wav, buckets: 99999 });
  assert.equal(big.result.peaks.length, 4000);

  // a changed mtime misses the cache
  const later = new Date(Date.now() + 5000); utimesSync(wav, later, later);
  assert.equal((await call('audio.peaks', { path: wav, buckets: 10 })).result.cached, false);

  for (const bad of ['/etc/passwd', '../outside.wav', '', join(root, 'media', 'nope.wav')]) {
    const e = await call('audio.peaks', { path: bad });
    assert.equal(e.ok, false, bad);
    assert.equal(e.error.code, 'bad_request');
  }
  const out = join(tmpdir(), `mfx-peaks-out-${process.pid}.wav`);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=0.2', out]);
  symlinkSync(out, join(root, 'media', 'link.wav'));
  const l = await call('audio.peaks', { path: join(root, 'media', 'link.wav') });
  assert.equal(l.ok, false, 'symlink out of the studio is refused');
  assert.match(l.error.message, /inside the studio/);
});

test('audio.peaks: not audio gives a plain error', { skip: !hasFfmpeg }, async (t) => {
  const root = tempStudio(t);
  const call = harness(t, root);
  writeFileSync(join(root, 'junk.wav'), 'not audio at all');
  const e = await call('audio.peaks', { path: join(root, 'junk.wav') });
  assert.equal(e.ok, false);
  assert.match(e.error.message, /could not read that audio/);
});
