// The web server over a Unix socket (no network port is opened by the tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ipcPath } from '../src/platform.mjs';
import { randomBytes } from 'node:crypto';
import { tempStudio } from './helpers.mjs';
import { startServer } from '../src/web/server.mjs';

function call(socketPath, method, path, { body, raw, headers = {} } = {}) {
  return new Promise((ok, fail) => {
    const data = raw ?? (body !== undefined ? JSON.stringify(body) : null);
    const req = request({ socketPath, method, path, headers: { host: 'localhost', ...(method !== 'GET' ? { 'x-mortiflix': '1' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
        ok({ status: res.statusCode, headers: res.headers, json, buf });
      });
    });
    req.on('error', fail);
    req.end(data);
  });
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('web: create, upload, start, review, media and the guards', async (t) => {
  const root = tempStudio(t);
  const socketPath = ipcPath(`mfx-web-${randomBytes(4).toString('hex')}`, { tmp: tmpdir() });
  const srv = await startServer(root, { socketPath, quiet: true });
  t.after(() => srv.close());
  const s = (...a) => call(socketPath, ...a);

  const studio = await s('GET', '/api/studio');
  assert.equal(studio.json.config.backend, 'demo');
  assert.equal(studio.json.api_key_set, false);

  // Writes need the X-Mortiflix header (CSRF).
  const csrf = await call(socketPath, 'POST', '/api/projects', { body: {}, headers: { 'x-mortiflix': '' } });
  assert.equal(csrf.status, 403);

  const created = await s('POST', '/api/projects', { body: { pipeline: 'logo-sting', title: 'Web sting', answers: { mood: 'bold' } } });
  const id = created.json.id;
  assert.equal((await s('POST', `/api/projects/${id}/start`)).status, 400); // the logo is required
  const up = await s('POST', `/api/projects/${id}/files?field=logo&name=../../evil.svg`, { raw: '<svg/>' });
  assert.equal(up.json.path, 'input/logo/evil.svg');
  assert.equal((await s('POST', `/api/projects/${id}/start`)).status, 200);

  // The runner inside the server picks it up (demo backend) and stops at the first gate.
  const detail = await until(async () => { const d = (await s('GET', `/api/projects/${id}`)).json; return d.project.state === 'waiting' ? d : null; });
  const sub = detail.submissions[0];
  assert.equal(sub.step, 'directions');

  // Media: served from the record, with range support, a sandboxing CSP, and no way out of the folder.
  const file = sub.items[0].file;
  const media = await s('GET', `/files/${id}/${file}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(media.status, 206);
  assert.equal(media.buf.length, 10);
  assert.match(media.headers['content-security-policy'], /sandbox/);
  assert.equal(media.headers['content-type'], 'image/svg+xml');
  const dl = await s('GET', `/files/${id}/${file}?download`);
  assert.match(dl.headers['content-disposition'], /attachment; filename="Web sting - sf01.svg"/);
  assert.equal((await s('GET', `/files/${id}/reviews/../project.json`)).status, 404);
  assert.equal((await s('GET', `/files/${id}/reviews/..%2Fproject.json`)).status, 404);
  assert.equal((await s('GET', '/../package.json')).status, 404);

  // Review through the API: changes with a pinned note, then the next version arrives answering it.
  const bad = await s('POST', `/api/projects/${id}/reviews/directions/1`, { body: { verdict: 'changes' } });
  assert.equal(bad.status, 400);
  await s('POST', `/api/projects/${id}/reviews/directions/1`, { body: { verdict: 'changes', notes: [{ item: 0, x: 0.4, y: 0.5, text: 'more orange' }] } });
  const v2 = await until(async () => { const d = (await s('GET', `/api/projects/${id}`)).json; return d.submissions.find((x) => x.version === 2); });
  assert.equal(v2.pin_changes[0].note, 1);

  // Settings: the API key is stored but never returned.
  const saved = await s('PUT', '/api/config', { body: { backend: 'demo', effort: 'xhigh', api_key: 'sk-ant-test-123' } });
  assert.equal(saved.json.api_key_set, true);
  assert.ok(!JSON.stringify(saved.json).includes('sk-ant-test-123'));
  assert.equal((await s('PUT', '/api/config', { body: { effort: 'turbo' } })).status, 400);

  const app = await s('GET', '/');
  assert.match(app.buf.toString(), /Mortiflix Studio/);
  assert.match(app.headers['content-security-policy'], /default-src 'self'/);
});

test('web: the Music panel hands over the MIDI pack and takes the owner\'s master (resuming a project waiting for it)', async (t) => {
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { createProject, startProject, projectPaths } = await import('../src/projects.mjs');
  const gates = await import('../src/gates.mjs');
  const root = tempStudio(t);
  const socketPath = ipcPath(`mfx-web-${randomBytes(4).toString('hex')}`, { tmp: tmpdir() });
  const srv = await startServer(root, { socketPath, quiet: true, runner: false });
  t.after(() => srv.close());
  const s = (...a) => call(socketPath, ...a);
  const { id } = createProject(root, { pipeline: 'explainer', title: 'Cue', answers: { topic: 'x', music: 'Original score: I finish it from the MIDI (recommended)' } });
  startProject(root, id);
  assert.equal((await s('GET', `/api/projects/${id}/music`)).json.expect, null);
  assert.equal((await s('GET', `/api/projects/${id}/music/midi.zip`)).status, 400);

  const w = projectPaths(root, id).work;
  mkdirSync(join(w, 'music'), { recursive: true }); mkdirSync(join(w, 'out/music/midi'), { recursive: true });
  writeFileSync(join(w, 'music/blueprint.json'), JSON.stringify({ title: 'Cue', bpm: 120, meter: '4/4', bars: 2 }));
  writeFileSync(join(w, 'out/music/midi/01-bass.mid'), 'MThd');
  const st = (await s('GET', `/api/projects/${id}/music`)).json;
  assert.equal(st.finish, 'own'); assert.deepEqual(st.midi, ['01-bass.mid']); assert.equal(st.expect.seconds, 4);
  const zip = await s('GET', `/api/projects/${id}/music/midi.zip`);
  assert.equal(zip.status, 200); assert.equal(zip.headers['content-type'], 'application/zip'); assert.match(zip.headers['content-disposition'], /Cue - MIDI\.zip/);

  gates.needsYou(root, id, 'Import your master');
  const wav = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4.5', '-f', 'wav', '-'], { maxBuffer: 1 << 24 }).stdout;
  const short = await s('POST', `/api/projects/${id}/music/master?name=take.wav`, { raw: wav.subarray(0, 44 + 48000) });
  assert.equal(short.status, 422); assert.match(short.json.error, /score runs 4.00 s/);
  const ok = await s('POST', `/api/projects/${id}/music/master?name=take.wav`, { raw: wav });
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.resumed, true);
  assert.ok(existsSync(join(w, 'music/own-master/master.wav')));
  const audio = await s('GET', `/api/projects/${id}/music/master`);
  assert.equal(audio.headers['content-type'], 'audio/wav');
  assert.equal((await s('POST', `/api/projects/${id}/music/master`, { raw: wav, headers: { 'x-mortiflix': '' } })).status, 403);
});
