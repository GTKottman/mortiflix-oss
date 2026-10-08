import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../src/cli.mjs';
import { RenderQueue } from '../src/renderq.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('terminal notes point at items, spots, moments and paragraphs', () => {
  assert.deepEqual(parseNote('just words'), { text: 'just words' });
  assert.deepEqual(parseNote('2: too dark'), { item: 2, text: 'too dark' });
  assert.deepEqual(parseNote('1@0.5,0.25: bigger'), { item: 1, x: 0.5, y: 0.25, text: 'bigger' });
  assert.deepEqual(parseNote('0@12.5s: cut here'), { item: 0, time_sec: 12.5, text: 'cut here' });
  assert.deepEqual(parseNote('3¶2: reword'), { item: 3, paragraph: 2, text: 'reword' });
});

test('renders run one at a time, in order, and report their output', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-rq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = new RenderQueue({ logDir: dir });
  const a = q.add({ projectId: 'p', sessionId: 's', label: 'a', argv: ['node', '-e', 'setTimeout(() => console.log("first"), 300)'], cwd: dir, env: process.env });
  const b = q.add({ projectId: 'p', sessionId: 's', label: 'b', argv: ['node', '-e', 'console.log("second"); process.exit(3)'], cwd: dir, env: process.env });
  assert.equal(a.state, 'running');
  assert.equal(b.state, 'waiting');
  assert.equal(b.renders_ahead, 1);
  const ra = await q.wait(a.id, 'p', 5);
  assert.equal(ra.state, 'done');
  assert.match(ra.output_tail, /first/);
  const rb = await q.wait(b.id, 'p', 5);
  assert.equal(rb.state, 'failed');
  assert.equal(rb.exit_code, 3);
  assert.throws(() => q.get(a.id, 'other-project'), /no render/);
});
