// Token usage per run (owner, 2026-10-18): totals, bars, what was pulled in, helper agents, both transcript shapes,
// reading only what was added, and hostile input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tokenRuns, tokenRun, redact, describe, modelName, _forget } from '../src/svc/tokens.mjs';

const P = '261018-test-tokens-0001';
function studio() {
  const root = mkdtempSync(join(tmpdir(), 'mfx-tokens-'));
  mkdirSync(join(root, 'state', P, 'sessions'), { recursive: true });
  return root;
}
const J = (o) => JSON.stringify(o) + '\n';
const asst = (id, usage, content, parent = null) => J({ type: 'assistant', parent_tool_use_id: parent, message: { id, model: 'claude-opus-5-5', usage, content } });
const res = (tid, content, parent = null) => J({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content }] } });

test('Claude Code runs: one message counted once, helper agents apart, output scaled to the exact total', () => {
  _forget();
  const root = studio();
  const f = join(root, 'state', P, 'sessions', '2026-10-18T10-00-00-000Z.jsonl');
  const u1 = { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 3 };
  const u2 = { input_tokens: 2, cache_creation_input_tokens: 4000, cache_read_input_tokens: 1000, output_tokens: 3 };
  const u3 = { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 3 };
  writeFileSync(f,
    J({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
    + asst('m1', u1, [{ type: 'text', text: 'Reading the plan first.' }])
    + asst('m1', u1, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/plan.md' } }])
    + res('t1', 'x'.repeat(16000))
    + asst('m2', u2, [{ type: 'tool_use', id: 't2', name: 'Task', input: { description: 'Make part 1' } }])
    + asst('a1', { input_tokens: 9, cache_creation_input_tokens: 700, cache_read_input_tokens: 0, output_tokens: 1 }, [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'OPENAI_API_KEY=sk-abcdefghijklmnop ffmpeg -i a b' } }], 't2')
    + res('t3', 'done', 't2')
    + res('t2', 'part 1 made')
    + asst('m3', u3, [{ type: 'text', text: 'All done.' }])
    + J({ type: 'result', total_cost_usd: 1.25, usage: { input_tokens: 8, cache_creation_input_tokens: 5010, cache_read_input_tokens: 6000, output_tokens: 300 } }));
  const { runs } = tokenRuns(root, P);
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.calls, 4);
  assert.equal(r.input, 8 + 9);
  assert.equal(r.cache_write, 5010 + 700);
  assert.equal(r.cache_read, 6000);
  assert.equal(r.cost_usd, 1.25);
  const d = tokenRun(root, P, r.id);
  const agent = d.bars.find((b) => b.key.startsWith('Helper agent: Make part 1'));
  assert.ok(agent, 'a helper agent is one bar');
  assert.equal(agent.calls, 1);
  // the main session's output adds up to Claude Code's exact total (the agent's is its own estimate)
  const mainOut = d.bars.filter((b) => b !== agent).reduce((a, b) => a + b.output, 0);
  assert.ok(Math.abs(mainOut - 300) <= 2, `main output ${mainOut}`);
  // the plan was pulled in once and carried by the two main calls after it
  const plan = d.pulled.find((p) => p.label === 'Read /x/plan.md');
  assert.equal(plan.calls_after, 2);
  assert.ok(plan.tokens > 3000 && plan.tokens <= 4000, `plan tokens ${plan.tokens}`);
  assert.equal(plan.carried, plan.tokens * 2);
  // keys in commands never reach the app
  assert.ok(!JSON.stringify(d).includes('sk-abcdefghijklmnop'));
});

test('API runs, reading only what was added, and newest first', () => {
  _forget();
  const root = studio();
  const dir = join(root, 'state', P, 'sessions');
  const old = join(dir, '2026-10-18T09-00-00-000Z.jsonl');
  writeFileSync(old, J({ type: 'assistant', model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'cd x && python3 make.py' } }] }));
  const f = join(dir, '2026-10-18T11-00-00-000Z.jsonl');
  writeFileSync(f, J({ type: 'assistant', model: 'claude-sonnet-5-5', usage: { input_tokens: 50, output_tokens: 5 }, content: [] }));
  let { runs } = tokenRuns(root, P, { running: '2026-10-18T11-00-00-000Z' });
  assert.deepEqual(runs.map((r) => r.id), ['2026-10-18T11-00-00-000Z', '2026-10-18T09-00-00-000Z']);
  assert.equal(runs[0].running, true);
  assert.equal(runs[0].backend, 'anthropic-api');
  assert.equal(tokenRun(root, P, runs[1].id).bars[0].key, 'Run: python3');
  // the running session grows: the new lines are added, nothing counted twice (a half line waits)
  appendFileSync(f, J({ type: 'assistant', model: 'claude-sonnet-5-5', usage: { input_tokens: 70, output_tokens: 7 }, content: [] }) + '{"type":"assis');
  ({ runs } = tokenRuns(root, P));
  assert.equal(runs[0].calls, 2);
  assert.equal(runs[0].input, 120);
  appendFileSync(f, 'tant","usage":{"input_tokens":1,"output_tokens":1},"content":[]}\n');
  ({ runs } = tokenRuns(root, P));
  assert.equal(runs[0].calls, 3);
  assert.equal(runs[0].output, 13);
});

test('one run on several models (a cheaper one for reviews): split per model, and per bar', () => {
  _forget();
  const root = studio();
  const f = join(root, 'state', P, 'sessions', '2026-10-20T09-00-00-000Z.jsonl');
  const call = (model, input, output, tool) => J({ type: 'assistant', model, usage: { input_tokens: input, output_tokens: output }, content: tool ? [{ type: 'tool_use', id: `t${input}`, name: 'Read', input: { file_path: tool } }] : [] });
  writeFileSync(f, call('claude-opus-5-5', 1000, 500) + call('claude-sonnet-5-5', 3000, 40, 'sheet.png') + call('claude-haiku-5-5', 200, 60));
  const [run] = tokenRuns(root, P).runs;
  assert.equal(run.model, 'Sonnet 5.5 + Opus 5.5 + Haiku 5.5');
  assert.deepEqual(run.models.map((m) => [m.model, m.calls, m.total]), [['Sonnet 5.5', 1, 3040], ['Opus 5.5', 1, 1500], ['Haiku 5.5', 1, 260]]);
  const { bars } = tokenRun(root, P, run.id);
  assert.deepEqual(bars.find((b) => b.key !== 'Thinking and answering (no tool)').models, ['Sonnet 5.5']);
  assert.deepEqual(bars.find((b) => b.key === 'Thinking and answering (no tool)').models.sort(), ['Haiku 5.5', 'Opus 5.5']);
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelName(''), 'Claude');
});

test('hostile input: run and project ids, junk lines, labels', () => {
  _forget();
  const root = studio();
  assert.throws(() => tokenRun(root, P, '../../etc/passwd'), /bad run id/);
  assert.throws(() => tokenRuns(root, '../x'), /bad project id/);
  assert.throws(() => tokenRun(root, P, '2026-10-18T12-00-00-000Z'), /no run/);
  writeFileSync(join(root, 'state', P, 'sessions', '2026-10-18T12-00-00-000Z.jsonl'), 'not json\n{"type":"assistant","message":null}\n[1,2]\n');
  assert.equal(tokenRuns(root, P).runs[0].calls, 0);
  assert.equal(redact('curl -H "Authorization: Bearer abc.def" GH_TOKEN=ghp_12345678abcd'), 'curl -H "Authorization: Bearer …" GH_TOKEN=…');
  assert.equal(describe('mcp__blender__look', {}).group, 'Tool server: blender');
  assert.equal(describe('WebFetch', { url: 'not a url' }).from, 'not a url');
});
