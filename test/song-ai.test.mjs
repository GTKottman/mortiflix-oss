// The AI in the loop (doc 26 I1–I5): what a session reads and writes through `mfx song`, locks lifted only by an edit
// request's bars, writes based on an old read refused, the AI's notes held to the harmony, and edit done only once
// the cue has a new version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, cpSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createProject } from '../src/projects.mjs';
import { songPaths, loadSong, importProjectSong } from '../src/song-store.mjs';
import { applyOps, noteName, closeLadder } from '../src/song-ops.mjs';
import * as ai from '../src/song-ai.mjs';
import { nodeAction, finishEdit, syncCanvas } from '../src/canvas.mjs';

const dir = [process.env.MFX_STRUDEL, join(homedir(), 'Mortiflix', 'tools', 'strudel')].find((d) => d && existsSync(join(d, 'node_modules', '@strudel', 'core')));
const skip = dir ? false : 'Strudel is not installed';

async function songProject(t) {
  process.env.MFX_STRUDEL = dir;
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'AI', answers: { topic: 'tides' } });
  const sp = songPaths(root, p.id);
  for (const f of ['blueprint.json', 'notes.json', 'instruments.json', 'score.strudel.js']) cpSync(join(import.meta.dirname, 'fixtures', 'songs', 'four', f), join(sp.music, f));
  await importProjectSong(root, p.id);
  syncCanvas(root, p.id);
  t.after(() => closeLadder());
  return { root, id: p.id };
}

test('mfx song / show / strudel: sections, parts, locks, the notes as a table, the rows exactly', { skip }, async (t) => {
  const { root, id } = await songProject(t);
  const s = ai.songSummary(root, id);
  assert.deepEqual(s.sections, [{ id: 'm01', name: 'Cold open', bars: '1–4' }, { id: 'm02', name: 'The bet', bars: '5–8' }]);
  assert.deepEqual(s.parts.map((p) => [p.id, p.name, p.plays]), [['ch02', 'Bass', 'its Strudel sound'], ['ch03', 'Keys', 'its Strudel sound'], ['ch10', 'Drums', 'its Strudel sound']]);
  const show = ai.songShow(root, id, { section: 'm02', part: 'ch02', bars: [4, 4] });
  assert.deepEqual(show.notes.map((n) => [n.bar, n.beat, n.key, n.len, n.vel]), [[4, 1, 'D2', '1/4', 0.8], [4, 2, 'D2', '1/4', 0.6], [4, 3, 'F2', '1/4', 0.8], [4, 4, 'A2', '1/4', 0.6]]);
  assert.equal(show.song_bars, '5–8');
  const rows = ai.songStrudel(root, id, { section: 'm02', part: 'ch02' }).rows;
  assert.equal(rows.length, 1);
  assert.match(rows[0].strudel, /\[d2:\.8 d2:\.6 f2:\.8 a2:\.6\]/);
});

test('locks: refused without an edit request, lifted by one only inside its bars; rev: the owner\'s change in between is caught', { skip }, async (t) => {
  const { root, id } = await songProject(t);
  // the owner hand-edits bar 3 of m02's bass: a lock L001 over bar 3
  const n = loadSong(root, id).song.patterns[1].notes.ch02.find((x) => x.t >= 7680 && x.t < 11520);
  await applyOps(root, id, [{ op: 'note.set', pattern: 'm02', channel: 'ch02', ids: [noteName(n)], fields: { vel: 0.5 } }]);
  const rev = ai.songShow(root, id, { section: 'm02' }).rev;
  const bar3 = [{ bar: 3, beat: 1, key: 'G1', len: '1/2', vel: 0.9 }];
  await assert.rejects(ai.songWriteNotes(root, id, { section: 'm02', part: 'ch02', bars: [3, 3], notes: bar3, rev }), /m02 Bass bars 3–3 are hand-edited \(L001\)/);
  const { edit } = nodeAction(root, id, 'm02', { action: 'fix', text: 'make bar 3 land harder', bars: [3, 4], part: 'ch02' });
  assert.deepEqual([edit.bars, edit.part], [[3, 4], 'ch02']);
  const done = await ai.songWriteNotes(root, id, { section: 'm02', part: 'ch02', bars: [3, 3], notes: bar3, edit: edit.id, rev });
  assert.deepEqual(done.changed, ['m02.ch02']);
  await assert.rejects(ai.songWriteNotes(root, id, { section: 'm02', part: 'ch02', bars: [1, 1], notes: [], edit: edit.id, rev: done.rev }), /E001 covers bars 3–4 of m02: write inside them/);
  // the owner edits m02's bass again after the session read it: the session's next write is refused
  const n2 = loadSong(root, id).song.patterns[1].notes.ch02.find((x) => x.t >= 11520);
  await applyOps(root, id, [{ op: 'note.set', pattern: 'm02', channel: 'ch02', ids: [noteName(n2)], fields: { vel: 0.4 } }]);
  await assert.rejects(ai.songWriteNotes(root, id, { section: 'm02', part: 'ch02', bars: [4, 4], notes: [], edit: edit.id, rev: done.rev }), /the owner changed m02 Bass while you worked/);
  // a write to another part goes through
  const ok = await ai.songWriteNotes(root, id, { section: 'm01', part: 'ch03', bars: [2, 2], notes: [{ bar: 2, beat: 2, key: 'A3', len: '1/8' }], rev: done.rev });
  assert.deepEqual(ok.changed, ['m01.ch03']);
});

test('harmony: an AI note outside the chart and key is refused with where; the same note by hand is kept', { skip }, async (t) => {
  const { root, id } = await songProject(t);
  const sharp = [{ bar: 1, beat: 1, key: 'F#2', len: '1/4' }];   // F# over Dm7 in D dorian
  await assert.rejects(ai.songWriteNotes(root, id, { section: 'm01', part: 'ch02', bars: [1, 1], notes: sharp }), /the notes leave the harmony: .*F#2 at bar 1 beat 1 over Dm7/);
  assert.ok(!loadSong(root, id).song.patterns[0].notes.ch02.some((n) => n.key === 42), 'nothing of the refused write stayed');
  const r = await applyOps(root, id, [{ op: 'note.add', pattern: 'm01', channel: 'ch02', notes: [{ t: 480, len: 240, key: 42 }] }]);
  assert.equal(r.applied.length, 1, 'the owner has complete control');
});

test('edit done only after the cue has a new version; a Strudel write for the bars is kept word for word', { skip }, async (t) => {
  const { root, id } = await songProject(t);
  const { edit } = nodeAction(root, id, 'm02', { action: 'fix', text: 'walk the bass up', bars: [4, 4], part: 'ch02' });
  assert.throws(() => finishEdit(root, id, edit.id, { ok: true, note: 'did it' }), /new version|hasn't changed|no new/i);
  const code = 'note("d2 f2 a2 c3")';   // Dm7's own notes: the harmony check passes
  const r = await ai.songWriteStrudel(root, id, { section: 'm02', part: 'ch02', bars: [4, 4], code, edit: edit.id });
  assert.deepEqual(r.changed, ['m02.ch02']);
  const row = ai.songStrudel(root, id, { section: 'm02', part: 'ch02' }).rows[0].strudel;
  assert.match(row, /arrange\(/);
  assert.ok(row.includes(code), 'the session\'s own Strudel is in the row as written');
  syncCanvas(root, id);
  const f = finishEdit(root, id, edit.id, { ok: true, note: 'bass walks up into bar 4' });
  assert.equal(f.state ?? f.edit?.state ?? 'done', 'done');
});

test('mfx song through the bridge, as a session runs it', { skip }, async (t) => {
  const { root, id } = await songProject(t);
  const { openBridge } = await import('../src/bridge.mjs');
  const { main } = await import('../src/mfx.mjs');
  const work = songPaths(root, id).music.replace(/\/music$/, '');
  const b = await openBridge({ root, projectId: id, sessionId: 's1', workdir: work, renders: { add() {}, wait() {}, activeFor: () => [] }, sessionEnv: {} });
  t.after(() => b.close());
  const env = { ...process.env, ...b.env };
  const summary = await main(['song'], env, work);
  assert.equal(summary.sections.length, 2);
  const cwd = mkdtempSync(join(tmpdir(), 'mfx-session-'));
  writeFileSync(join(cwd, 'bars.json'), JSON.stringify([{ bar: 2, beat: 1, key: 'C2', len: '1/2', vel: 0.9 }, { bar: 2, beat: 3, key: 'E2', len: '1/2' }]));
  const w = await main(['song', 'notes', 'm01', 'ch02', '--bars', '2', '--file', 'bars.json'], env, cwd);
  assert.deepEqual(w.changed, ['m01.ch02']);
  const shown = await main(['song', 'show', 'm01', '--part', 'ch02', '--bars', '2'], env, cwd);
  assert.deepEqual(shown.notes.map((n) => [n.key, n.len]), [['C2', '1/2'], ['E2', '1/2']]);
});

test('the demo backend fixes bars 7–8 end to end: Fix → session → notes changed in those bars only → done, new cue version', { skip }, async (t) => {
  process.env.MFX_STRUDEL = dir;
  const { startProject } = await import('../src/projects.mjs');
  const { respond } = await import('../src/gates.mjs');
  const { Runner } = await import('../src/runner.mjs');
  const { loadEdits } = await import('../src/canvas.mjs');
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Demo fix', answers: { topic: 'tides' } });
  startProject(root, p.id);
  const { setBrief } = await import('../src/svc/lookbrief.mjs');
  const { setMotionBrief, setTransitionBrief } = await import('../src/svc/motionbrief.mjs');
  setBrief(root, p.id, { vibe: 'calm', font: 'Inter' }); // the owner picks a look before the style frames
  setMotionBrief(root, p.id, {}); // and leaves the motion to the AI before the animatic
  setTransitionBrief(root, p.id, {}); // and the transitions to the library
  const runner = new Runner(root);
  runner.acquire();
  t.after(() => { runner.release(); closeLadder(); });
  await runner.loop();
  // the music is written once every gate before it is passed
  for (const step of ['brief', 'script', 'voice', 'style-frames', 'transitions', 'animatic']) {
    respond(root, p.id, step, 1, { verdict: 'approve' });
    await runner.loop();
  }
  const before = loadSong(root, p.id).song;
  const cueV = syncCanvas(root, p.id).nodes.m04.versions.length;
  // bars 7–8 of the song are bars 1–2 of m04
  const { edit } = nodeAction(root, p.id, 'm04', { action: 'fix', text: 'lift the ending', bars: [1, 2] });
  await runner.loop();
  const e = loadEdits(root, p.id).find((x) => x.id === edit.id);
  assert.equal(e.state, 'done', e.note);
  const after = loadSong(root, p.id).song;
  assert.notDeepEqual(after.patterns.find((x) => x.id === 'm04').notes, before.patterns.find((x) => x.id === 'm04').notes);
  for (const id of ['m01', 'm02', 'm03']) assert.deepEqual(after.patterns.find((x) => x.id === id).notes, before.patterns.find((x) => x.id === id).notes, `${id} untouched`);
  assert.equal(syncCanvas(root, p.id).nodes.m04.versions.length, cueV + 1, 'the cue has a new version');
});

test('Fix, fast (doc 28 M10): the demo answers the marked bars as Strudel, checked and put in; done at once, no session', { skip }, async (t) => {
  process.env.MFX_STRUDEL = dir;
  const { runFastFix } = await import('../src/song-fix.mjs');
  const { buildFixPrompt, parseReply } = await import('../src/strudel/fix.mjs');
  const { loadEdits } = await import('../src/canvas.mjs');
  const { root, id } = await songProject(t);
  const { edit } = nodeAction(root, id, 'm02', { action: 'fix', text: 'lift it', bars: [3, 4], part: 'ch03' });
  // the prompt: plain words and the rows as they are; the reply format the reader takes
  const { song, text } = loadSong(root, id);
  const pr = buildFixPrompt(song, text, edit, { blueprint: { chart: [{ bars: [1, 8], chords: ['Dm7', 'Am7', 'Gm7', 'Dm7'] }] } });
  assert.match(pr.user, /Rewrite m02 "The bet" bars 3-4 \(song bars 7-8\) for Keys only/);
  assert.match(pr.user, /Owner's words: lift it/);
  assert.match(pr.user, /Chords, song bars 6-8: Am7 \| Gm7 \| Dm7/);
  assert.match(pr.user, /\/\/ begin m02 ch03 bars 3-4\n\/\/ end m02 ch03/);
  assert.doesNotMatch(pr.system + pr.user, /mfx/);
  assert.throws(() => parseReply('// begin m02 ch02 bars 3-4\nnote("c3")\n// end m02 ch02', pr.asked), /wasn't asked for/);
  assert.throws(() => parseReply('// begin m02 ch03 bars 3-4\nnote("c3").s("piano")\n// end m02 ch03', pr.asked), /notes only/);
  const before = loadSong(root, id).song;
  const r = await runFastFix(root, id, edit.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = loadEdits(root, id).find((x) => x.id === edit.id);
  assert.deepEqual([e.state, e.via], ['done', 'fast']);
  const after = loadSong(root, id).song;
  const keysIn = (s, a, b) => (s.patterns[1].notes.ch03 || []).filter((n) => n.t >= (a - 1) * 3840 && n.t < b * 3840);
  assert.notDeepEqual(keysIn(after, 3, 4), keysIn(before, 3, 4), 'bars 3–4 changed');
  assert.deepEqual(keysIn(after, 1, 2), keysIn(before, 1, 2), 'bars 1–2 kept');
  assert.deepEqual(after.patterns[1].notes.ch02, before.patterns[1].notes.ch02, 'other parts kept');
  assert.ok(r.ms < 5000, `${r.ms} ms`);
});
