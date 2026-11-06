// The beta driver's parts (tools/replay/beta-drive.mjs + drive/): the stdio JSON-lines client, the stuck-point
// recorder, the zero-spend check over a ledger, the replay-gap scan, and the child env. No service, no pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LineClient, clip } from '../tools/replay/drive/client.mjs';
import { StuckRecorder, spendCheck, replayGaps, markdown } from '../tools/replay/drive/report.mjs';
import { parseArgs, cleanEnv, checkFinal } from '../tools/replay/beta-drive.mjs';

// a fake service: answers each request line with `answer(msg)`
function fakeService(answer) {
  const toSvc = new PassThrough(), fromSvc = new PassThrough();
  let buf = '';
  toSvc.on('data', (c) => {
    buf += c; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      const r = answer(m); if (r !== undefined) fromSvc.write(r);
    }
  });
  return { c: new LineClient({ stdin: toSvc, stdout: fromSvc, timeoutMs: 200 }), fromSvc };
}

test('client: replies by id (split across chunks), errors, events, timeouts, soft calls', async () => {
  const { c, fromSvc } = fakeService((m) => {
    if (m.type === 'hello') { const s = JSON.stringify({ id: m.id, ok: true, result: { studio: '/x' } }) + '\n'; fromSvc.write(s.slice(0, 7)); return s.slice(7); }
    if (m.type === 'bad') return JSON.stringify({ id: m.id, ok: false, error: { code: 'bad_request', message: 'nope' } }) + '\n';
    if (m.type === 'ev') return 'not json\n' + JSON.stringify({ event: 'project.changed', data: { a: 1 } }) + '\n' + JSON.stringify({ id: m.id, ok: true, result: 1 }) + '\n';
    return undefined; // never answers
  });
  assert.deepEqual(await c.call('hello', { protocol: 1 }), { studio: '/x' });
  await assert.rejects(c.call('bad'), (e) => e.code === 'bad_request' && e.type === 'bad');
  const seen = []; const off = c.onEvent((e) => seen.push(e.event));
  assert.equal(await c.call('ev'), 1);
  off();
  assert.deepEqual(seen, ['project.changed']);
  assert.equal(c.badLines, 1);
  assert.equal(c.recent(1)[0].event, 'project.changed');
  const s = await c.soft('silent');
  assert.equal(s.ok, false); assert.equal(s.error.code, 'timeout');
  assert.deepEqual(c.errors.map((e) => e.type), ['bad', 'silent']);
  fromSvc.end();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(c.call('hello'), (e) => e.code === 'service_down');
});

test('stuck recorder keeps path, step, what it waited for, state, needs_you and the last events', () => {
  const s = new StuckRecorder('happy');
  const p = s.record({ step: 'voice', waitingFor: 'step voice in in_review', state: { state: 'paused' }, status: ['script:done'], needs_you: { cause: 'login' }, events: [{ event: 'x' }], note: 'timeout' });
  assert.equal(s.points.length, 1);
  assert.equal(p.path, 'happy'); assert.equal(p.step, 'voice'); assert.equal(p.needs_you.cause, 'login');
  assert.match(p.state, /paused/); assert.equal(p.last_events.length, 1);
  assert.ok(clip('x'.repeat(1000), 50).endsWith('...'));
});

test('spend check: only replay rows with zero cost pass; rows before the start byte are ignored', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-bd-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'usage-ledger.jsonl');
  writeFileSync(f, JSON.stringify({ provider: 'elevenlabs', credits: 900 }) + '\n'); // an old real row
  const start = statSync(f).size;
  appendFileSync(f, JSON.stringify({ provider: 'elevenlabs', replay: true, credits: 0 }) + '\n' + JSON.stringify({ provider: 'claude', replay: true, input_tokens: 0, output_tokens: 0 }) + '\n');
  let r = spendCheck(f, start);
  assert.equal(r.ok, true); assert.equal(r.rows, 2);
  assert.equal(spendCheck(f, 0).ok, false, 'the old real row fails from byte 0');
  appendFileSync(f, JSON.stringify({ provider: 'claude', replay: true, input_tokens: 12 }) + '\n' + JSON.stringify({ provider: 'elevenlabs', credits: 0 }) + '\n' + '{broken\n');
  r = spendCheck(f, start);
  assert.equal(r.ok, false);
  assert.equal(r.offenders.length, 3);
  assert.ok(r.offenders.some((o) => o.why.includes('input_tokens=12')));
  assert.ok(r.offenders.some((o) => o.why.includes('replay is not true')));
  assert.ok(r.offenders.some((o) => o.why.includes('unreadable ledger line')));
  assert.equal(spendCheck(join(dir, 'none.jsonl')).ok, true, 'no ledger = no spend');
});

test('replay gaps: claude-call, blocked-fetch and elevenlabs-unknown rows are listed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-bd-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'log.jsonl');
  writeFileSync(f, [{ kind: 'still' }, { kind: 'claude-call', role: 'x' }, { kind: 'blocked-fetch', url: 'https://a.b/c' }, { kind: 'elevenlabs-unknown', path: '/v1/x' }, { kind: 'fault' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const g = replayGaps(f);
  assert.equal(g.length, 3);
  assert.match(g[1], /blocked-fetch/);
  const md = markdown({ started: 't', pack: 'p', studio: 's', replay_gaps: g, paths: [{ path: 'happy', final: { ok: false }, steps: [], notes: ['n'], stuck: [{ step: 'voice', waitingFor: 'w', needs_you: null }], faults: [{ fault: 'login', step: 'script', surfaced: true, cause: 'login', text: 'x', how: 'project.resume', recovered: true }], protocol_errors: [], spend: { ok: true } }] });
  assert.match(md, /\| happy \| NO \|/); assert.match(md, /Replay gaps \(3\)/); assert.match(md, /login at script/); assert.match(md, /Stuck points: happy/);
});

test('args, a clean child env (no keys, no Claude Code vars) and the final check', () => {
  const o = parseArgs(['--path', 'all', '--timeout-min', '3']);
  assert.equal(o.path, 'all'); assert.equal(o.timeoutMin, 3);
  const e = cleanEnv({ PATH: '/bin', ELEVENLABS_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', UPLOAD_POST_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, '/s', '/p');
  assert.deepEqual(Object.keys(e).sort(), ['MFX_REPLAY', 'MORTIFLIX_STUDIO', 'PATH']);
  assert.equal(e.MFX_REPLAY, '/p');
  assert.equal(checkFinal('/nope/final.mp4').ok, false);
});
