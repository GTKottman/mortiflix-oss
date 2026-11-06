// The engine supervisor (doc 16 E2) against a fake engine: requests and replies, events, a heartbeat that kills a
// silent engine's PID and starts it again (restoring the song), giving up after 3 crashes, and a clean quit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngineSupervisor } from '../src/daw-engine.mjs';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-engine.mjs');
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('requests get their replies, events arrive, errors come back as errors, quit is clean', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-eng-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const e = createEngineSupervisor({ bin: process.execPath, args: [FAKE], logFile: join(dir, 'engine.log') });
  const events = [];
  e.on('event', (m) => events.push(m.ev));
  const hello = await e.start();
  assert.equal(hello.name, 'fake');
  assert.equal(e.state, 'running');
  assert.deepEqual(await e.call('song.load', { path: '/x/song.json', atSample: 96000 }), { loaded: '/x/song.json', at: 96000 });
  await assert.rejects(e.call('no.such'), /unknown command no.such/);
  await e.call('engine.tone', { hz: 1000 });
  await until(() => events.includes('alive') && events.includes('log'));
  assert.match(readFileSync(join(dir, 'engine.log'), 'utf8'), /fake engine started[\s\S]*tone 1000/);
  const pid = e.pid;
  await e.stop();
  assert.equal(e.state, 'stopped');
  assert.throws(() => process.kill(pid, 0), 'the engine process is gone');
});

test('a silent engine: its PID is killed after the heartbeat, it starts again and the song is loaded again', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-eng-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const restored = [];
  const e = createEngineSupervisor({ bin: process.execPath, args: [FAKE], env: { ...process.env, FAKE_MODE: 'silent', FAKE_COUNT: join(dir, 'n') },
    heartbeatMs: 300, checkMs: 50, backoffMs: [50], restore: async () => restored.push('song.load') });
  t.after(() => e.stop({ graceMs: 200 }));
  await e.start();
  const first = e.pid;
  await until(() => e.pid && e.pid !== first && e.state === 'running', 5000);
  assert.throws(() => process.kill(first, 0), 'the first engine was killed by its PID');
  await until(() => restored.length >= 1);
  assert.ok(readFileSync(join(dir, 'n'), 'utf8').length >= 2, 'started twice');
});

test('killed while playing: it comes back on the same device with the same song, at the last heard place, playing (doc 16 E6)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-eng-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls');
  const e = createEngineSupervisor({ bin: process.execPath, args: [FAKE], env: { ...process.env, FAKE_CALLS: calls }, backoffMs: [30] });
  t.after(() => e.stop({ graceMs: 200 }));
  await e.start();
  await e.call('device.set', { backend: 'JACK', rate: 48000, block: 1024 });
  await e.call('song.load', { path: '/x/song.json' });
  await e.call('clock.subscribe', {});
  await e.call('transport.seek', { seconds: 12.5 });
  await e.call('transport.play', {});
  writeFileSync(calls, '');
  const first = e.pid;
  process.kill(first, 'SIGKILL');
  await until(() => e.pid !== first && e.state === 'running' && readFileSync(calls, 'utf8').includes('transport.play'), 5000);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), [
    { cmd: 'device.set', args: { backend: 'JACK', rate: 48000, block: 1024 } },
    { cmd: 'song.load', args: { path: '/x/song.json', atSeconds: 12.5 } },
    { cmd: 'clock.subscribe', args: {} },
    { cmd: 'transport.play', args: {} },
  ]);
});

test('three crashes inside a minute: it stays stopped, with its last log lines', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-eng-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const states = [];
  const e = createEngineSupervisor({ bin: process.execPath, args: [FAKE], env: { ...process.env, FAKE_MODE: 'crash', FAKE_COUNT: join(dir, 'n') }, backoffMs: [30, 30, 30] });
  e.on('state', (s) => states.push(s.state));
  await e.start().catch(() => {});
  await until(() => e.state === 'failed', 8000);
  assert.equal(readFileSync(join(dir, 'n'), 'utf8').length, 3);
  assert.ok(e.log.some((l) => /fake engine crashing/.test(l)));
  assert.ok(states.includes('restarting'));
  assert.equal(e.pid, null);
});

// The real engine, when it has been built on this machine (doc 16 E1 + E2).
const { existsSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { spawnSync, spawn } = await import('node:child_process');
const REAL = [process.env.MFX_DAW_ENGINE, join(homedir(), '.cache/mortiflix/engine-build/mortiflix-engine_artefacts/Release/mortiflix-engine')].find((f) => f && existsSync(f));

test('the real engine: --version, --selftest (1 s of a 0.5 sine into memory, the -3 dB pan law), --serve speaks the protocol', { skip: !REAL && 'the engine is not built on this machine' }, async (t) => {
  const v = JSON.parse(spawnSync(REAL, ['--version'], { encoding: 'utf8' }).stdout.trim());
  assert.equal(v.name, 'mortiflix-engine');
  assert.match(v.tracktion_engine, /^[0-9a-f]{40}$/);
  const st = spawnSync(REAL, ['--selftest'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(st.status, 0, st.stdout + st.stderr);
  const r = JSON.parse(st.stdout.trim());
  // the -3 dB pan law (doc 15 A5): a 0.5 sine centred comes out at 0.354 per channel, panned hard left at 0.5
  assert.ok(Math.abs(r.peak - 0.5 * Math.SQRT1_2) < 0.002 && Math.abs(r.hard_left_peak - 0.5) < 0.002 && r.seconds === 1, JSON.stringify(r));
  assert.equal(st.stdout.trim().split('\n').length, 1, 'stdout carries only the JSON line');
  const e = createEngineSupervisor({ bin: REAL, args: ['--serve'] });
  t.after(() => e.stop());
  const hello = await e.start();
  assert.equal(hello.rate, 48000);
  await assert.rejects(e.call('no.such'), /unknown command no.such/);
  let alive = 0;
  e.on('alive', () => alive++);
  await until(() => alive >= 1, 3000);
  const pid = e.pid;
  await e.stop();
  assert.throws(() => process.kill(pid, 0));
});

// Sound out (doc 16 E3): only when asked (MFX_SOUND_TEST=1), since it plays through this machine's output. The tone is
// at -60 dBFS by default (MFX_SOUND_DB), measured where PipeWire hands it to the output (the default sink's monitor).
test('sound out: a tone through JACK (PipeWire) and ALSA reaches the output at its level, with no xruns', { skip: (!REAL || process.env.MFX_SOUND_TEST !== '1') && 'set MFX_SOUND_TEST=1 to play through the output' }, async () => {
  const db = Number(process.env.MFX_SOUND_DB || -60);
  for (const backend of ['JACK', 'ALSA']) {
    const e = createEngineSupervisor({ bin: REAL, args: ['--serve'] });
    const events = [];
    e.on('event', (m) => events.push(m));
    await e.start();
    const dev = await e.call('device.set', { backend, rate: 48000, block: 1024 }, { timeout: 15000 });
    assert.equal(dev.state, 'open');
    assert.equal(dev.rate, 48000);
    const rec = spawn('parec', ['--device=@DEFAULT_MONITOR@', '--format=float32le', '--rate=48000', '--channels=2', '--raw', '--latency-msec=20']);
    const chunks = []; rec.stdout.on('data', (d) => chunks.push(d));
    await new Promise((r) => setTimeout(r, 500));
    await e.call('engine.tone', { hz: 1000, db, ms: 1500 });
    await until(() => events.some((x) => x.ev === 'tone'), 5000);
    await new Promise((r) => setTimeout(r, 500));
    rec.kill();
    const buf = Buffer.concat(chunks);
    const n = Math.floor(buf.length / 8);
    const k = 2 * Math.cos(2 * Math.PI * 1000 / 48000);
    const levels = [];
    for (let a = 0; a + 4800 <= n; a += 4800) {
      let s1 = 0, s2 = 0;
      for (let i = a; i < a + 4800; i++) { const s0 = buf.readFloatLE(i * 8) + k * s1 - s2; s2 = s1; s1 = s0; }
      levels.push(20 * Math.log10(2 * Math.sqrt(Math.max(1e-30, s1 * s1 + s2 * s2 - k * s1 * s2)) / 4800));
    }
    const on = levels.filter((x) => x > db - 10);
    assert.ok(on.length >= 10, `${backend}: the tone reached the output in ${on.length} windows`);
    const steady = on.slice(1, -1);
    assert.ok(steady.every((x) => Math.abs(x - db) < 0.5), `${backend}: ${steady.map((x) => x.toFixed(1)).join(' ')}`);
    assert.equal(events.find((x) => x.ev === 'tone').xruns, 0);
    await e.stop();
  }
});

test('the real engine builds a song from song.json: every note, every part, its length (doc 16 E4)', { skip: !REAL && 'the engine is not built on this machine' }, async (t) => {
  const { songFromNotes } = await import('../src/song-import.mjs');
  const { writeSong } = await import('../src/song.mjs');
  const { writeFileSync, readFileSync: rf } = await import('node:fs');
  const fx = join(import.meta.dirname, 'fixtures', 'songs', 'four');
  const { song } = songFromNotes({ blueprint: JSON.parse(rf(join(fx, 'blueprint.json'), 'utf8')), notes: JSON.parse(rf(join(fx, 'notes.json'), 'utf8')), instruments: null });
  const dir = mkdtempSync(join(tmpdir(), 'mfx-eng-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'song.json'), writeSong(song));
  const e = createEngineSupervisor({ bin: REAL, args: ['--serve'] });
  t.after(() => e.stop());
  await e.start();
  const r = await e.call('song.load', { path: join(dir, 'song.json') }, { timeout: 60000 });
  const notes = song.patterns.reduce((s, p) => s + Object.values(p.notes).reduce((a, ns) => a + ns.length, 0), 0);
  assert.deepEqual([r.tracks, r.notes], [3, notes]);
  assert.ok(Math.abs(r.seconds - 8 * 4 * 60 / 96) < 0.6, `${r.seconds} s for 8 bars at 96 BPM (plus a ringing note)`);
  await assert.rejects(e.call('transport.play', {}), /no sound device open/);
  await assert.rejects(e.call('song.load', { path: join(dir, 'missing.json') }), /no song file/);
});

test('the real engine killed by its PID comes back with the song at the same place (doc 16 E6)', { skip: !REAL && 'the engine is not built on this machine' }, async (t) => {
  const { songFromNotes } = await import('../src/song-import.mjs');
  const { writeSong } = await import('../src/song.mjs');
  const fx = join(import.meta.dirname, 'fixtures', 'songs', 'four');
  const { song } = songFromNotes({ blueprint: JSON.parse(readFileSync(join(fx, 'blueprint.json'), 'utf8')), notes: JSON.parse(readFileSync(join(fx, 'notes.json'), 'utf8')), instruments: null });
  const dir = mkdtempSync(join(tmpdir(), 'mfx-eng-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'song.json'), writeSong(song));
  const e = createEngineSupervisor({ bin: REAL, args: ['--serve'], backoffMs: [100] });
  t.after(() => e.stop());
  let clock = null;
  e.on('clock', (m) => { clock = { ...m, pid: e.pid }; });
  await e.start();
  await e.call('song.load', { path: join(dir, 'song.json'), atSeconds: 3.5 }, { timeout: 60000 });
  await e.call('clock.subscribe', {});
  await until(() => clock?.pid === e.pid);
  assert.ok(Math.abs(clock.seconds - 3.5) < 0.001, `the clock says ${clock.seconds} s`);
  const first = e.pid;
  process.kill(first, 'SIGKILL');
  await until(() => e.pid !== first && e.state === 'running', 10000);
  clock = null;
  await until(() => clock?.pid === e.pid, 10000);
  assert.ok(Math.abs(clock.seconds - 3.5) < 0.001, `back at ${clock.seconds} s`);
  assert.equal(clock.bar, 2, '3.5 s at 96 BPM is in bar 2');
  assert.equal(e.place.song, join(dir, 'song.json'));
});

test('the real engine: mixer.set moves a channel\'s fader or pan by channel or insert id, and says no to the rest (doc 15 A7)', { skip: !REAL && 'the engine is not built on this machine' }, async (t) => {
  const { songFromNotes } = await import('../src/song-import.mjs');
  const { writeSong } = await import('../src/song.mjs');
  const fx = join(import.meta.dirname, 'fixtures', 'songs', 'four');
  const { song } = songFromNotes({ blueprint: JSON.parse(readFileSync(join(fx, 'blueprint.json'), 'utf8')), notes: JSON.parse(readFileSync(join(fx, 'notes.json'), 'utf8')), instruments: null });
  const dir = mkdtempSync(join(tmpdir(), 'mfx-eng-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'song.json'), writeSong(song));
  const e = createEngineSupervisor({ bin: REAL, args: ['--serve'] });
  t.after(() => e.stop());
  await e.start();
  await assert.rejects(e.call('mixer.set', { channel: 'ch02', field: 'volDb', value: -6 }), /no song loaded/);
  await e.call('song.load', { path: join(dir, 'song.json') }, { timeout: 60000 });
  assert.deepEqual(await e.call('mixer.set', { channel: 'ch02', field: 'volDb', value: -6 }), { channel: 'ch02', field: 'volDb', value: -6 });
  assert.deepEqual(await e.call('mixer.set', { insert: 'mx03', field: 'pan', value: 2 }), { channel: 'ch03', field: 'pan', value: 1 });
  await assert.rejects(e.call('mixer.set', { channel: 'nope', field: 'pan', value: 0 }), /no channel nope/);
  await assert.rejects(e.call('mixer.set', { channel: 'ch02', field: 'width', value: 1 }), /can't set width yet/);
});
