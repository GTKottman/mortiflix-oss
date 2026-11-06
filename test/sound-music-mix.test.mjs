// Sound mixes over the voice with the Voice step's music under it (2026-11-02, d4fd: the music was made and OK'd but
// Sound used the bare narration, and planned 0 moments after a failed motion-data read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ensureMusicMix } from '../src/svc/elmusic.mjs';
import { baseAudio } from '../src/svc/sfx.mjs';

test('ensureMusicMix makes out/voice/mix.wav from the made cues once, and Sound uses it', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'mm-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.equal(ensureMusicMix(work), null, 'no music: nothing to mix');
  mkdirSync(join(work, 'out/voice'), { recursive: true }); mkdirSync(join(work, 'music'), { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3', join(work, 'out/voice/narration.wav')]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', join(work, 'music/mc01.mp3')]);
  writeFileSync(join(work, 'voice/timing.json'), JSON.stringify({ seconds: 3, lines: [{ id: 'b01-1', start: 0.2, end: 2.5, words: [] }] }));
  writeFileSync(join(work, 'music/cues.json'), JSON.stringify({ cues: [{ id: 'mc01', from_sec: 0, to_sec: 3, crossfade_sec: 0.5, duck_db: -10, file: 'music/mc01.mp3', state: 'ok' }] }));
  assert.equal(baseAudio(work), join(work, 'out/voice/narration.wav'));
  const r = ensureMusicMix(work);
  assert.equal(r.ok, true, r.error); assert.equal(r.fresh, true);
  assert.ok(existsSync(join(work, 'out/voice/mix.wav')));
  assert.equal(baseAudio(work), join(work, 'out/voice/mix.wav'), 'Sound mixes on voice + music');
  const m = statSync(join(work, 'out/voice/mix.wav')).mtimeMs;
  assert.equal(ensureMusicMix(work).fresh, false, 'not made again while nothing changed');
  assert.equal(statSync(join(work, 'out/voice/mix.wav')).mtimeMs, m);
});
