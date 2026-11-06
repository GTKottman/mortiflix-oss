import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The picture folder a render command writes to: `--sequence <dir>` (fork build) or the ProRes file's folder (npm 0.2.0).
const seqDir = (cmd) => { const m = cmd.match(/--sequence (\S+)/) || cmd.match(/-o (\S+)\/\.kg-sequence\.mov/); return m[1]; };
const forceSeq = (t, v) => { const o = process.env.MFX_KG_SEQUENCE; process.env.MFX_KG_SEQUENCE = v; t.after(() => { if (o === undefined) delete process.env.MFX_KG_SEQUENCE; else process.env.MFX_KG_SEQUENCE = o; }); };
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { stillsView, drawLine, makeStills, okLine, pickKeyWord, writtenForms, keyOf, keyWordVisible } from '../src/svc/stills.mjs';

const render = async ({ output }) => { mkdirSync(join(output, '..'), { recursive: true }); writeFileSync(output, 'png'); };
function project(t) {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Bikes', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'voice'), { recursive: true });
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify([
    { id: 'b01-1', text: 'So, this week?' }, { id: 'b01-2', text: 'Call it Black October.' }, { id: 'b02-1', text: 'Four bugs are exploited.' }]));
  return { root, id: p.id };
}

test('key word: number, proper noun, longest', () => {
  assert.equal(pickKeyWord('Four bugs are exploited.'), 'exploited');
  assert.equal(pickKeyWord('Patch 42 now'), '42');
  assert.equal(pickKeyWord('Call it Black October.'), 'Black October');
  assert.equal(pickKeyWord('So, this week?'), 'week');
});

test('stills.get lists a todo per line; drawing makes versions and checks the key word', async (t) => {
  const { root, id } = project(t);
  assert.deepEqual(stillsView(root, id).lines.map((l) => [l.line, l.state]), [['b01-1', 'todo'], ['b01-2', 'todo'], ['b02-1', 'todo']]);
  assert.deepEqual(await makeStills(root, id, { render }), { made: 3, failed: 0 });
  const l = stillsView(root, id).lines[1];
  assert.equal(l.state, 'check'); assert.equal(l.check.key_word_visible, true); assert.ok(existsSync(l.path));
  await drawLine(root, id, 'b01-2', { text: 'Black October is here', key_word: 'Plex' }, { render });
  const f = stillsView(root, id).lines[1];
  assert.equal(f.versions, 2); assert.equal(f.key_word, 'Plex');
  assert.equal(f.check.key_word_visible, true); // key is printed in the text layer
  assert.equal(okLine(root, id, 'b01-2').state, 'ok');
  assert.equal(stillsView(root, id).lines[1].state, 'ok');
});

test('render failure keeps the line todo with the error; unknown line and ok without picture refuse', async (t) => {
  const { root, id } = project(t);
  const r = await drawLine(root, id, 'b01-1', {}, { render: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  const l = stillsView(root, id).lines[0];
  assert.equal(l.error, 'boom'); assert.equal(l.path, null);
  assert.throws(() => okLine(root, id, 'b01-1'));
  await assert.rejects(drawLine(root, id, 'b09-9', {}, { render }));
});

import { drawLines } from '../src/svc/stills.mjs';
import { kinetographBatch, propsHash } from '../src/svc/stillsbatch.mjs';

test('batch: all pending lines in ONE render call; unchanged lines are not drawn again', async (t) => {
  const { root, id } = project(t);
  const calls = [];
  const renderBatch = async (items) => { calls.push(items.map((i) => i.line)); for (const i of items) { mkdirSync(join(i.output, '..'), { recursive: true }); writeFileSync(i.output, 'png'); } };
  assert.deepEqual(await makeStills(root, id, { renderBatch }), { made: 3, failed: 0 });
  assert.deepEqual(calls, [['b01-1', 'b01-2', 'b02-1']], 'one batch');
  assert.equal(stillsView(root, id).lines[1].check.key_word_visible, true);
  // nothing changed: zero renders
  const r = await drawLines(root, id, ['b01-1', 'b01-2', 'b02-1'], { renderBatch });
  assert.deepEqual(r, { drawn: [], skipped: ['b01-1', 'b01-2', 'b02-1'], failed: [] });
  assert.equal(calls.length, 1);
  // one line's key word changes: only that one is in the batch
  const doc = JSON.parse((await import('node:fs')).readFileSync(join(projectPaths(root, id).work, 'design', 'stills', 'stills.json'), 'utf8'));
  doc.lines['b01-2'].key_word = 'Plex';
  writeFileSync(join(projectPaths(root, id).work, 'design', 'stills', 'stills.json'), JSON.stringify(doc));
  const r2 = await drawLines(root, id, ['b01-1', 'b01-2', 'b02-1'], { renderBatch });
  assert.deepEqual(r2.drawn, ['b01-2']); assert.deepEqual(calls.at(-1), ['b01-2']);
  assert.equal(stillsView(root, id).lines[1].versions, 2);
});

test('batch failure marks every line with the error, none left drawing', async (t) => {
  const { root, id } = project(t);
  const r = await drawLines(root, id, ['b01-1', 'b01-2'], { renderBatch: async () => { throw new Error('gpu gone'); } });
  assert.equal(r.failed.length, 2);
  const v = stillsView(root, id).lines;
  assert.equal(v[0].error, 'gpu gone'); assert.notEqual(v[0].state, 'drawing'); assert.equal(v[0].path, null);
});

test('kinetographBatch: one bundle command for N lines, element-i moved to each line file', async (t) => {
  forceSeq(t, '1');
  const { root, id } = project(t);
  const work = projectPaths(root, id).work;
  let cmd = null;
  const run = (_sh, args) => {
    cmd = args[1];
    const dir = seqDir(cmd);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `element-${i}.png`), `p${i}`);
    return { status: 0 };
  };
  const items = ['a', 'b', 'c'].map((l, i) => ({ line: l, props: { text: l }, output: join(work, 'design', 'stills', `${l}-v1.png`) }));
  await kinetographBatch({ root, work, run })(items);
  assert.equal((cmd.match(/ render /g) || []).length, 1, 'one render process');
  assert.match(cmd, /--comp Stills/); assert.match(cmd, /--range 0\.\.=2/);
  assert.equal(JSON.parse(cmd.match(/--props '(.*?)' --range/)[1]).lines.length, 3);
  assert.equal(readFileSync(items[2].output, 'utf8'), 'p2');
  assert.equal(propsHash({ text: 'x' }), propsHash({ text: 'x' }));
});

test('kinetographBatch with a render queue: one job, waits for it (npm 0.2.0 ProRes route)', async (t) => {
  forceSeq(t, '0');
  const { root, id } = project(t);
  const work = projectPaths(root, id).work;
  const jobs = [];
  const renders = {
    add: (j) => { jobs.push(j); const dir = seqDir(j.argv[2]); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'element-0.png'), 'p'); writeFileSync(join(dir, 'element-1.png'), 'q'); return { id: 7, state: 'waiting' }; },
    wait: async () => ({ state: 'done', exit_code: 0 }),
  };
  const items = ['a', 'b'].map((l) => ({ line: l, props: { text: l }, output: join(work, 'design', 'stills', `${l}.png`) }));
  await kinetographBatch({ root, work, renders, projectId: id })(items);
  assert.equal(jobs.length, 1); assert.match(jobs[0].label, /stills \(2\)/);
  assert.equal(readFileSync(items[1].output, 'utf8'), 'q');
});

test('the key word is a real content word in the script\'s written form, never "I" from a spoken spelling', () => {
  const w = mkdtempSync(join(tmpdir(), 'kw-'));
  writeFileSync(join(w, 'script.md'), 'Pronunciations: say "Character A I" plainly.\n\n*A small line reads "Character.AI points users to its tools."*\n\nCharacter A I has over twenty million monthly users.\n');
  const forms = writtenForms(w);
  assert.equal(pickKeyWord('Character A I has over twenty million monthly users.', forms), 'Character.AI');
  assert.equal(pickKeyWord('If you use Character A I, export or delete your data before any sale.', forms), 'Character.AI');
  assert.equal(pickKeyWord('Character A I has over twenty million monthly users.'), 'Character');
  assert.equal(pickKeyWord('I think it is so.'), 'think');
  assert.equal(keyOf({ key_word: 'I' }, 'Character A I has over twenty million monthly users.', w), 'Character.AI');
  assert.equal(keyOf({ key_word: 'Black October' }, 'x', w), 'Black October');
  assert.equal(keyWordVisible('Character.AI', ['CHARACTER.AI HAS 20M USERS']), true);
  assert.equal(keyWordVisible('Character.AI', ['I am here']), false);
});
