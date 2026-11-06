// T11: several Claude processes in one transcript are separate segments, interrupted ones are counted, and the
// runner books the transcript's tokens when a run has no result line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tokenRuns, tokenRun, runUsage, _forget } from '../src/svc/tokens.mjs';

const P = '261101-test-accounting-0001';
const J = (o) => JSON.stringify(o) + '\n';
const init = (tools, model = 'claude-sonnet-5-5') => J({ type: 'system', subtype: 'init', model, tools });
const asst = (id, u, content = [{ type: 'text', text: 'ok' }]) => J({ type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-sonnet-5-5', usage: u, content } });
const U = (cw, cr, out) => ({ input_tokens: 1, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out });

function make(body) {
  _forget();
  const root = mkdtempSync(join(tmpdir(), 'mfx-acc-'));
  mkdirSync(join(root, 'state', P, 'sessions'), { recursive: true });
  const id = '2026-11-01T10-00-00-000Z';
  writeFileSync(join(root, 'state', P, 'sessions', `${id}.jsonl`), body);
  return { root, id };
}

test('a quick call then a session are two segments; the session start-up is not booked to the quick call', () => {
  const { root, id } = make(
    init(['StructuredOutput'])
    + asst('q1', U(500, 0, 10))
    + J({ type: 'result', usage: { output_tokens: 40 } })
    + init(['Task', 'Bash', 'Read'])
    + asst('s1', U(24000, 0, 10))
    + asst('s2', U(100, 24000, 10))
    + J({ type: 'result', usage: { output_tokens: 80 } }));
  const r = tokenRuns(root, P).runs[0];
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.segments.map((g) => g.kind), ['quick', 'session']);
  assert.equal(r.segments[0].cache_write, 500);
  assert.equal(r.segments[0].output, 40);
  assert.equal(r.segments[1].cache_write, 24100);
  assert.equal(r.segments[1].output, 80);
  assert.equal(r.interrupted, 0);
  assert.equal(r.output, 120);
  assert.ok(tokenRun(root, P, id).run.segments.length === 2);
});

test('a segment with no result line is interrupted, and runUsage counts it', () => {
  const { root, id } = make(
    init(['Task', 'Bash'])
    + asst('s1', U(1000, 0, 10))
    + asst('s2', U(10, 1000, 10)));
  const r = tokenRuns(root, P).runs[0];
  assert.equal(r.interrupted, 1);
  const u = runUsage(root, P, id);
  assert.equal(u.input_tokens, 1 + 1000 + 1 + 10 + 1000);
  assert.ok(u.output_tokens > 0);
  assert.equal(u.interrupted, 1);
  // a running one is not interrupted
  _forget();
  assert.equal(tokenRuns(root, P, { running: id }).runs[0].interrupted, 0);
  assert.equal(runUsage(root, P, 'nope-nope-nope'), null);
});
