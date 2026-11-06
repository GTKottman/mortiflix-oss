// A scripted session over stdio, the way the app talks to the service: the service's own runner does the work (demo
// backend), the app only sends requests and reads replies and events. MFX_TRANSCRIPT=<file> keeps every line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempStudio } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/mortiflix-service.mjs', import.meta.url));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function service(root) {
  const p = spawn(process.execPath, [BIN], { env: { ...process.env, MORTIFLIX_STUDIO: root, MFX_SERVICE_NO_RUNNER: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = process.env.MFX_TRANSCRIPT || null;
  if (log) writeFileSync(log, '');
  const seen = [];
  const waiters = [];
  let buf = '';
  let next = 1;
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; });
  p.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (log) appendFileSync(log, `< ${line}\n`);
      const m = JSON.parse(line);
      seen.push(m);
      for (const w of [...waiters]) if (w.fn(m)) { waiters.splice(waiters.indexOf(w), 1); w.ok(m); }
    }
  });
  const wait = (fn, ms = 60_000, what = 'a message') => {
    const old = seen.find(fn);
    if (old) return Promise.resolve(old);
    return new Promise((ok, fail) => {
      const w = { fn, ok: (m) => { clearTimeout(t); ok(m); } };
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`timed out waiting for ${what}; stderr: ${stderr.slice(-1500)}`)); }, ms);
      waiters.push(w);
    });
  };
  const request = async (type, params = {}) => {
    const id = next++;
    const line = JSON.stringify({ id, type, params });
    if (log) appendFileSync(log, `> ${line}\n`);
    p.stdin.write(line + '\n');
    const r = await wait((m) => m.id === id, 60_000, `the reply to ${type}`);
    if (!r.ok) throw new Error(`${type}: ${r.error.code}: ${r.error.message}`);
    return r.result;
  };
  const exit = new Promise((ok) => p.on('exit', (code) => ok(code)));
  return { p, request, wait, seen, exit, end: () => p.stdin.end(), stderr: () => stderr };
}

test('stdio: the app\'s whole path on the demo backend, each stage made once the one before it passes its gate', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 180_000 }, async (t) => {
  const root = tempStudio(t);
  const s = service(root);
  t.after(() => { try { s.p.kill(); } catch { /* gone */ } });
  const hello = await s.request('hello', { client: 'test', protocol: 1 });
  assert.equal(hello.runner, true, hello.runner_note);
  for (const type of ['project.new', 'graph.get', 'preview.plan', 'voicemusic.view', 'handoff.plan', 'render.add', 'export.done', 'setup.status', 'presets.save', 'assets.add', 'music.theme.samples', 'chat.send']) assert.ok(hello.types.includes(type), type);
  assert.ok((await s.request('presets.list')).built_in.some((p) => p.slug === 'explainer'));

  const { project } = await s.request('project.new', { preset: 'explainer', title: 'Stdio', idea: 'How a bill becomes law', backend: 'demo' });
  await s.request('look.brief.set', { vibe: 'calm', font: 'Inter' });
  await s.request('motion.brief.set', {});
  await s.request('transition.brief.set', {});
  // The brief's questions wait for the owner; the script starts once every one is answered.
  const asked = await s.wait((m) => m.event === 'chat.message' && m.data.card?.waiting, 60_000, 'the brief questions');
  for (const q of asked.data.card.questions) await s.request('chat.answer', { question: q.id, value: q.default });
  // The runner makes the script, then waits at its gate; Next on each stage lets the next one be made.
  await s.wait((m) => m.event === 'chat.message' && /ready in the Mortiflix Script box/.test(m.data.text), 60_000, 'the script message');
  for (const from of [0, 1, 2, 3]) {
    const key = ['voice', 'styleFrames', 'transitions', 'animatic'][from];
    await s.request('stage.set', { stage: from + 1, from, done: true });
    await s.wait((m) => m.event === 'status' && m.data.project === project.id && ['ready', 'needsYou'].includes(m.data.stages[from + 1].kind), 60_000, key);
  }
  const shots = await s.wait((m) => m.event === 'status' && m.data.project === project.id && m.data.stages[4].total >= 4 && m.data.stages[1].total >= 4, 60_000, 'shots and lines');
  assert.equal(shots.data.stages.length, 8);
  const g = await s.request('graph.get');
  assert.deepEqual(g.order.film, ['s01', 's02', 's03', 's04']);
  assert.equal((await s.request('preview.plan')).shots.length, 4);

  await s.request('node.edit', { node: 's02', action: 'fix', text: 'make it red' });
  await s.wait((m) => m.event === 'node.changed' && m.data.nodes.some((n) => n.id === 's02' && n.current === 2), 60_000, 's02 v2');
  await s.wait((m) => m.event === 'chat.message' && /S02 is remade/.test(m.data.text), 10_000, 'the remade line in the chat');

  await s.request('stage.set', { stage: 5, from: 4, done: true });
  await s.wait((m) => m.event === 'status' && m.data.project === project.id && m.data.stages[5].total >= 4, 60_000, 'the music cues');
  const handover = await s.request('stage.set', { stage: 6, from: 5, done: true });
  assert.deepEqual(handover.handover.skipped, ['build', 'final']);
  const plan = await s.request('handoff.plan');
  assert.equal(plan.clips.filter((c) => c.kind === 'shot').length, 4);
  await s.request('handoff.done', { map: { clips: plan.clips.filter((c) => c.track).map((c, i) => ({ node: c.node, version: c.version, clip: i + 1 })) } });

  const job = await s.request('render.add', { label: 'YouTube 1080p' });
  await s.request('render.progress', { id: job.id, done: 1, total: 2 });
  const file = join(root, 'render.mp4');
  writeFileSync(file, 'x');
  await s.request('render.finish', { id: job.id, ok: true, file });
  await s.wait((m) => m.event === 'render.job' && m.data.id === job.id && m.data.state === 'done', 5000, 'the render event');
  await s.request('export.done', { file, preset: 'YouTube 1080p' });
  await s.wait((m) => m.event === 'project.changed' && m.data.state === 'delivered', 10_000, 'delivered');

  s.end();
  assert.equal(await s.exit, 0);
  // Nothing but protocol lines on stdout (every line parsed as JSON above).
  assert.ok(s.seen.every((m) => ('id' in m && 'ok' in m) || ('event' in m && 'data' in m)));
});
