// Stage 2 Look (look.get / look.use / look.more) on the demo backend: the looks with their pictures, palette and fonts,
// the one in use; picking another asks first when shots exist, then remakes only those shots in the new look; more
// looks arrive as new frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { Runner } from '../src/runner.mjs';
import { loadProject } from '../src/projects.mjs';

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

test('look: the looks to pick from, pick another (asks first, remakes only the shots made in the old look), make more', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  const root = tempStudio(t, { mfxQuestionsBlock: false }); // the brief goes on with its defaults (not what this tests)
  const { call, events, tick } = harness(t, root);
  const runner = new Runner(root);
  runner.acquire();
  t.after(() => runner.release());
  const run = async () => { await runner.loop(); await tick(); };

  await assert.rejects(call('look.get'), /no_project/);
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

  const v = await call('look.get');
  assert.equal(v.frames.length, 4);
  assert.equal(v.using, 'sf01', 'the first look until one is picked');
  const f1 = v.frames[0];
  assert.equal(f1.name, 'Ember night');
  assert.ok(existsSync(f1.path) && f1.path.endsWith('.svg'), 'its picture, for the app to draw');
  assert.ok(f1.palette.length >= 2 && f1.palette.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  assert.deepEqual(f1.fonts, ['sans-serif']);
  assert.equal(v.shots.length, 4);
  assert.ok(v.shots.every((s) => s.made && s.look === 'sf01' && !s.changed));
  assert.ok(v.can_more);
  // the chat's looks card: the pictures, the names, the one in use
  const card = (await call('chat.history', { limit: 200 })).find((r) => r.card?.kind === 'looks');
  assert.match(card.text, /4 looks from the script: style samples \(colours, characters, type\), not the shots\. I'm using Ember night/);
  assert.deepEqual(card.card.frames.map((f) => f.name), ['Ember night', 'Cold neon', 'Olive and gold', 'Plum pop']);
  assert.ok(card.card.frames.every((f) => existsSync(f.path)));
  assert.equal(card.card.using, 'sf01');

  // Pick another look: shots exist, so nothing changes yet; the answer lists what would be remade.
  const ask = await call('look.use', { frame: 'sf02' });
  assert.equal(ask.needs_confirm, true);
  assert.deepEqual(ask.remake.map((s) => s.id), ['s01', 's02', 's03', 's04']);
  assert.equal(ask.remake[0].beat_no, 1);
  assert.equal((await call('look.get')).using, 'sf01', 'not changed before the owner confirms');
  assert.equal(events('look.changed').length, 0);
  // Confirmed: the look is in use, every shot gets a Fix in it and is marked changed until it's remade.
  const yes = await call('look.use', { frame: 'sf02', confirm: true });
  assert.equal(yes.using, 'sf02');
  assert.deepEqual(yes.remaking.map((x) => x.node), ['s01', 's02', 's03', 's04']);
  const v2 = await call('look.get');
  assert.equal(v2.using, 'sf02');
  assert.ok(v2.shots.every((s) => s.changed && s.changed_from === 'sf01' && s.remaking && s.look === 'sf02'));
  assert.equal(events('look.changed').at(-1).using, 'sf02');
  assert.match((await call('chat.history')).at(-1).text, /Look: now Cold neon · remaking 4 shots in it/);
  const work = join(root, 'projects', id);
  assert.equal(JSON.parse(readFileSync(join(work, 'design', 'frames.json'), 'utf8')).using, 'sf02', 'the session reads which look is in use');
  // The AI remakes them (demo): v2 each, no longer marked changed.
  await run();
  const v3 = await call('look.get');
  assert.ok(v3.shots.every((s) => !s.changed && !s.remaking));
  const g = await call('graph.get');
  assert.ok(['s01', 's02', 's03', 's04'].every((s) => g.nodes.find((n) => n.id === s).current === 2));
  // Picking the look in use again: nothing to do.
  assert.equal((await call('look.use', { frame: 'sf02' })).changed, false);
  // The chat's looks card says which look is in use.
  assert.ok(v3.frames.every((f) => f.path));

  // Make more looks: two new frames, made by the next session, then pickable.
  const more = await call('look.more', {});
  assert.deepEqual(more.making.map((x) => x.node), ['sf05', 'sf06']);
  const v4 = await call('look.get');
  assert.equal(v4.frames.length, 6);
  assert.ok(v4.frames.slice(4).every((f) => f.making && !f.path));
  await assert.rejects(call('look.use', { frame: 'sf05' }), /isn't made yet/);
  await run();
  const v5 = await call('look.get');
  assert.equal(v5.frames.length, 6);
  const f5 = v5.frames.find((f) => f.id === 'sf05');
  assert.ok(!f5.making && f5.path && f5.palette.length === 2, 'made, with its palette');
  assert.deepEqual(f5.fonts, ['serif']);
  await call('look.more', { count: 3 });
  await assert.rejects(call('look.more', {}), /8 looks is the most/);

  // A frame without a palette in frames.json: the colours and fonts its SVG uses.
  const fj = JSON.parse(readFileSync(join(work, 'design', 'frames.json'), 'utf8'));
  delete fj.frames[0].palette;
  delete fj.frames[0].fonts;
  writeFileSync(join(work, 'design', 'frames.json'), JSON.stringify(fj));
  const v6 = await call('look.get');
  assert.ok(v6.frames[0].palette.includes('#ffffff'), v6.frames[0].palette.join());
  assert.deepEqual(v6.frames[0].fonts, ['sans-serif']);

  // Refusals: an unknown look.
  await assert.rejects(call('look.use', { frame: 'sf99' }), /no look sf99/);
});
