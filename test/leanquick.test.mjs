// Token pass for quick calls: flags and one shared folder (quickargs), the cheap model + effort per role and the retry rule
// (models), the contact sheet helper, and the fixed text of each quick prompt coming before the project's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { quickCall, sharedQuickDir, isQuick, QUICK_FLAGS } from '../src/quickargs.mjs';
import { runAs, STUDIO_MODELS, effortFor } from '../src/models.mjs';
import { sheetFor } from '../src/sheet.mjs';

test('quick calls: lean flags, one shared folder, the project folder reachable by path', () => {
  const root = mkdtempSync(join(tmpdir(), 'mfx-q-'));
  const dir = join(root, 'run', 'quick', 'p1');
  assert.equal(sharedQuickDir(dir), join(root, 'run', 'quick', '_shared'));
  assert.equal(sharedQuickDir(join(root, 'run', 'quick')), join(root, 'run', 'quick', '_shared'));
  assert.equal(sharedQuickDir(join(root, 'work')), null);
  const q = quickCall(['-p'], dir);
  for (const f of QUICK_FLAGS) assert.ok(q.args.includes(f), f);
  assert.equal(q.cwd, join(root, 'run', 'quick', '_shared'));
  assert.ok(existsSync(q.cwd));
  assert.deepEqual(q.args.slice(-2), ['--add-dir', dir]);
  assert.equal(quickCall(['-p'], join(root, 'work')).cwd, join(root, 'work'));
  assert.equal(quickCall(['-p'], dir, { shareCwd: false }).cwd, dir);
  assert.ok(isQuick(['--json-schema', '{}']) && !isQuick(['--tools', '']));
});

test('models: chat, name and lesson on Haiku low; review medium; a timeout is not run again on the default model', async () => {
  assert.deepEqual(['chat', 'name', 'lesson'].map((r) => STUDIO_MODELS[r]), ['haiku', 'haiku', 'haiku']);
  assert.equal(effortFor({}, 'chat'), 'low');
  assert.equal(effortFor({}, 'review'), 'medium');
  assert.equal(effortFor({}, 'write'), null);
  const seen = [];
  const mk = (...rs) => async (a) => { seen.push({ model: a.config.model, effort: a.config.effort }); return rs.shift(); };
  const args = { config: { claudeArgs: ['--json-schema', '{}'] } };
  // review: sonnet at medium effort, answered
  let r = await runAs(mk({ ok: true, structured: { ok: true } }), 'review', args);
  assert.deepEqual(seen.pop(), { model: 'sonnet', effort: 'medium' });
  assert.equal(r.model, 'sonnet');
  // a timeout: one call only
  seen.length = 0;
  r = await runAs(mk({ ok: false, error: 'Claude Code took too long to answer' }), 'review', args);
  assert.equal(seen.length, 1);
  assert.equal(r.ok, false);
  // billing / login: one call only
  seen.length = 0;
  await runAs(mk({ ok: false, error: 'Credit balance is too low' }), 'review', args);
  assert.equal(seen.length, 1);
  // no answer (missing structured output): the default model, without the cheap model's effort
  seen.length = 0;
  r = await runAs(mk({ ok: true }, { ok: true, structured: { ok: true } }), 'review', args);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { model: undefined, effort: undefined });
  assert.match(r.model, /default/);
  // writing: default model, no effort
  seen.length = 0;
  await runAs(mk({ ok: true, structured: {} }), 'write', args);
  assert.deepEqual(seen[0], { model: undefined, effort: undefined });
});

test('sheetFor: one small JPEG sheet, 1280 wide', { skip: !process.env.PATH.split(':').some((d) => existsSync(join(d, 'ffmpeg'))) }, async () => {
  const { spawnSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'mfx-sheet-'));
  const files = [1, 2, 3, 4, 5].map((i) => { const f = join(d, `f${i}.png`); spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080', '-frames:v', '1', f]); return f; });
  for (const n of [1, 3, 5]) {
    const out = join(d, `s${n}.jpg`);
    assert.ok(sheetFor(files.slice(0, n), out), `${n} files`);
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    assert.equal(Number(p.stdout.trim()), 1280);
  }
});


test('startPrompt: no CLAUDE.md copy when Claude Code loads it itself', async () => {
  const { writeFileSync } = await import('node:fs');
  const { startPrompt } = await import('../src/runner.mjs');
  const d = mkdtempSync(join(tmpdir(), 'mfx-sp-'));
  writeFileSync(join(d, 'CLAUDE.md'), 'RULES-ONCE');
  assert.ok(!startPrompt(d, 'x', { claudeMd: false }).includes('RULES-ONCE'));
  assert.ok(startPrompt(d, 'x', { claudeMd: true }).includes('RULES-ONCE'));
});
