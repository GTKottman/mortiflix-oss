// final.status / final.make / final.cancel: tiny ffmpeg-generated media, the real render queue (an ffmpeg child, no Chrome).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { projectPaths } from '../src/projects.mjs';

const ff = (...a) => spawnSync('ffmpeg', ['-y', '-v', 'error', ...a]);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function setup(t) {
  const root = tempStudio(t);
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    const r = out.find((m) => m.id === id);
    if (!r.ok) throw new Error(`${type}: ${r.error.code}: ${r.error.message}`);
    return r.result;
  };
  const made = await call('project.new', { preset: 'explainer', title: 'Bikes', idea: 'x', backend: 'demo', start: false });
  const id = made.project?.id || made.id;
  return { root, call, id, work: projectPaths(root, id).work };
}
const until = async (fn, ms = 60_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(100); } };

test('final.*: none -> make (animatic + mix) -> done -> stale -> cancel', async (t) => {
  const { call, id, work } = await setup(t);
  assert.equal((await call('final.status')).state, 'none');
  mkdirSync(join(work, 'out', 'sound'), { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=2', '-pix_fmt', 'yuv420p', join(work, 'out', 'animatic.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', join(work, 'out', 'sound', 'final-mix.wav'));
  const m = await call('final.make');
  assert.ok(m.job > 0);
  assert.equal((await call('final.status')).state, 'rendering');
  const done = await until(async () => { const s = await call('final.status'); return s.state === 'done' && s; });
  assert.ok(done.file.startsWith(work) && existsSync(done.file));
  assert.ok(done.size > 0 && done.length_sec > 1.5 && done.made_at);
  assert.ok(!existsSync(done.file.replace('final.mp4', 'final.part.mp4')));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', done.file], { encoding: 'utf8' }).stdout;
  assert.match(probe, /video/); assert.match(probe, /audio/);
  // an input newer than the file -> stale
  const later = new Date(Date.now() + 5000);
  utimesSync(join(work, 'out', 'sound', 'final-mix.wav'), later, later);
  assert.equal((await call('final.status')).state, 'stale');
  // cancel a running make
  assert.deepEqual(await call('final.cancel'), { cancelled: false });
  await call('final.make');
  const c = await call('final.cancel');
  assert.equal(c.cancelled, true);
  await until(async () => (await call('render.list')).every((j) => !['waiting', 'running'].includes(j.state)));
  assert.notEqual((await call('final.status')).state, 'rendering');
});

test('final.make without any shots says what is missing', async (t) => {
  const { call } = await setup(t);
  await assert.rejects(call('final.make'), /make the shots first/);
});
