// The engine's timing (doc 15 A6) against renders of songs made here, whose every click the test computes on its own:
//   Q2  positions: a 2-hour song with a tempo change at bar 500; bar 3000's notes land on their exact samples
//   Q6  sample-accurate notes: 1/32 notes with a 7-tick swing at 97 BPM, each on its own sample, at blocks 64 and 1024
//   Q7  delay compensation: a plugin that delays 512 samples and says so, beside a dry copy turned upside down: silence
//   Q8  track delay: +10 ms moves a channel's clicks 480 samples later than the others, −10 ms 480 earlier
//   Q9  no zipper noise: the fader jumping -20 → 0 dB through our 20 ms ramp leaves ≤ -90 dBFS above 5 kHz
//   Q27 sample-accurate automation: 0 → -24 dB over one bar on a channel's fader, within 0.01 dB at every 1/16,
//       byte-identical at blocks 64 and 1024
//   Q28 block-size independence: the same song at blocks 64, 512 and 1024 is byte-identical
// The click instrument (engine/src/OurPlugins.h) writes one sample per note-on, so an onset is a non-zero sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readWav, highpass, peak, dB } from './quality/kit.mjs';   // peak() takes seconds
import { emptySong, writeSong } from '../src/song.mjs';

const REAL = [process.env.MFX_DAW_ENGINE, join(homedir(), '.cache/mortiflix/engine-build/mortiflix-engine_artefacts/Release/mortiflix-engine')].find((f) => f && existsSync(f));
const skip = !REAL && 'the engine is not built on this machine';
const RATE = 48000;
const BAR = 3840;   // ticks in a 4/4 bar at 960 per beat

// A song of click channels; `parts` is [{ at: tick, notes: { channelId: [{ t, len, key, vel }] } }].
// `inserts` gives a channel's mixer insert: { c2: { plugins: [...], delayMs } }.
function clickSong({ tempo, channels = ['c1'], parts, inserts = {} }) {
  const song = emptySong({ title: 'Timing', bpm: tempo[0].bpm });
  song.tempo = tempo;
  song.channels = channels.map((id, i) => ({ id, name: id, kind: 'instrument', midiChannel: i + 1, instrument: { kind: 'builtin', name: 'mfx-click' }, insert: `mx-${id}`, volDb: 0, pan: 0 }));
  song.mixer.inserts = channels.map((id, i) => ({ id: `mx-${id}`, n: i + 1, name: id, plugins: [], volDb: 0, pan: 0, out: 'master', ...inserts[id] }));
  song.patterns = parts.map((p, i) => ({ id: `m${i}`, name: `m${i}`, bars: 1, notes: p.notes }));
  song.playlist.items = parts.map((p, i) => ({ id: `i${i}`, kind: 'pattern', ref: `m${i}`, track: 'r1', at: { tick: p.at }, len: BAR }));
  return song;
}

function render(t, song, settings) {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-timing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'song.json'), writeSong(song));
  writeFileSync(join(dir, 'render.json'), JSON.stringify(settings));
  const r = spawnSync(REAL, ['--render', join(dir, 'song.json'), '--settings', join(dir, 'render.json'), '--out', join(dir, 'out')], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, r.stderr.slice(-500));
  const file = join(dir, 'out', 'mix-f32.wav');
  return { wav: readWav(file), sha: createHash('sha256').update(readFileSync(file)).digest('hex'), report: JSON.parse(readFileSync(join(dir, 'out', 'render-report.json'), 'utf8')) };
}

// A note exactly on a half sample goes to the later sample (as in the engine).
const sampleAt = (sec) => Math.round(sec * RATE + 1e-6);
const clicksIn = (wav) => { const c = wav.channels[0]; const out = []; for (let i = 0; i < c.length; i++) if (c[i] !== 0) out.push(i); return out; };

// Seconds at a tick, from the tempo map (jumps only), in double; the test's own sums.
function secondsAt(tempo, tick) {
  let sec = 0;
  for (let i = 0; i < tempo.length; i++) {
    const end = i + 1 < tempo.length ? Math.min(tick, tempo[i + 1].tick) : tick;
    if (end <= tempo[i].tick) break;
    sec += ((end - tempo[i].tick) / 960) * (60 / tempo[i].bpm);
  }
  return sec;
}

test('Q6: 1/32 notes with a 7-tick swing at 97 BPM land on their own samples, the same at blocks 64 and 1024', { skip }, (t) => {
  const tempo = [{ tick: 0, bpm: 97, shape: 'jump' }];
  const notes = [];
  for (let k = 0; k < 64; k++) notes.push({ t: k * 120 + (k % 2 ? 7 : 0), len: 60, key: 60, vel: 1 });
  const song = clickSong({ tempo, parts: [{ at: 0, notes: { c1: notes.slice(0, 32) } }, { at: BAR, notes: { c1: notes.slice(32).map((n) => ({ ...n, t: n.t - BAR })) } }] });
  const want = notes.map((n) => sampleAt(secondsAt(tempo, n.t)));
  const a = render(t, song, { blockSize: 64 });
  const b = render(t, song, { blockSize: 1024 });
  assert.deepEqual(clicksIn(a.wav), want, 'block 64: every click on its sample');
  assert.deepEqual(clicksIn(b.wav), want, 'block 1024: every click on its sample');
  assert.equal(a.sha, b.sha, 'byte-identical at 64 and 1024');
});

test('Q2: a 2-hour song, tempo change at bar 500: bar 3000\'s notes land on the samples worked out here', { skip }, (t) => {
  const tempo = [{ tick: 0, bpm: 120, shape: 'jump' }, { tick: 499 * BAR, bpm: 89, shape: 'jump' }];
  const at = 2999 * BAR;   // bar 3000
  const song = clickSong({ tempo, parts: [{ at: 0, notes: { c1: [{ t: 0, len: 60, key: 60, vel: 1 }] } },
    { at, notes: { c1: [{ t: 0, len: 60, key: 60, vel: 1 }, { t: 487, len: 60, key: 60, vel: 1 }, { t: 2887, len: 60, key: 60, vel: 1 }] } }] });
  const want = [0, 487, 2887].map((dt) => sampleAt(secondsAt(tempo, at + dt)));
  assert.ok(want[0] > 2 * 3600 * RATE, `${want[0] / RATE} s: past two hours`);
  const from = want[0] - 4800;
  const { wav, report } = render(t, song, { fromSample: from, toSample: want[2] + 4800 });
  assert.equal(report.settings.fromSample, from);
  assert.deepEqual(clicksIn(wav).map((i) => i + from), want);
});

test('Q28: an internal-only song (4OSC parts and clicks) at blocks 64, 512 and 1024 is byte-identical', { skip }, (t) => {
  const fx = join(import.meta.dirname, 'fixtures', 'songs', 'four');
  return import('../src/song-import.mjs').then(({ songFromNotes: fromNotes }) => {
    const { song } = fromNotes({ blueprint: JSON.parse(readFileSync(join(fx, 'blueprint.json'), 'utf8')), notes: JSON.parse(readFileSync(join(fx, 'notes.json'), 'utf8')), instruments: null });
    song.channels.push({ id: 'clk', name: 'Click', kind: 'instrument', midiChannel: 16, instrument: { kind: 'builtin', name: 'mfx-click' }, volDb: -12, pan: 0.3 });
    song.patterns[0].notes.clk = Array.from({ length: 48 }, (_, k) => ({ t: k * 80 + (k % 3), len: 40, key: 60, vel: 0.5 }));
    const shas = [64, 512, 1024].map((blockSize) => render(t, song, { blockSize }).sha);
    assert.equal(new Set(shas).size, 1, `renders differ: ${shas.map((s) => s.slice(0, 8)).join(' ')}`);
  });
});

const delay = (o) => ({ kind: 'builtin', name: 'mfx-delay', ...o });
const beats = (n, vel = 1) => Array.from({ length: n }, (_, k) => ({ t: 960 + k * 700 + 13, len: 60, key: 60, vel }));

test('Q7: a plugin that delays 512 samples and reports it, beside a dry copy turned upside down, nulls to silence', { skip }, (t) => {
  const tempo = [{ tick: 0, bpm: 97, shape: 'jump' }];
  const parts = [{ at: 0, notes: { a: beats(4), b: beats(4) } }];
  const song = (report) => clickSong({ tempo, channels: ['a', 'b'], parts, inserts: { a: { plugins: [delay({ delaySamples: 512, reportSamples: report })] }, b: { plugins: [delay({ gain: -1 })] } } });
  const want = beats(4).map((n) => sampleAt(secondsAt(tempo, n.t)));
  // the test can fail: without the report, the delayed copy doesn't line up
  const unreported = clicksIn(render(t, song(0), {}).wav);
  assert.deepEqual(unreported, [...want, ...want.map((s) => s + 512)].sort((x, y) => x - y), 'unreported: dry clicks, then the delayed ones 512 later');
  const { wav } = render(t, song(512), {});
  assert.deepEqual(clicksIn(wav), [], 'compensated: every sample is 0');
  // and the delayed channel alone still plays on the song's own samples (the render takes the latency out)
  const alone = clickSong({ tempo, channels: ['a'], parts: [{ at: 0, notes: { a: beats(4) } }], inserts: { a: { plugins: [delay({ delaySamples: 512, reportSamples: 512 })] } } });
  assert.deepEqual(clicksIn(render(t, alone, {}).wav), want);
});

test('Q8: track delay +10 ms puts a channel 480 samples after the others, -10 ms 480 before', { skip }, (t) => {
  const tempo = [{ tick: 0, bpm: 97, shape: 'jump' }];
  const parts = [{ at: 0, notes: { ref: beats(4, 1), moved: beats(4, 0.5) } }];
  const want = beats(4).map((n) => sampleAt(secondsAt(tempo, n.t)));
  for (const [ms, shift] of [[10, 480], [-10, -480]]) {
    const { wav } = render(t, clickSong({ tempo, channels: ['ref', 'moved'], parts, inserts: { moved: { delayMs: ms } } }), {});
    const c = wav.channels[0];
    const loud = clicksIn(wav).filter((i) => c[i] > 0.5);
    const soft = clicksIn(wav).filter((i) => c[i] < 0.5);
    assert.deepEqual(loud, want, `${ms} ms: the other channel stays on the song's samples`);
    assert.deepEqual(soft.map((s, k) => s - loud[k]), [shift, shift, shift, shift], `${ms} ms`);
  }
});

test('Q9: the fader jumping -20 → 0 dB: with our ramp ≤ -90 dBFS above 5 kHz; without it, far above (the test can catch it)', { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-ramp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(REAL, ['--ramp-test', dir], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const jump = 24120;
  const residual = (f) => peak(highpass(readWav(join(dir, f)), { hz: 5000, order: 8 }), (jump - 2400) / RATE, (jump + 4800) / RATE).db;
  const unramped = residual('unramped.wav');
  const ramped = residual('ramped.wav');
  assert.ok(unramped > -60, `unramped: ${unramped.toFixed(1)} dBFS`);
  assert.ok(ramped <= -90, `ramped: ${ramped.toFixed(1)} dBFS`);
  // and the ramp ends where it should: 0 dB 20 ms after the jump (0.5 × 0.7071 at the sine's peak)
  const w = readWav(join(dir, 'ramped.wav'));
  assert.ok(Math.abs(w.channels[0][jump + 960 + 480 * 2] - 0.5 * Math.SQRT1_2) < 1e-6);
});

test('Q27: a fader automated 0 → -24 dB over one bar follows the line within 0.01 dB at every 1/16, the same at blocks 64 and 1024', { skip }, (t) => {
  const tempo = [{ tick: 0, bpm: 97, shape: 'jump' }];
  const song = emptySong({ title: 'Automation', bpm: 97 });
  song.channels = [{ id: 'dc', name: 'DC', kind: 'instrument', midiChannel: 1, instrument: { kind: 'builtin', name: 'mfx-dc', level: 0.5 }, insert: 'mx-dc', volDb: 0, pan: 0 }];
  song.mixer.inserts = [{ id: 'mx-dc', n: 1, name: 'DC', plugins: [], volDb: 0, pan: 0, out: 'master' }];
  song.automation = [{ id: 'au1', name: 'Fade', scope: 'song', points: [{ tick: 0, v: 1, shape: 'single' }, { tick: BAR, v: 0, shape: 'hold' }],
    links: [{ target: { insert: 'mx-dc', param: 'volDb' }, min: -24, max: 0, curve: 0, smoothMs: 0 }] }];
  song.playlist.items = [{ id: 'i1', kind: 'automation', ref: 'au1', track: 'r1', at: { tick: BAR }, len: BAR }];
  const s0 = secondsAt(tempo, BAR) * RATE, s1 = secondsAt(tempo, 2 * BAR) * RATE;
  const end = Math.round(secondsAt(tempo, 3 * BAR) * RATE);
  const a = render(t, song, { blockSize: 64, toSample: end });
  const b = render(t, song, { blockSize: 1024, toSample: end });
  assert.equal(a.sha, b.sha, 'byte-identical at 64 and 1024');
  const want = (s) => (s < s0 ? 0 : s >= s1 ? -24 : -24 * (s - s0) / (s1 - s0));
  const out = a.wav.channels[0];
  for (let k = 0; k < 48; k++) {
    const s = Math.round(secondsAt(tempo, k * 240) * RATE);   // every 1/16 for three bars
    const got = dB(out[s] / (0.5 * Math.SQRT1_2));
    assert.ok(Math.abs(got - want(s)) <= 0.01, `1/16 #${k} (sample ${s}): ${got.toFixed(4)} dB, want ${want(s).toFixed(4)}`);
  }
});
