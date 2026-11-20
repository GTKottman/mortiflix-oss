// The LiteLLM backend's agent loop against a fake LiteLLM proxy (OpenAI-shaped chat completions): no network, no cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, addIntakeFile, loadProject, projectPaths } from '../src/projects.mjs';
import { submissions, stepChecks } from '../src/gates.mjs';
import { Runner } from '../src/runner.mjs';
import { saveConfig, loadConfig, writeSecret } from '../src/studio.mjs';
import * as litellm from '../src/backends/litellm.mjs';
import { keysFor, verifyKey } from '../src/keys.mjs';

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// One chat completion: a message with optional tool calls, the finish reason, usage, and the cost header.
function completion({ content = null, calls = [], finish = calls.length ? 'tool_calls' : 'stop', cost = 0.0012 }) {
  const body = {
    id: 'chatcmpl-1', model: 'gpt-4.1-mini',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-litellm-response-cost': String(cost) } });
}

function fakeProxy(turns, seen) {
  let i = 0;
  return async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const turn = turns[i++] || { content: 'done' };
    return typeof turn === 'function' ? turn() : completion(turn);
  };
}

async function runFake(t, root, projectId, turns, config = {}) {
  const seen = [];
  saveConfig(root, { backend: 'litellm', model: 'gpt-4.1-mini', litellmBaseUrl: 'http://proxy.test:4000/v1/', ...config });
  const cfg = loadConfig(root);
  // Swap the real entry so the runner treats the session as the litellm backend (start prompt, edit routing).
  const { BACKENDS } = await import('../src/runner.mjs');
  const real = BACKENDS.litellm;
  BACKENDS.litellm = { ...real, run: (args) => litellm.run({ ...args, config: { ...cfg, _fetch: fakeProxy(turns, seen) } }) };
  t.after(() => { BACKENDS.litellm = real; });
  const runner = new Runner(root);
  const activity = [];
  runner.on('activity', (a) => activity.push(a.text));
  await runner.runSession(projectId);
  return { seen, activity };
}

test('the LiteLLM loop runs bash and the editor, submits through mfx, and ends at the gate', async (t) => {
  const root = tempStudio(t);
  writeSecret(root, 'litellm_api_key', 'sk-proxy-test');
  const p = createProject(root, { pipeline: 'logo-sting', title: 'Proxy sting' });
  await addIntakeFile(root, p.id, { field: 'logo', name: 'logo.svg', buffer: Buffer.from('<svg/>') });
  startProject(root, p.id);
  const checks = stepChecks(root, p.id, 'directions').map((c) => ({ id: c.id, result: 'pass' }));
  const submission = { note: 'Three directions.', items: [{ path: 'out/a.png', label: 'A · Draws itself' }], error_checks: checks, questions: [{ id: 'pick', text: 'Which one?', choices: ['A'], default: 'A' }] };
  const { seen, activity } = await runFake(t, root, p.id, [
    { content: 'Reading the brief.', calls: [toolCall('c1', 'str_replace_based_edit_tool', { command: 'view', path: 'CLAUDE.md' })] },
    { calls: [toolCall('c2', 'bash', { command: 'mkdir -p out && printf png > out/a.png && cd out && pwd' })] },
    { calls: [toolCall('c3', 'str_replace_based_edit_tool', { command: 'create', path: 'submission.json', file_text: JSON.stringify(submission) })] },
    // The shell is persistent: still in out/ from the last command.
    { calls: [toolCall('c4', 'bash', { command: 'cd .. && mfx submit directions submission.json && mfx handoff "Sent three directions."' })] },
    { content: 'Submitted; stopping at the gate.', cost: 0.0004 },
  ]);

  const project = loadProject(root, p.id);
  assert.equal(project.state, 'waiting', JSON.stringify(activity));
  assert.equal(submissions(root, p.id)[0].items[0].label, 'A · Draws itself');
  assert.equal(seen.length, 5);
  // Request shape: the proxy's chat completions endpoint (no doubled /v1), the key, function tools, drop_params.
  const req = seen[0];
  assert.equal(req.url, 'http://proxy.test:4000/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-proxy-test');
  assert.equal(req.body.model, 'gpt-4.1-mini');
  assert.equal(req.body.drop_params, true);
  assert.deepEqual(req.body.tools.map((x) => x.function.name), ['bash', 'str_replace_based_edit_tool']);
  assert.equal(req.body.messages[0].role, 'system');
  assert.match(req.body.messages[1].content, /# Mortiflix project: Proxy sting/);
  // Tool results came back as tool messages, and the cd persisted across commands.
  const third = seen[2].body.messages;
  assert.equal(third.at(-1).role, 'tool');
  assert.equal(third.at(-1).tool_call_id, 'c2');
  assert.match(third.at(-1).content, /\/out$/);
  assert.ok(activity.some((a) => a.startsWith('$ cd .. && mfx submit')));
  // The proxy's per-call cost is booked as the session's spend.
  assert.equal(loadProject(root, p.id).usage.cost_usd, 0.0052);
});

test('a frame the editor views reaches the model as an image, and only the newest stays', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'logo-sting', title: 'Frames' });
  await addIntakeFile(root, p.id, { field: 'logo', name: 'logo.svg', buffer: Buffer.from('<svg/>') });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  writeFileSync(join(work, 'f1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(work, 'f2.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { seen } = await runFake(t, root, p.id, [
    { calls: [toolCall('v1', 'str_replace_based_edit_tool', { command: 'view', path: 'f1.png' })] },
    { calls: [toolCall('v2', 'str_replace_based_edit_tool', { command: 'view', path: 'f2.png' })] },
    { content: 'Frames look right.' },
  ]);
  const second = seen[1].body.messages;
  assert.match(second.at(-2).content, /the image follows/);
  assert.equal(second.at(-1).role, 'user');
  assert.match(second.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
  const third = seen[2].body.messages;
  const withImages = third.filter((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
  assert.equal(withImages.length, 1);
  assert.equal(withImages[0].content[0].text, 'f2.png');
  assert.ok(third.some((m) => Array.isArray(m.content) && m.content.some((c) => c.text === '[a frame shown earlier]')));
});

test('bad tool arguments come back as an error the model can fix', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'logo-sting', title: 'Bad args' });
  await addIntakeFile(root, p.id, { field: 'logo', name: 'logo.svg', buffer: Buffer.from('<svg/>') });
  startProject(root, p.id);
  const { seen } = await runFake(t, root, p.id, [
    { calls: [{ id: 'x1', type: 'function', function: { name: 'bash', arguments: '{"command": "ls' } }] },
    { content: 'Fixed.' },
  ]);
  assert.match(seen[1].body.messages.at(-1).content, /weren't valid JSON/);
});

test('a rejected key stops the session with a clear error; a busy proxy is retried', async (t) => {
  const root = tempStudio(t);
  const work = projectPaths(root, createProject(root, { pipeline: 'logo-sting', title: 'Keys' }).id).work;
  const config = { model: 'gpt-4.1-mini', litellmBaseUrl: 'http://proxy.test:4000', maxTurns: 5 };
  const base = { root, workdir: work, prompt: 'go', env: {}, transcript: join(work, 't.jsonl'), onActivity: () => {} };

  const refused = await litellm.run({ ...base, config: { ...config, _fetch: async () => new Response('{"error":{"message":"Authentication Error"}}', { status: 401 }) } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /rejected the key/);

  let calls = 0;
  const flaky = async () => (++calls === 1 ? new Response('busy', { status: 503 }) : completion({ content: 'ok' }));
  const t0 = Date.now();
  const ok = await litellm.run({ ...base, config: { ...config, _fetch: flaky } });
  assert.equal(ok.ok, true);
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 1900, 'waits before retrying');

  const noModel = await litellm.run({ ...base, config: { litellmBaseUrl: 'http://proxy.test:4000' } });
  assert.match(noModel.error, /no model/);
});

test('available needs a proxy URL and a model; the base URL is normalized', (t) => {
  const root = tempStudio(t);
  const saved = process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_BASE_URL;
  t.after(() => { if (saved !== undefined) process.env.LITELLM_BASE_URL = saved; });
  assert.equal(litellm.available({}, root).ok, false);
  assert.equal(litellm.available({ litellmBaseUrl: 'http://p:4000' }, root).ok, false);
  assert.equal(litellm.available({ litellmBaseUrl: 'http://p:4000', model: 'gemini-2.5-flash' }, root).ok, true);
  assert.equal(litellm.baseUrl({ litellmBaseUrl: 'http://p:4000/v1/' }), 'http://p:4000');
  assert.equal(litellm.baseUrl({}), litellm.DEFAULT_BASE_URL);
  // The key is optional: a proxy without keys runs with none.
  assert.deepEqual(keysFor(root, { backend: 'litellm', pipeline: { steps: [] } }), []);
});

test('the Settings model list and the key check read /v1/models', async (t) => {
  const root = tempStudio(t, { litellmBaseUrl: 'http://proxy.test:4000' });
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, auth: init?.headers?.authorization || init?.headers?.Authorization });
    if ((init?.headers?.Authorization || init?.headers?.authorization) === 'Bearer sk-bad') return new Response('no', { status: 401 });
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }, { id: 'claude-sonnet' }] }), { status: 200 });
  };
  writeSecret(root, 'litellm_api_key', 'sk-good');
  assert.deepEqual(await litellm.listModels(root, loadConfig(root), { fetch }), ['claude-sonnet', 'gpt-4.1-mini']);
  assert.equal(seen[0].url, 'http://proxy.test:4000/v1/models');
  assert.equal(seen[0].auth, 'Bearer sk-good');
  assert.equal((await verifyKey(root, 'litellm', 'sk-good', { fetch })).ok, true);
  assert.equal((await verifyKey(root, 'litellm', 'sk-bad', { fetch })).ok, false);
});

test('a quick call returns the text, the usage and the proxy cost', async (t) => {
  const root = tempStudio(t);
  const seen = [];
  const config = { model: 'gpt-4.1-mini', litellmBaseUrl: 'http://proxy.test:4000', _fetch: fakeProxy([{ content: 'Three beat names.', cost: 0.0007 }], seen) };
  const r = await litellm.chatOnce(root, config, { system: 'Be brief.', prompt: 'Name the beats.', maxTokens: 100 });
  assert.equal(r.text, 'Three beat names.');
  assert.equal(r.cost_usd, 0.0007);
  assert.equal(r.usage.prompt_tokens, 100);
  assert.deepEqual(seen[0].body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(seen[0].body.max_tokens, 100);
  assert.equal(seen[0].body.tools, undefined);
});
