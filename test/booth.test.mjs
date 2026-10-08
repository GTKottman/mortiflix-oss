// The recording booth: the shared core (takes, keeping, checks, imports), the web API, the session side (vo.mjs with
// the owner's own voice) and the terminal booth's microphone setup. Takes are generated tones; no microphone needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ipcPath } from '../src/platform.mjs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { REPO } from '../src/studio.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import * as booth from '../src/booth.mjs';
import { captureInput } from '../src/record.mjs';
import { startServer } from '../src/web/server.mjs';
import { run as cli } from '../src/cli.mjs';

const VO = join(REPO, 'pipelines/_shared/skills/voiceover/vo.mjs');

// A mono 16-bit WAV: a sine at `amp` (0..1) for `seconds`.
function tone(seconds, amp = 0.3, rate = 48000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amp * 32767), 44 + i * 2);
  return buf;
}

const LINES = [
  { id: 'b01-1', text: '[warm, unhurried] Every city has a heartbeat.', script: 'Every city has a heartbeat.', gap_after: 0.5 },
  { id: 'b01-2', text: 'Ours runs on bicycles.' },
];

function projectWithScript(t, lines = LINES) {
  const root = tempStudio(t);
  const { id } = createProject(root, { pipeline: 'logo-sting', title: 'Booth test' });
  const voice = join(projectPaths(root, id).work, 'voice');
  mkdirSync(voice, { recursive: true });
  writeFileSync(join(voice, 'lines.json'), JSON.stringify(lines));
  return { root, id, voice };
}

test('booth: the script as the reader sees it, takes, checks and keeping', (t) => {
  const { root, id, voice } = projectWithScript(t);
  const lines = booth.readLines(root, id);
  assert.deepEqual(lines.map((l) => [l.id, l.script, l.direction]), [['b01-1', 'Every city has a heartbeat.', 'warm, unhurried'], ['b01-2', 'Ours runs on bicycles.', null]]);
  assert.ok(lines[0].est_seconds >= 1);

  // Measured and checked: a quiet take, a clipped one, a good one.
  const quiet = booth.addTake(root, id, 'b01-1', tone(1.5, 0.01));
  assert.equal(quiet.take_no, 1);
  assert.ok(quiet.flags.includes('quiet'));
  const hot = booth.addTake(root, id, 'b01-1', tone(1.5, 1));
  assert.ok(hot.flags.includes('clipped'));
  const good = booth.addTake(root, id, 'b01-1', tone(1.8, 0.4));
  assert.deepEqual(good.flags, []);
  assert.equal(good.take_no, 3);
  assert.equal(good.duration_ms, 1800);

  assert.deepEqual(booth.boothStatus(root, id).missing, ['b01-1', 'b01-2']);
  booth.keepTake(root, id, 'b01-1', 3);
  // The kept take is where vo.mjs looks for a line, with the same report shape.
  assert.ok(existsSync(join(voice, 'clips', 'b01-1.wav')));
  const rep = JSON.parse(readFileSync(join(voice, 'clips', 'b01-1.json'), 'utf8'));
  assert.equal(rep.engine, 'own voice');
  assert.equal(rep.take, 3);
  assert.equal(rep.script, 'Every city has a heartbeat.');
  const st = booth.boothStatus(root, id);
  assert.equal(st.kept, 1);
  assert.deepEqual(st.missing, ['b01-2']);

  // Keeping another take moves the mark; only one take per line is kept.
  booth.keepTake(root, id, 'b01-1', 1);
  assert.deepEqual(booth.boothStatus(root, id).takes.filter((x) => x.kept).map((x) => x.take_no), [1]);

  // If the session rewrites a line, its old take no longer counts.
  writeFileSync(join(voice, 'lines.json'), JSON.stringify([{ ...LINES[0], script: 'Every town has a heartbeat.' }, LINES[1]]));
  assert.deepEqual(booth.boothStatus(root, id).missing, ['b01-1', 'b01-2']);

  // Bad input is refused with a reason.
  assert.throws(() => booth.addTake(root, id, 'b01-1', Buffer.from('not audio at all, really not')), /WAV/);
  assert.throws(() => booth.addTake(root, id, 'nope', tone(1)), /no line/);
  assert.throws(() => booth.addTake(root, id, 'b01-2', tone(0.05)), /fifth of a second/);
});

test('booth: importing files recorded elsewhere keeps one take per line', (t) => {
  const { root, id } = projectWithScript(t);
  const dir = join(tmpdir(), `mfx-import-${randomBytes(3).toString('hex')}`);
  mkdirSync(dir);
  t.after(() => spawnSync('rm', ['-rf', dir]));
  writeFileSync(join(dir, 'b01-2.wav'), tone(1.2));
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  const r = booth.importFolder(root, id, dir);
  assert.deepEqual(r.imported.map((x) => x.line), ['b01-2']);
  assert.deepEqual(r.missing, ['b01-1']);
  assert.deepEqual(booth.boothStatus(root, id).missing, ['b01-1']);
  assert.equal(booth.boothStatus(root, id).takes[0].source, 'import');
});

test('booth: `mortiflix record --import` from the command line', async (t) => {
  const { root, id } = projectWithScript(t);
  const dir = join(tmpdir(), `mfx-import-${randomBytes(3).toString('hex')}`);
  mkdirSync(dir);
  t.after(() => spawnSync('rm', ['-rf', dir]));
  for (const l of LINES) writeFileSync(join(dir, `${l.id}.wav`), tone(1.5));
  const log = [];
  const orig = console.log;
  console.log = (...a) => log.push(a.join(' '));
  try { await cli(['record', id, '--import', dir, '--studio', root]); } finally { console.log = orig; }
  assert.deepEqual(booth.boothStatus(root, id).missing, []);
  assert.match(log.join('\n'), /Every line has a kept take/);
});

test('booth: the terminal booth records from each platform\'s microphone', () => {
  assert.deepEqual(captureInput('linux'), ['-f', 'pulse', '-i', 'default']);
  assert.deepEqual(captureInput('darwin'), ['-f', 'avfoundation', '-i', ':0']);
  assert.equal(captureInput('win32'), null); // DirectShow needs a device name
  assert.deepEqual(captureInput('win32', 'Microphone (USB)'), ['-f', 'dshow', '-i', 'audio=Microphone (USB)']);
  assert.deepEqual(captureInput('darwin', '2'), ['-f', 'avfoundation', '-i', ':2']);
  assert.deepEqual(captureInput('linux', 'alsa:hw:1'), ['-f', 'alsa', '-i', 'hw:1']);
});

function call(socketPath, method, path, { body, raw } = {}) {
  return new Promise((ok, fail) => {
    const data = raw ?? (body !== undefined ? JSON.stringify(body) : null);
    const req = request({ socketPath, method, path, headers: { host: 'localhost', ...(method !== 'GET' ? { 'x-mortiflix': '1' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch { /* audio */ }
        ok({ status: res.statusCode, headers: res.headers, json, buf });
      });
    });
    req.on('error', fail);
    req.end(data);
  });
}

test('booth: the web API records, keeps, plays back and hands over', async (t) => {
  const { root, id } = projectWithScript(t);
  const socketPath = ipcPath(`mfx-booth-${randomBytes(4).toString('hex')}`, { tmp: tmpdir() });
  const srv = await startServer(root, { socketPath, quiet: true });
  t.after(() => srv.close());
  const s = (...a) => call(socketPath, ...a);

  const view = (await s('GET', `/api/projects/${id}/booth`)).json;
  assert.equal(view.lines.length, 2);
  assert.equal(view.lines[0].direction, 'warm, unhurried');
  assert.ok(view.advice.clipped);

  const up = await s('POST', `/api/projects/${id}/booth/lines/b01-1/takes`, { raw: tone(1.4) });
  assert.equal(up.status, 200);
  assert.equal(up.json.take.take_no, 1);
  assert.equal((await s('POST', `/api/projects/${id}/booth/lines/b01-1/takes`, { raw: Buffer.from('nope') })).status, 400);

  const audio = await s('GET', `/api/projects/${id}/booth/lines/b01-1/takes/1/audio`);
  assert.equal(audio.headers['content-type'], 'audio/wav');
  assert.equal(audio.buf.toString('ascii', 0, 4), 'RIFF');

  assert.equal((await s('POST', `/api/projects/${id}/booth/lines/b01-1/takes/1/keep`)).status, 200);
  const early = await s('POST', `/api/projects/${id}/booth/done`);
  assert.equal(early.status, 409);
  assert.deepEqual(early.json.missing, ['b01-2']);

  await s('POST', `/api/projects/${id}/booth/lines/b01-2/takes`, { raw: tone(1.2) });
  await s('POST', `/api/projects/${id}/booth/lines/b01-2/takes/1/keep`);
  const done = await s('POST', `/api/projects/${id}/booth/done`);
  assert.equal(done.status, 200);
  assert.equal(done.json.resumed, false); // a draft isn't waiting on the recording

  // Writes still need the X-Mortiflix header.
  const csrf = await new Promise((ok) => {
    const req = request({ socketPath, method: 'POST', path: `/api/projects/${id}/booth/done`, headers: { host: 'localhost' } }, (res) => { res.resume(); ok(res.statusCode); });
    req.end();
  });
  assert.equal(csrf, 403);
});

test('vo.mjs with the owner\'s own voice: asks for the recording, then builds from the kept takes', (t) => {
  const { root, id, voice } = projectWithScript(t);
  const work = projectPaths(root, id).work;
  const env = { ...process.env, MFX_VOICE: JSON.stringify({ engine: 'own' }), MFX_PROJECT: id };
  const vo = (...args) => spawnSync('node', [VO, ...args], { cwd: work, env, encoding: 'utf8' });

  const before = vo('speak', 'voice/lines.json');
  assert.equal(before.status, 1);
  assert.match(before.stdout, /2 still need the owner's voice: b01-1, b01-2/);
  assert.match(before.stdout, new RegExp(`mfx needs-you ".*mortiflix record ${id}`));

  for (const l of LINES) booth.keepTake(root, id, l.id, booth.addTake(root, id, l.id, tone(1.5)).take_no);
  const after = vo('speak', 'voice/lines.json');
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /2\/2 lines recorded/);

  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('no ffmpeg for build');
  const built = vo('build', 'voice/lines.json');
  assert.equal(built.status, 0, built.stderr);
  const timing = JSON.parse(readFileSync(join(voice, 'timing.json'), 'utf8'));
  assert.equal(timing.lines.length, 2);
  assert.equal(timing.lines[0].timing, 'line');
  assert.ok(Math.abs(timing.lines[1].start - 2.0) < 0.05); // 1.5 s take + 0.5 s gap
});
