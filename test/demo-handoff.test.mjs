// The hand-off demo project (doc 38): a full graph from local test media, ready for handoff.plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeHandoffDemo } from '../src/demo-handoff.mjs';
import { handoffPlan } from '../src/svc/graph.mjs';

test('demo-handoff: shots (one remade, one cut), lines, music, cues and transitions reach handoff.plan', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mfx-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = makeHandoffDemo(root);
  const plan = handoffPlan(root, p.id);
  const shots = plan.clips.filter((c) => c.kind === 'shot');
  assert.equal(shots.length, 8, 'S06 is cut on the board');
  assert.equal(shots.find((s) => s.node === 's04').version, 2);
  assert.ok(shots.every((s) => existsSync(s.media.path)));
  assert.equal(plan.clips.filter((c) => c.kind === 'line').length, 6);
  assert.ok(plan.clips.some((c) => c.kind === 'music' && c.cues.length === 4));
  assert.equal(plan.cut_on_board.length, 1);
  assert.ok(plan.older_versions.some((o) => o.node === 's04' && o.version === 1));
  assert.equal(plan.markers.filter((m) => m.kind === 'chapter').length, 5);
  assert.deepEqual(plan.clips.filter((c) => c.kind === 'transition').map((c) => c.transition), ['Cross Dissolve', 'Dip to Black', 'Cut']);
});
