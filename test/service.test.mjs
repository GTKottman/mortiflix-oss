// The stdio service the Mortiflix Studio app runs: hello, state, stages, chat, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempStudio } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/mortiflix-service.mjs', import.meta.url));

function talk(root, lines, wantReplies) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN], { env: { ...process.env, MORTIFLIX_STUDIO: root }, stdio: ['pipe', 'pipe', 'inherit'] });
    const got = [];
    let buf = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout: ${JSON.stringify(got)}`)); }, 10_000);
    p.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); }
      if (got.filter((m) => 'id' in m).length >= wantReplies) p.stdin.end();
    });
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, got }); });
    for (const l of lines) p.stdin.write(typeof l === 'string' ? l + '\n' : JSON.stringify(l) + '\n');
  });
}

test('service: hello, state.get, stage.set, chat.send and bad input over stdio', async (t) => {
  const root = tempStudio(t);
  const { code, got } = await talk(root, [
    { id: 0, type: 'hello', params: { client: 'test', protocol: 1 } },
    { id: 1, type: 'state.get', params: {} },
    { id: 2, type: 'stage.set', params: { stage: 2, from: 0, done: true } },
    { id: 3, type: 'chat.send', params: { text: 'make it blue' } },
    { id: 4, type: 'node.list', params: {} },
    { id: 5, type: 'nope' },
    'not json',
  ], 7);
  assert.equal(code, 0);
  const reply = (id) => got.find((m) => m.id === id);
  assert.equal(reply(0).ok, true);
  assert.equal(reply(0).result.protocol, 1);
  assert.equal(reply(1).result.stage, 0);
  assert.deepEqual(reply(2).result, { stage: 2, key: 'styleFrames' });
  assert.equal(reply(3).ok, true);
  assert.equal(reply(4).error.code, 'no_project');
  assert.equal(reply(5).error.code, 'unknown_type');
  assert.equal(got.find((m) => m.id === null).error.code, 'bad_json');
  const statuses = got.filter((m) => m.event === 'status');
  assert.ok(statuses.some((s) => s.data.stage === 2 && s.data.stages[0].kind === 'done'));
  assert.deepEqual(got.filter((m) => m.event === 'chat.message').map((m) => m.data.role), ['user', 'system']);
});
