// MIDI ⇄ Strudel (doc 28): notes → text → notes is exact, the edit ladder writes the smallest exact change, and the
// evaluator is locked down. Needs Strudel installed (MFX_STRUDEL, or the studio's tools/strudel); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createStrudel } from '../src/strudel/edit.mjs';
import { createEvaluator } from '../src/strudel/evaluator.mjs';
import { notesToStrudel, notesToIdiomatic, sameNotes, sortNotes } from '../src/strudel/notes.mjs';

const dir = [process.env.MFX_STRUDEL, join(homedir(), 'Mortiflix', 'tools', 'strudel')].find((d) => d && existsSync(join(d, 'node_modules', '@strudel', 'core')));
const skip = dir ? false : 'Strudel is not installed';
const TPB = 3840;

// A small seeded random, so failures repeat.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function randomNotes(r, bars) {
  const grids = [240, 120, 320, 160, 480, 768];
  const out = [];
  for (let b = 0; b < bars; b++) {
    const g = grids[Math.floor(r() * grids.length)];
    for (let t = 0; t < TPB; t += g) {
      if (r() < 0.45) continue;
      const len = g * (1 + Math.floor(r() * 3));
      const chord = r() < 0.15 ? 3 : 1;
      const base = 36 + Math.floor(r() * 36);
      for (let c = 0; c < chord; c++) out.push({ t: b * TPB + t, len, key: base + c * 4, vel: Math.round((0.3 + r() * 0.7) * 1000) / 1000 });
    }
  }
  const seen = new Set();
  return sortNotes(out.filter((n) => { const k = `${n.t}|${n.key}`; if (seen.has(k)) return false; seen.add(k); return true; }));
}

test('notes → Strudel → notes is exact, both writers', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const r = rng(28);
  for (let i = 0; i < 60; i++) {
    const bars = 1 + Math.floor(r() * 4);
    const notes = randomNotes(r, bars);
    for (const write of [notesToStrudel, notesToIdiomatic]) {
      const code = write(notes, { bars });
      const got = await ev.run(code, { bars, tpb: TPB });
      assert.ok(got.ok, `${got.error}\n${code}`);
      assert.ok(sameNotes(got.notes, notes), `case ${i} not exact:\n${code}`);
    }
  }
});

test('the edit ladder: exact, and only the edited spot changes', { skip }, async (t) => {
  const s = createStrudel({ strudelDir: dir });
  t.after(() => s.close());
  const ai = 'note("<[d2 ~ d2 f2] [c2 ~ c2 e2] [g1 ~ g1 a1] [d2 d2 f2 a2]>").velocity(.8)';

  // in place: a word only one note uses
  let { notes } = await s.notes(ai, { bars: 4 });
  let r = await s.edit(ai, notes.map((n, i) => (i === notes.length - 1 ? { ...n, key: 48 } : n)), { bars: 4 });
  assert.equal(r.level, 'in place');
  assert.equal(r.code, ai.replace('a2]', 'c3]'));

  // arrangement: "a2" plays in bars 4 and 8, so the original stays word for word and bar 8 is hard-coded at that spot
  ({ notes } = await s.notes(ai, { bars: 8 }));
  r = await s.edit(ai, notes.map((n, i) => (i === notes.length - 1 ? { ...n, key: 48 } : n)), { bars: 8 });
  assert.equal(r.level, 'arrangement');
  assert.equal(r.code, `arrange(\n  [7, ${ai}],\n  [1, note("d2!2 f2 c3")]\n)`);
  // a second edit inside those bars rewrites only that hard-coded section; a sound ending stays outside arrange()
  const again = await s.edit(r.code, r.notes.map((n) => (n.t === 7 * TPB ? { ...n, vel: 0.5 } : n)), { bars: 8 });
  assert.equal(again.code, r.code.replace('note("d2!2 f2 c3")', '"d2:.5 d2:.8 f2:.8 c3:.8".as("note:velocity")'));
  const lead = 'note("<[d2 ~ d2 f2] [c2 ~ c2 e2]>").s("sawtooth").lpf(800)';
  ({ notes } = await s.notes(lead, { bars: 8 }));
  r = await s.edit(lead, notes.map((n) => (n.t === 2 * TPB + 3 * 960 ? { ...n, key: n.key + 2 } : n)), { bars: 8 });
  assert.equal(r.code, 'arrange(\n  [2, note("<[d2 ~ d2 f2] [c2 ~ c2 e2]>")],\n  [1, note("d2 ~ d2 g2")],\n  [5, note("<[d2 ~ d2 f2] [c2 ~ c2 e2]>").early(3)]\n).s("sawtooth").lpf(800)');

  // bar lines: one line per bar, so an edit in bar 2 changes line 3 and nothing else
  const lpb = '`<\n  [d2:.8 ~ d2:.6 f2:.7]\n  [c2:.8@3 e2:.7]\n>`.as("note:velocity")';
  ({ notes } = await s.notes(lpb, { bars: 2 }));
  r = await s.edit(lpb, notes.map((n) => (n.t === TPB ? { ...n, len: 960 } : n)), { bars: 2 });
  assert.equal(r.level, 'bar lines');
  assert.equal(r.code, lpb.replace('[c2:.8@3 e2:.7]', '[c2:.8 ~@2 e2:.7]'));
});

test('random edits on three styles of text come back exact', { skip }, async (t) => {
  const s = createStrudel({ strudelDir: dir });
  t.after(() => s.close());
  const r = rng(7);
  const texts = [
    'note("<[d2 ~ d2 f2] [c2 ~ c2 e2] [g1 ~ g1 a1] [d2 d2 f2 a2]>").velocity(.8)',
    'n("0 2 4 7".add("<0 3 5 3>")).scale("D3:dorian").sometimesBy(.3, (x) => x.velocity(.5)).velocity(.8)',
    notesToStrudel(randomNotes(rng(3), 4), { bars: 4 }),
  ];
  for (let i = 0; i < 45; i++) {
    let code = texts[i % 3];
    const { notes } = await s.notes(code, { bars: 4 });
    const n = [...notes];
    const k = Math.floor(r() * n.length);
    const kind = Math.floor(r() * 5);
    if (kind === 0) n[k] = { ...n[k], key: n[k].key + 1 + Math.floor(r() * 5) };
    else if (kind === 1) n[k] = { ...n[k], vel: Math.round(r() * 1000) / 1000 || 0.1 };
    else if (kind === 2) n[k] = { ...n[k], t: Math.min(4 * TPB - 240, n[k].t + 240) };
    else if (kind === 3) n.splice(k, 1);
    else n.push({ t: Math.floor(r() * 16) * 960, len: 480, key: 50, vel: 0.7 });
    const res = await s.edit(code, n, { bars: 4 });
    assert.ok(sameNotes(res.notes, n), `edit ${i} (${res.level}) not exact`);
    code = res.code;
  }
});

test('the evaluator is locked down and survives an endless loop', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir, timeoutMs: 1500 });
  t.after(() => ev.close());
  for (const code of [
    "process.getBuiltinModule('fs').readFileSync('/etc/hostname', 'utf8')",
    "process.getBuiltinModule('fs').writeFileSync('/tmp/mfx-strudel-test', 'x')",
    "process.getBuiltinModule('child_process').execSync('id')",
  ]) {
    const r = await ev.run(code, { bars: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /restricted|permission/i);
  }
  await assert.rejects(ev.run('(() => { while (true) {} })() || note("c3")', { bars: 1 }), /longer than/);
  const r = await ev.run('note("c3 e3")', { bars: 1 });
  assert.deepEqual(r.notes.map((n) => n.key), [48, 52]);
});

test('Node reads a score the way the REPL in Chrome does (doc 28 M1): $: and labelled blocks, mute, setcpm, strings, drums', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const fx = join(import.meta.dirname, 'fixtures', 'strudel-parity');
  const chrome = JSON.parse(readFileSync(join(fx, 'chrome.json'), 'utf8'));
  const r = await ev.run(readFileSync(join(fx, 'score.strudel.js'), 'utf8'), { bars: 5, mode: 'haps', ms: 20000 });
  assert.ok(r.ok, r.error);
  // the same events with the same values, in the same order Chrome's were saved
  const got = r.haps.map((h) => ({ begin: h.begin, end: h.end, value: h.value })).sort((x, y) => x.begin - y.begin || JSON.stringify(x.value).localeCompare(JSON.stringify(y.value)));
  assert.equal(r.cps, chrome.cps);
  assert.deepEqual(got, chrome.haps);
  // each $: line is its own block, numbered in text order; the muted one is left out
  assert.deepEqual([...new Set(r.haps.map((h) => h.block))].sort(), [0, 1, 2, 3, 5]);
});

test('an app prelude and its data run before the score (Mortiflix Music voice() / guide())', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const prelude = 'function guide(name) { return note(window.mfxLines[name]) }';
  const r = await ev.run("$: guide('Lead').midichan(4)", { bars: 1, prelude, globals: { mfxLines: { Lead: 'c4 e4 g4' } } });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.notes.map((n) => n.key), [60, 64, 67]);
  const bad = await ev.run("$: guide('Lead')", { bars: 1 });
  assert.equal(bad.ok, false);
});
