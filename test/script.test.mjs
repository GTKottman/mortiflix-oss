// The Script panel's messages (script.get / script.edit / script.changed) on the demo backend: an edited line is saved
// into the script and its voice line, and only the shot and voice line that used those words are remade (v2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { Runner } from '../src/runner.mjs';
import { loadProject } from '../src/projects.mjs';
import { autoName } from '../src/svc/script.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function harness(t, root) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    const r = out.find((m) => m.id === id);
    if (!r.ok) { const e = new Error(`${type}: ${r.error.code}: ${r.error.message}`); e.code = r.error.code; throw e; }
    return r.result;
  };
  const events = (name) => out.filter((m) => m.event === name).map((m) => m.data);
  const tick = async () => { svc.poke(0); await sleep(30); };
  return { call, events, tick };
}

async function until(fn, { ms = 15_000, step = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(step);
  }
}

test('script: a beat with no name is named by its first words', () => {
  assert.equal(autoName('Open on a single shape that becomes the logo.'), 'Open on a single');
  assert.equal(autoName('  Close.  '), 'Close');
  assert.equal(autoName(''), '');
});

test('script: get, edit a line (its shot remade, v2; the voice line waits for Remake line), add, delete and restore, rename', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  const root = tempStudio(t, { mfxQuestionsBlock: false }); // the brief goes on with its defaults (not what this tests)
  const { call, events, tick } = harness(t, root);
  const runner = new Runner(root);
  runner.acquire();
  t.after(() => runner.release());
  const run = async () => { await runner.loop(); await tick(); };

  await assert.rejects(call('script.get'), /no_project/);
  const made = await call('project.new', { preset: 'explainer', title: 'Bikes', idea: 'Why bike lanes pay off', backend: 'demo' });
  const id = made.project.id;
  await call('look.brief.set', { vibe: 'calm', font: 'Inter' }); // the owner picks a look before the style frames
  await call('motion.brief.set', {}); // and leaves the motion to the AI before the animatic
  await call('transition.brief.set', {}); // and the transitions to the library
  await until(() => loadProject(root, id).state === 'queued');
  await run();
  await run();
  await run();
  // pass the gates up to the animatic (nothing is made before its gate)
  for (const from of [0, 1, 2, 3]) {
    await call('stage.set', { stage: from + 1, from, done: true });
    await run();
  }

  const s = await call('script.get');
  assert.equal(s.beats.length, 4);
  assert.equal(s.writing, false);
  const b1 = s.beats[0];
  assert.deepEqual([b1.id, b1.no, b1.name, b1.name_auto], ['b01', 1, 'Open on a single shape', true]);
  assert.ok(b1.colour?.hex);
  assert.equal(b1.lines.length, 1);
  const l1 = b1.lines[0];
  assert.equal(l1.id, 'b01-1');
  assert.equal(l1.words, 'Open on a single shape that becomes the logo.');
  assert.deepEqual(l1.feeds.map((f) => [f.node, f.kind, f.made]), [['b01-1', 'line', true], ['s01', 'shot', true]]);
  assert.equal(l1.read_only, false);
  const g0 = await call('graph.get');
  const v0 = (n) => g0.nodes.find((x) => x.id === n).current;
  assert.equal(v0('s01'), 1);
  assert.equal(v0('b01-1'), 1);

  // Edit one line: saved into beats.json + voice/lines.json, only s01 is remade (a made voice line waits for the owner's Remake line).
  const r = await call('script.edit', { beat: 'b01', line: 'b01-1', words: 'A dot opens its eyes and becomes the logo.' });
  assert.deepEqual(r.changed, ['b01-1']);
  assert.deepEqual(r.remaking.map((x) => x.node).sort(), ['s01']);
  assert.equal(events('script.changed').length, 1);
  const work = join(root, 'projects', id);
  const beats = JSON.parse(readFileSync(join(work, 'script', 'beats.json'), 'utf8'));
  assert.equal(beats.beats[0].words, 'A dot opens its eyes and becomes the logo.');
  assert.equal(beats.beats[1].words, 'Three ideas, one per beat, each on its own colour.', 'other beats untouched');
  const voice = JSON.parse(readFileSync(join(work, 'voice', 'lines.json'), 'utf8'));
  assert.equal(voice[0].script, 'A dot opens its eyes and becomes the logo.');
  const busy = await call('script.get');
  assert.deepEqual(busy.beats[0].lines[0].remaking, { shots: 1, lines: 0 });
  assert.equal(busy.beats[0].lines[0].changed, true);
  assert.deepEqual(busy.beats[1].lines[0].remaking, { shots: 0, lines: 0 });
  const chat = await call('chat.history');
  assert.match(chat.at(-1).text, /Script: 1 line changed · remaking 1 shot$/);

  // The AI remakes the shot (demo): v2, the others stay v1; versions kept. The voice line shows words_changed.
  await run();
  const g1 = await call('graph.get');
  const node = (n) => g1.nodes.find((x) => x.id === n);
  assert.equal(node('s01').current, 2);
  assert.equal(node('s01').versions.length, 2);
  assert.equal(node('b01-1').current, 1);
  assert.equal((await call('voice.lines')).find((l) => l.node === 'b01-1').words_changed, true);
  assert.equal(node('s02').current, 1);
  assert.equal(node('b02-1').current, 1);
  assert.equal(node('b01').title, 'A dot opens its eyes and becomes the logo.');
  const after = await call('script.get');
  assert.deepEqual(after.beats[0].lines[0].remaking, { shots: 0, lines: 0 });

  // The voice line about to be deleted was OK'd: bringing it back keeps that OK.
  await call('node.edit', { node: 'b03-1', action: 'ok' });
  const s03 = (await call('graph.get')).nodes.find((x) => x.id === 's03');
  // A batch (the app's Save): rename a beat, add two lines (the second after the first, by key), delete one.
  const batch = await call('script.edit', { edits: [
    { beat: 'b02', beat_name: 'Three ideas' },
    { beat: 'b02', add_after: 'b02-1', words: 'Each one gets its own colour.', key: 'n1' },
    { beat: 'b02', add_after: 'n1', words: 'Then they line up.', key: 'n2' },
    { beat: 'b03', line: 'b03-1', delete: true },
  ] });
  assert.deepEqual(batch.added, ['b02-2', 'b02-3']);
  assert.deepEqual(batch.keys, { n1: 'b02-2', n2: 'b02-3' });
  assert.deepEqual(batch.deleted, ['b03-1']);
  const s2 = await call('script.get');
  assert.equal(s2.beats[1].name, 'Three ideas');
  assert.equal(s2.beats[1].name_auto, false);
  assert.deepEqual(s2.beats[1].lines.map((l) => l.id), ['b02-1', 'b02-2', 'b02-3']);
  assert.equal(s2.beats[2].lines.length, 0);
  assert.deepEqual(s2.beats[2].deleted.map((l) => [l.id, l.words, l.after]), [['b03-1', 'The ideas join into one picture.', null]], 'a deleted line is kept, with its words');
  const g2 = await call('graph.get');
  assert.equal(g2.nodes.find((x) => x.id === 'b03-1').owner, 'cut', 'a deleted line is not spoken');
  assert.ok(g2.nodes.find((x) => x.id === 'b02-2'), 'a new line is a voice line');
  // Undo the delete (after it was saved): the same line, its words and its voice line are back, nothing remade.
  const back = await call('script.edit', { beat: 'b03', line: 'b03-1', delete: false });
  assert.deepEqual(back.restored, ['b03-1']);
  assert.deepEqual(back.remaking, [], 'restoring remakes nothing');
  const s3 = await call('script.get');
  assert.deepEqual(s3.beats[2].lines.map((l) => [l.id, l.words]), [['b03-1', 'The ideas join into one picture.']]);
  assert.deepEqual(s3.beats[2].deleted, []);
  const g3 = await call('graph.get');
  const b031 = g3.nodes.find((x) => x.id === 'b03-1');
  assert.equal(b031.owner, 'ok', 'its OK is back too');
  const s03after = g3.nodes.find((x) => x.id === 's03');
  assert.equal(s03after.current, s03.current, 'its shot is the same version');
  assert.equal(s03after.pending, null, 'and is not being remade');
  // Bringing back a line that is there is a no-op.
  assert.deepEqual((await call('script.edit', { beat: 'b03', line: 'b03-1', delete: false })).restored, []);

  // Refusals: unknown beat or line, empty words.
  await assert.rejects(call('script.edit', { beat: 'b09', line: 'b09-1', words: 'x' }), /no scene b09/);
  await assert.rejects(call('script.edit', { beat: 'b01', line: 'b01-7', words: 'x' }), /no line b01-7/);
  await assert.rejects(call('script.edit', { beat: 'b01', line: 'b01-1', words: '  ' }), /empty/);
});

test('script: the app\'s unsaved changes are kept per project (a service restart, a switch) until saved', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  const root = tempStudio(t, { mfxQuestionsBlock: false }); // the brief goes on with its defaults (not what this tests)
  const { call, tick } = harness(t, root);
  const runner = new Runner(root);
  runner.acquire();
  t.after(() => runner.release());
  const made = await call('project.new', { preset: 'explainer', title: 'Draft', idea: 'Keep what I typed', backend: 'demo' });
  const id = made.project.id;
  await until(() => loadProject(root, id).state === 'queued');
  for (let i = 0; i < 3; i++) { await runner.loop(); await tick(); }
  assert.ok((await call('script.get')).beats.length);
  assert.equal((await call('script.get')).draft, null);
  const draft = { words: { 'b01-1': 'Not saved yet.' }, deleted: ['b02-1'], added: [], names: {}, nextKey: 0 };
  assert.equal((await call('script.draft', { draft })).saved, true);
  await assert.rejects(call('script.draft', { draft: [1] }), /object/);
  await assert.rejects(call('script.draft', { draft: { big: 'x'.repeat(300 * 1024) } }), /at most/);
  // a fresh service (a restart) hands it back
  const again = harness(t, root);
  await again.call('project.open', { id });
  const s = await again.call('script.get');
  assert.deepEqual(s.draft, draft);
  assert.ok(s.draft_at);
  // by project id too (the app flushes a draft for the project it is leaving)
  assert.deepEqual((await again.call('script.get', { project: id })).draft, draft);
  // saving clears it; null clears it too
  await again.call('script.edit', { beat: 'b01', line: 'b01-1', words: 'Not saved yet.' });
  assert.equal((await again.call('script.get')).draft, null);
  await again.call('script.draft', { draft });
  assert.equal((await again.call('script.draft', { draft: null })).cleared, true);
  assert.equal((await again.call('script.get')).draft, null);
});
