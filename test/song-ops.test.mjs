// Song operations (doc 18 S3, doc 28 M7): note edits become plain-Strudel text edits through the ladder, hand edits
// lock their bars, the AI is refused inside locks (by name) and goes through elsewhere, undo gives the text back byte
// for byte, and a batch with an error changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createProject } from '../src/projects.mjs';
import { songPaths, loadSong, importProjectSong } from '../src/song-store.mjs';
import { applyOps, undo, noteName, closeLadder } from '../src/song-ops.mjs';
import { songNotes } from '../src/strudel/songfile.mjs';
import { createEvaluator } from '../src/strudel/evaluator.mjs';

const dir = [process.env.MFX_STRUDEL, join(homedir(), 'Mortiflix', 'tools', 'strudel')].find((d) => d && existsSync(join(d, 'node_modules', '@strudel', 'core')));
const skip = dir ? false : 'Strudel is not installed';

async function songProject(t) {
  process.env.MFX_STRUDEL = dir;
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Ops', answers: { topic: 'tides' } });
  const sp = songPaths(root, p.id);
  for (const f of ['blueprint.json', 'notes.json', 'instruments.json', 'score.strudel.js']) cpSync(join(import.meta.dirname, 'fixtures', 'songs', 'four', f), join(sp.music, f));
  await importProjectSong(root, p.id);
  t.after(() => closeLadder());
  return { root, id: p.id, sp };
}

// The song's notes must be what its text plays, after every change.
async function textMatchesNotes(t, root, id) {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const { song, text } = loadSong(root, id);
  const got = await songNotes(ev, text, song.patterns.map((p) => ({ id: p.id, bars: p.bars })), { drumChannels: [10] });
  const full = (ns) => (ns || []).map((n) => ({ vel: 0.8, ...n }));
  for (const p of song.patterns) for (const c of song.channels) assert.deepEqual(full(got.parts[c.midiChannel][p.id]), full(p.notes[c.id]), `${p.id} ${c.id}`);
}

test('a hand note edit: a plain-Strudel edit of that row, its bars locked; the text still plays the notes', { skip }, async (t) => {
  const { root, id } = await songProject(t);
  const before = loadSong(root, id);
  const bass = before.song.patterns[1].notes.ch02;
  const target = bass.find((n) => n.t >= 3840 && n.t < 7680);   // a note in bar 2 of m02 (song bar 6)
  const r = await applyOps(root, id, [{ op: 'note.set', pattern: 'm02', channel: 'ch02', ids: [noteName(target)], fields: { key: target.key + 2 } }]);
  assert.equal(r.refused.length, 0);
  const after = loadSong(root, id);
  assert.equal(after.song.rev, before.song.rev + 1);
  assert.ok(after.song.patterns[1].notes.ch02.some((n) => n.t === target.t && n.key === target.key + 2));
  assert.deepEqual(after.song.patterns[0].notes, before.song.patterns[0].notes, 'm01 untouched');
  assert.doesNotMatch(after.text, /mfx/);
  // only the bass row of m02 changed in the file
  const a = before.text.split('\n'); const b = after.text.split('\n');
  const changed = b.filter((l) => !a.includes(l));
  assert.ok(changed.length >= 1 && changed.every((l) => /arrange|\[\d+,|note\(|early|\)\]?,?$/.test(l) || l.trim().startsWith('[')), changed.join('\n'));
  assert.equal(after.text.split('// ch03')[1], before.text.split('// ch03')[1], 'the keys and drums parts are byte for byte the same');
  assert.deepEqual(after.song.locks.map((l) => [l.by, l.scope.pattern, l.scope.channel, l.scope.fromTick, l.scope.toTick]), [['hand', 'm02', 'ch02', 3840, 7680]]);
  await textMatchesNotes(t, root, id);
});

test('the AI is refused inside a lock (named) and goes through outside it; a hand edit always applies', { skip }, async (t) => {
  const { root, id } = await songProject(t);
  const s0 = loadSong(root, id).song;
  const inBar2 = s0.patterns[1].notes.ch02.find((n) => n.t >= 3840 && n.t < 7680);
  await applyOps(root, id, [{ op: 'note.set', pattern: 'm02', channel: 'ch02', ids: [noteName(inBar2)], fields: { key: inBar2.key + 1 } }]);
  const s1 = loadSong(root, id).song;
  const locked = s1.patterns[1].notes.ch02.find((n) => n.t >= 3840 && n.t < 7680);
  const free = s1.patterns[1].notes.ch02.find((n) => n.t < 3840);
  const r = await applyOps(root, id, [
    { op: 'note.set', pattern: 'm02', channel: 'ch02', ids: [noteName(locked)], fields: { vel: 0.3 }, by: 'ai' },
    { op: 'note.set', pattern: 'm02', channel: 'ch02', ids: [noteName(free)], fields: { vel: 0.3 }, by: 'ai' },
  ]);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].why, /m02 Bass bars 2–2 are hand-edited \(L001\)/);
  assert.equal(r.applied.length, 1);
  const s2 = loadSong(root, id).song;
  assert.ok(s2.patterns[1].notes.ch02.find((n) => n.t === free.t && n.key === free.key).vel === 0.3);
  assert.equal(s2.locks.length, 1, 'an AI edit adds no lock');
  // OK locks the whole pattern: then the AI is refused anywhere in it
  await applyOps(root, id, [{ op: 'lock.add', scope: { pattern: 'm01' }, lockBy: 'ok' }]);
  const n0 = s2.patterns[0].notes.ch03[0];
  const r2 = await applyOps(root, id, [{ op: 'note.del', pattern: 'm01', channel: 'ch03', ids: [noteName(n0)], by: 'ai' }]);
  assert.match(r2.refused[0].why, /were OK'd \(L002\)/);
  // a Fix lifts the named lock for that edit only
  const r3 = await applyOps(root, id, [{ op: 'note.del', pattern: 'm01', channel: 'ch03', ids: [noteName(n0)], by: 'ai', unlock: ['L002'] }]);
  assert.equal(r3.applied.length, 1);
  await textMatchesNotes(t, root, id);
});

test('undo gives the text back byte for byte and removes the lock; a bad batch changes nothing', { skip }, async (t) => {
  const { root, id, sp } = await songProject(t);
  const start = readFileSync(sp.strudel, 'utf8');
  const s0 = loadSong(root, id).song;
  const n = s0.patterns[0].notes.ch02[0];
  await applyOps(root, id, [{ op: 'note.set', pattern: 'm01', channel: 'ch02', ids: [noteName(n)], fields: { key: n.key + 5 } }, { op: 'channel.set', id: 'ch02', fields: { name: 'Sub bass' } }]);
  assert.notEqual(readFileSync(sp.strudel, 'utf8'), start);
  assert.equal(loadSong(root, id).song.channels[0].name, 'Sub bass');
  await undo(root, id);
  assert.equal(readFileSync(sp.strudel, 'utf8'), start, 'the Strudel text is back byte for byte');
  const s1 = loadSong(root, id).song;
  assert.equal(s1.channels[0].name, 'Bass');
  assert.deepEqual(s1.locks, []);
  assert.deepEqual(s1.patterns, s0.patterns);
  await assert.rejects(applyOps(root, id, [{ op: 'channel.set', id: 'ch02', fields: { name: 'X' } }, { op: 'note.set', pattern: 'm01', channel: 'ch02', ids: ['1:2:3'], fields: { key: 1 } }]), /has no note 1:2:3/);
  assert.equal(loadSong(root, id).song.channels[0].name, 'Bass', 'nothing of the failed batch was saved');
});

test('versions: the import is v1; going back makes a new version equal to the old one; blobs are not copied', { skip }, async (t) => {
  const { root, id, sp } = await songProject(t);
  const { listVersions, makeVersion, goBackTo } = await import('../src/song-store.mjs');
  const { readdirSync, mkdirSync, writeFileSync } = await import('node:fs');
  assert.deepEqual(listVersions(root, id).map((v) => [v.v, v.by]), [[1, 'import']]);
  const v1text = readFileSync(sp.strudel, 'utf8');
  const v1song = loadSong(root, id).song;
  mkdirSync(sp.blobs, { recursive: true });
  writeFileSync(join(sp.blobs, 'ab'.repeat(32) + '.bin'), 'state');
  for (let k = 0; k < 3; k++) {
    const s = loadSong(root, id).song;
    const n = s.patterns[0].notes.ch02[0];
    await applyOps(root, id, [{ op: 'note.set', pattern: 'm01', channel: 'ch02', ids: [noteName(n)], fields: { key: n.key + 1 } }]);
    makeVersion(root, id, { by: 'hand', why: `edit ${k + 1}` });
  }
  assert.deepEqual(listVersions(root, id).map((v) => v.v), [1, 2, 3, 4]);
  const back = goBackTo(root, id, 1);
  assert.equal(back.v, 5);
  assert.equal(back.why, 'went back to v1');
  assert.equal(readFileSync(sp.strudel, 'utf8'), v1text);
  const now = loadSong(root, id).song;
  assert.deepEqual(now.patterns, v1song.patterns);
  assert.ok(now.rev > v1song.rev, 'rev keeps counting');
  assert.deepEqual(readdirSync(sp.versions).filter((f) => f.endsWith('.bin')), [], 'blobs stay shared');
  assert.equal(readdirSync(sp.blobs).length, 1);
});

test('the canvas reads its cues from the song: a note edit in m02 makes cue m02 v2; a removed pattern leaves a missing cue', { skip }, async (t) => {
  const { root, id, sp } = await songProject(t);
  const { syncCanvas } = await import('../src/canvas.mjs');
  const { writeFileSync } = await import('node:fs');
  let g = syncCanvas(root, id);
  assert.deepEqual(g.order.cues, ['m01', 'm02']);
  assert.deepEqual([g.nodes.m02.title, g.nodes.m02.bars, g.nodes.m02.versions.length], ['The bet', [5, 8], 1]);
  const n = loadSong(root, id).song.patterns[1].notes.ch02[0];
  await applyOps(root, id, [{ op: 'note.set', pattern: 'm02', channel: 'ch02', ids: [noteName(n)], fields: { key: n.key - 1 } }]);
  g = syncCanvas(root, id);
  assert.equal(g.nodes.m02.versions.length, 2, 'a note edit is a new version of the cue');
  assert.equal(g.nodes.m01.versions.length, 1);
  // a pattern gone from the song: its cue stays, marked missing
  const s = JSON.parse(readFileSync(sp.song, 'utf8'));
  s.playlist.items = s.playlist.items.filter((x) => x.ref !== 'm02');
  s.patterns = s.patterns.filter((x) => x.id !== 'm02');
  writeFileSync(sp.song, JSON.stringify(s));
  g = syncCanvas(root, id);
  assert.equal(g.nodes.m02.missing, true);
  assert.deepEqual(g.order.cues, ['m01']);
});

test('Cut it, Repeat, + bars: every part\'s row in plain Strudel, later sections move, undo gives the same song', { skip }, async (t) => {
  const { root, id, sp } = await songProject(t);
  const start = loadSong(root, id);
  // Cut it on song bars 7–8 = bars 3–4 of m02: m02 becomes 2 bars, nothing after it in this song
  await applyOps(root, id, [{ op: 'section.time', section: 'm02', kind: 'cut', from: 3, to: 4 }]);
  let s = loadSong(root, id);
  assert.equal(s.song.patterns[1].bars, 2);
  assert.equal(s.song.playlist.items.find((i) => i.ref === 'm02').len, 2 * 3840);
  assert.ok(Object.values(s.song.patterns[1].notes).flat().every((n) => n.t < 2 * 3840), 'no notes left in the cut bars');
  assert.match(s.text, /\[2, /);
  assert.match(s.text, /m02 · The bet · bars 5–6/);
  assert.doesNotMatch(s.text, /mfx/);
  await textMatchesNotes(t, root, id);
  await undo(root, id);
  s = loadSong(root, id);
  assert.equal(s.text, start.text, 'undo: the text byte for byte');
  assert.deepEqual(s.song.patterns, start.song.patterns);
  assert.deepEqual(s.song.playlist, start.song.playlist);
  // Repeat bars 1–2 of m01: m01 becomes 6 bars, m02 moves 2 bars later, the copy plays the same notes
  await applyOps(root, id, [{ op: 'section.time', section: 'm01', kind: 'repeat', from: 1, to: 2 }]);
  s = loadSong(root, id);
  assert.equal(s.song.patterns[0].bars, 6);
  assert.equal(s.song.playlist.items.find((i) => i.ref === 'm02').at.tick, 6 * 3840);
  const bass = s.song.patterns[0].notes.ch02;
  const first = bass.filter((n) => n.t < 2 * 3840).map((n) => [n.t, n.key]);
  const copy = bass.filter((n) => n.t >= 2 * 3840 && n.t < 4 * 3840).map((n) => [n.t - 2 * 3840, n.key]);
  assert.deepEqual(copy, first);
  assert.match(s.text, /\.early\(/);
  assert.match(s.text, /m02 · The bet · bars 7–10/, 'the later section\'s comment moved');
  assert.ok(s.song.locks.some((l) => l.scope.pattern === 'm01' && l.scope.fromTick === 2 * 3840 && l.scope.toTick === 4 * 3840), 'the copy is locked as a hand edit');
  await textMatchesNotes(t, root, id);
  await undo(root, id);
  assert.equal(readFileSync(sp.strudel, 'utf8'), start.text);
  // + 2 empty bars at the end of m02
  await applyOps(root, id, [{ op: 'section.time', section: 'm02', kind: 'add', at: 5, n: 2 }]);
  s = loadSong(root, id);
  assert.equal(s.song.patterns[1].bars, 6);
  assert.match(s.text, /\[2, silence\]/);
  await textMatchesNotes(t, root, id);
});

test('Mute a part: the notes stop playing (out of the text) but are kept, and come back', { skip }, async (t) => {
  const { root, id, sp } = await songProject(t);
  const start = loadSong(root, id);
  const keysBar2 = start.song.patterns[0].notes.ch03.filter((n) => n.t >= 3840 && n.t < 7680);
  await applyOps(root, id, [{ op: 'note.mute', pattern: 'm01', channel: 'ch03', bars: [2, 2] }]);
  let s = loadSong(root, id);
  assert.ok(!s.song.patterns[0].notes.ch03.some((n) => n.t >= 3840 && n.t < 7680), 'they don\'t play');
  const meta = JSON.parse(readFileSync(join(sp.music, 'daw', 'notes-meta.json'), 'utf8'));
  assert.equal(meta.muted.length, keysBar2.length, 'they are kept');
  assert.ok(s.song.locks.some((l) => l.scope.channel === 'ch03'), 'a hand lock');
  await textMatchesNotes(t, root, id);
  await applyOps(root, id, [{ op: 'note.unmute', pattern: 'm01', channel: 'ch03', bars: [2, 2] }]);
  s = loadSong(root, id);
  assert.deepEqual(s.song.patterns[0].notes.ch03.filter((n) => n.t >= 3840 && n.t < 7680).map((n) => [n.t, n.key]), keysBar2.map((n) => [n.t, n.key]));
  assert.equal(JSON.parse(readFileSync(join(sp.music, 'daw', 'notes-meta.json'), 'utf8')).muted.length, 0);
  // undo the unmute, then the mute: back to the start, the kept list empty again
  await undo(root, id); await undo(root, id);
  s = loadSong(root, id);
  assert.equal(s.text, start.text);
  assert.equal(JSON.parse(readFileSync(join(sp.music, 'daw', 'notes-meta.json'), 'utf8')).muted.length, 0);
});
