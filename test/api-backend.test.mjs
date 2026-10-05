// The API backend's agent loop against a fake Claude API (scripted streaming turns): no network, no key, no cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, addIntakeFile, loadProject } from '../src/projects.mjs';
import { submissions, stepChecks } from '../src/gates.mjs';
import { Runner } from '../src/runner.mjs';
import { saveConfig, loadConfig } from '../src/studio.mjs';
import { editorTool, confine, Shell, afterFallback } from '../src/backends/anthropic-api.mjs';
import * as api from '../src/backends/anthropic-api.mjs';

// Server-sent events for one assistant message made of the given blocks.
function sse(blocks, stopReason) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else {
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    out += ev('content_block_stop', { index });
  });
  out += ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 50 } });
  out += ev('message_stop', {});
  return out;
}

function fakeApi(turns, seen) {
  let i = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const turn = turns[i++] || { blocks: [{ type: 'text', text: 'done' }], stop: 'end_turn' };
    return new Response(sse(turn.blocks, turn.stop), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': `req_${i}` } });
  };
}

test('the API loop runs bash and the editor, submits through mfx, and ends at the gate', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'logo-sting', title: 'API sting' });
  await addIntakeFile(root, p.id, { field: 'logo', name: 'logo.svg', buffer: Buffer.from('<svg/>') });
  startProject(root, p.id);
  const checks = stepChecks(root, p.id, 'directions').map((c) => ({ id: c.id, result: 'pass' }));
  const submission = { note: 'Three directions.', items: [{ path: 'out/a.png', label: 'A · Draws itself' }], error_checks: checks, questions: [{ id: 'pick', text: 'Which one?', choices: ['A'], default: 'A' }] };
  const seen = [];
  const turns = [
    { blocks: [{ type: 'text', text: 'Reading the brief.' }, { type: 'tool_use', id: 'tu1', name: 'str_replace_based_edit_tool', input: { command: 'view', path: 'CLAUDE.md' } }], stop: 'tool_use' },
    { blocks: [{ type: 'tool_use', id: 'tu2', name: 'bash', input: { command: 'mkdir -p out && printf png > out/a.png && cd out && pwd' } }], stop: 'tool_use' },
    { blocks: [{ type: 'tool_use', id: 'tu3', name: 'str_replace_based_edit_tool', input: { command: 'create', path: 'submission.json', file_text: JSON.stringify(submission) } }], stop: 'tool_use' },
    // The shell is persistent: we're still in out/ from the last command.
    { blocks: [{ type: 'tool_use', id: 'tu4', name: 'bash', input: { command: 'cd .. && mfx submit directions submission.json && mfx handoff "Sent three directions."' } }], stop: 'tool_use' },
    { blocks: [{ type: 'text', text: 'Submitted; stopping at the gate.' }], stop: 'end_turn' },
  ];
  saveConfig(root, { backend: 'anthropic-api', webTools: false });
  const config = loadConfig(root);
  const { BACKENDS } = await import('../src/runner.mjs');
  BACKENDS['anthropic-api-fake'] = { run: (args) => api.run({ ...args, config: { ...config, _fetch: fakeApi(turns, seen) } }) };
  t.after(() => { delete BACKENDS['anthropic-api-fake']; });
  saveConfig(root, { backend: 'anthropic-api-fake' });

  const runner = new Runner(root);
  const activity = [];
  runner.on('activity', (a) => activity.push(a.text));
  await runner.runSession(p.id);

  const project = loadProject(root, p.id);
  assert.equal(project.state, 'waiting', JSON.stringify(activity));
  assert.equal(submissions(root, p.id)[0].items[0].label, 'A · Draws itself');
  assert.equal(seen.length, 5);
  // Request shape: adaptive thinking, effort, caching, compaction, fallbacks, the bash + editor tools.
  const req = seen[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.equal(req.output_config.effort, 'high');
  assert.deepEqual(req.cache_control, { type: 'ephemeral' });
  assert.equal(req.context_management.edits[0].type, 'compact_20260112');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.tools.map((x) => x.type), ['bash_20250124', 'text_editor_20250728']);
  assert.match(req.messages[0].content, /# Mortiflix project: API sting/);
  // Tool results came back to the model, and the cd persisted across commands.
  const results = seen[2].messages.at(-1).content;
  assert.match(results[0].content, /\/out$/);
  assert.ok(activity.some((a) => a.startsWith('$ cd .. && mfx submit')));
});

test('editor stays inside the project folder', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'mfx-ed-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'a'));
  writeFileSync(join(work, 'a', 'f.txt'), 'one\ntwo\n');
  assert.throws(() => confine(work, '../x'), /outside/);
  assert.throws(() => confine(work, '/etc/passwd'), /outside/);
  symlinkSync('/etc', join(work, 'link'));
  assert.throws(() => confine(work, 'link/passwd'), /outside/);
  assert.throws(() => confine(work, 'link/new.txt', true), /outside/);
  assert.match(editorTool(work, { command: 'view', path: 'a/f.txt' }).content, /1\tone/);
  assert.equal(editorTool(work, { command: 'str_replace', path: 'a/f.txt', old_str: 'zzz', new_str: 'x' }).error, true);
  editorTool(work, { command: 'str_replace', path: 'a/f.txt', old_str: 'two', new_str: 'deux' });
  editorTool(work, { command: 'insert', path: 'a/f.txt', insert_line: 0, insert_text: 'zero' });
  assert.equal(readFileSync(join(work, 'a', 'f.txt'), 'utf8'), 'zero\none\ndeux\n');
  editorTool(work, { command: 'create', path: 'b/c/new.md', file_text: 'hi' });
  assert.equal(readFileSync(join(work, 'b/c/new.md'), 'utf8'), 'hi');
  writeFileSync(join(work, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(editorTool(work, { command: 'view', path: 'p.png' }).content[0].type, 'image');
});

test('the shell survives timeouts and exits', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'mfx-sh-'));
  const sh = new Shell(work, process.env);
  t.after(() => { sh.close(); rmSync(work, { recursive: true, force: true }); });
  assert.equal((await sh.run('export X=7; echo $X')).output.trim(), '7');
  assert.equal((await sh.run('echo $X; false')).code, 1);
  assert.equal((await sh.run('read line; echo got:$line')).output.trim(), 'got:');
  const slow = await sh.run('sleep 5', 300);
  assert.equal(slow.code, 124);
  assert.match((await sh.run('exit 3')).output, /new one was started/);
  assert.equal((await sh.run('echo alive')).output.trim(), 'alive');
});

test('blocks of a declined attempt are dropped after a fallback', () => {
  const content = [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: 'partial' },
    { type: 'tool_use', id: 't1', name: 'bash', input: {} },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    { type: 'thinking', thinking: '' },
    { type: 'tool_use', id: 't2', name: 'bash', input: {} },
  ];
  assert.deepEqual(afterFallback(content).map((b) => b.type), ['text', 'fallback', 'thinking', 'tool_use']);
  assert.equal(afterFallback(content).at(-1).id, 't2');
});
