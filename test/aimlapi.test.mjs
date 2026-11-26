// The AI/ML API backend against a fake OpenAI-compatible API (scripted turns): no network, no key, no cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, addIntakeFile, loadProject, projectPaths } from '../src/projects.mjs';
import { submissions, stepChecks } from '../src/gates.mjs';
import { Runner, BACKENDS } from '../src/runner.mjs';
import { saveConfig, loadConfig, writeSecret } from '../src/studio.mjs';
import * as aiml from '../src/backends/aimlapi.mjs';
import { keysFor, keySource, verifyKey } from '../src/keys.mjs';
import { BACKENDS as SETUP_BACKENDS } from '../src/svc/setup.mjs';
import { askAnon } from '../src/svc/chat.mjs';
import { readRows } from '../src/svc/ledger.mjs';

const call = (id, name, input) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
const reply = (message, finish) => ({ id: 'chatcmpl-1', model: 'anthropic/claude-sonnet-5', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeApi(turns, seen) {
  let i = 0;
  return async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return json(turns[i++] || reply({ content: 'done' }, 'stop'));
  };
}

test('aimlapi: the loop runs bash and the editor as function tools, shows pictures, and ends at the gate', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'logo-sting', title: 'AIML sting' });
  await addIntakeFile(root, p.id, { field: 'logo', name: 'logo.svg', buffer: Buffer.from('<svg/>') });
  startProject(root, p.id);
  writeFileSync(join(projectPaths(root, p.id).work, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const checks = stepChecks(root, p.id, 'directions').map((c) => ({ id: c.id, result: 'pass' }));
  const submission = { note: 'Three directions.', items: [{ path: 'out/a.png', label: 'A · Draws itself' }], error_checks: checks, questions: [{ id: 'pick', text: 'Which one?', choices: ['A'], default: 'A' }] };
  const seen = [];
  const turns = [
    reply({ content: 'Looking at the frame.', tool_calls: [call('c1', 'str_replace_based_edit_tool', { command: 'view', path: 'frame.png' })] }, 'tool_calls'),
    reply({ content: null, tool_calls: [call('c2', 'bash', { command: 'mkdir -p out && printf png > out/a.png && cd out && pwd' })] }, 'tool_calls'),
    reply({ content: null, tool_calls: [call('c3', 'str_replace_based_edit_tool', { command: 'create', path: 'submission.json', file_text: JSON.stringify(submission) })] }, 'tool_calls'),
    reply({ content: null, tool_calls: [call('c4', 'bash', { command: 'cd .. && mfx submit directions submission.json && mfx handoff "Sent three directions."' })] }, 'tool_calls'),
    reply({ content: 'Submitted; stopping at the gate.' }, 'stop'),
  ];
  saveConfig(root, { backend: 'aimlapi' });
  const config = loadConfig(root);
  BACKENDS['aimlapi-fake'] = { run: (args) => aiml.run({ ...args, config: { ...config, _fetch: fakeApi(turns, seen) } }) };
  t.after(() => { delete BACKENDS['aimlapi-fake']; });
  saveConfig(root, { backend: 'aimlapi-fake' });

  const runner = new Runner(root);
  const activity = [];
  runner.on('activity', (a) => activity.push(a.text));
  await runner.runSession(p.id);

  assert.equal(loadProject(root, p.id).state, 'waiting', JSON.stringify(activity));
  assert.equal(submissions(root, p.id)[0].items[0].label, 'A · Draws itself');
  assert.equal(seen.length, 5);
  for (const s of seen) assert.equal(new URL(s.url).href, 'https://api.aimlapi.com/v1/chat/completions');
  const req = seen[0].body;
  assert.equal(req.model, 'anthropic/claude-sonnet-5');
  assert.deepEqual(req.tools.map((x) => x.function.name), ['bash', 'str_replace_based_edit_tool']);
  assert.equal(req.messages[0].role, 'system');
  // The viewed picture came back as an image the model can see, after the tool message that answers the call.
  const second = seen[1].body.messages;
  assert.equal(second.at(-2).role, 'tool');
  assert.equal(second.at(-2).tool_call_id, 'c1');
  assert.match(second.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
  // The shell is persistent: the third call saw the cd.
  assert.match(seen[2].body.messages.at(-1).content, /\/out$/);
});

test('aimlapi: the key goes only to https://api.aimlapi.com, and a redirect is not followed', async () => {
  const sent = [];
  const redirecting = async (url, init) => { sent.push({ url, init }); return new Response(null, { status: 302, headers: { location: 'https://evil.example/v1/chat/completions' } }); };
  await assert.rejects(aiml.request('k-secret', '/chat/completions', { method: 'POST', body: { model: 'x' }, fetch: redirecting }), /redirect/);
  assert.equal(sent.length, 1);
  assert.equal(new URL(sent[0].url).host, 'api.aimlapi.com');
  assert.equal(sent[0].init.redirect, 'manual');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer k-secret');
  // The retrying client gives up on a redirect too (it isn't a server error), so the key is sent once and no further.
  sent.length = 0;
  await assert.rejects(aiml.chat('k-secret', { model: 'x' }, { fetch: redirecting, delayMs: 0 }), /redirect/);
  assert.equal(sent.length, 1);
});

test('aimlapi: its own key, needed only by projects on its backend; the default backend stays as it was', async (t) => {
  const root = tempStudio(t);
  assert.ok(SETUP_BACKENDS.includes('aimlapi'));
  assert.deepEqual(keysFor(root, { backend: 'aimlapi', steps: [] }), ['aimlapi']);
  assert.deepEqual(keysFor(root, { backend: 'anthropic-api', steps: [] }), ['anthropic']);
  assert.equal(aiml.available({}, root).ok, process.env.AIMLAPI_API_KEY ? true : false);
  writeSecret(root, 'aimlapi_api_key', 'k-saved');
  assert.equal(keySource(root, 'aimlapi'), 'saved');
  assert.ok(aiml.available({}, root).ok);
  const { DEFAULT_CONFIG } = await import('../src/studio.mjs');
  assert.equal(DEFAULT_CONFIG.backend, 'claude-code');
});

test('aimlapi: the key check calls GET /v1/key on api.aimlapi.com only', async (t) => {
  const root = tempStudio(t);
  const urls = [];
  const ok = await verifyKey(root, 'aimlapi', 'k1', { fetch: async (url, init) => { urls.push([url, init.headers.Authorization]); return json({ data: {} }); } });
  assert.equal(ok.ok, true);
  assert.deepEqual(urls, [['https://api.aimlapi.com/v1/key', 'Bearer k1']]);
  const bad = await verifyKey(root, 'aimlapi', 'k2', { fetch: async () => json({ message: 'no' }, 401) });
  assert.equal(bad.ok, false);
});

test('aimlapi: quick calls (no tools) go through the same client and are booked', async (t) => {
  const root = tempStudio(t, { backend: 'aimlapi' });
  writeSecret(root, 'aimlapi_api_key', 'k-quick');
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return json(reply({ content: 'A sharper brief.' }, 'stop')); };
  t.after(() => { globalThis.fetch = real; });
  assert.equal(await askAnon(root, 'Improve this brief'), 'A sharper brief.');
  assert.equal(seen[0].url, 'https://api.aimlapi.com/v1/chat/completions');
  assert.equal(seen[0].body.model, 'anthropic/claude-sonnet-5');
  assert.equal(seen[0].body.tools, undefined);
  const row = readRows(root).find((r) => r.kind === 'quick call');
  assert.equal(row.model, 'anthropic/claude-sonnet-5');
  assert.equal(row.input_tokens, 100);
});

test('aimlapi: a fresh studio with only an AI/ML API key starts on it; a studio already set up keeps its backend', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mfx-detect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // No `claude` on the PATH and no Anthropic key: only the AI/ML API key is there.
  const env = { HOME: dir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, AIMLAPI_API_KEY: 'k-env', NO_COLOR: '1' };
  const init = (studio, ...args) => spawnSync(process.execPath, ['bin/mortiflix', '--studio', studio, 'init', '--yes', ...args], { env, encoding: 'utf8', input: '' });
  const backendOf = (studio) => JSON.parse(readFileSync(join(studio, 'config.json'), 'utf8')).backend;
  assert.equal(init(join(dir, 'fresh')).status, 0);
  assert.equal(backendOf(join(dir, 'fresh')), 'aimlapi');
  // An existing studio on another backend: init again doesn't move it.
  assert.equal(init(join(dir, 'old'), '--backend', 'demo').status, 0);
  assert.equal(init(join(dir, 'old')).status, 0);
  assert.equal(backendOf(join(dir, 'old')), 'demo');
});
