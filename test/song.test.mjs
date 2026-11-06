// The song file (doc 18 S1): the schema, checkSong, the one-note-per-line writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptySong, checkSong, writeSong, readSong, compactNote, ticksPerBar, sectionLayout } from '../src/song.mjs';

function goodSong() {
  const s = emptySong({ title: 'The bet', bpm: 96, offsetSec: 0.6, scale: { root: 'D', mode: 'dorian', limitToScale: true } });
  s.channels.push({ id: 'ch02', name: 'Bass', kind: 'instrument', midiChannel: 2, insert: 'mx02', volDb: -2, pan: 0 });
  s.channels.push({ id: 'ch10', name: 'Drums', kind: 'drums', midiChannel: 10, insert: 'mx10' });
  s.mixer.inserts.push({ id: 'mx02', n: 2, name: 'Bass', out: 'master' }, { id: 'mx10', n: 10, name: 'Drums', out: 'master' });
  s.patterns.push({ id: 'm01', name: 'Cold open', bars: 2, notes: { ch02: [{ t: 0, len: 480, key: 38, vel: 0.78 }, { t: 480, len: 240, key: 41, vel: 0.8, fine: -12, slide: true }], ch10: [{ t: 0, len: 120, key: 36, vel: 0.9 }] } });
  s.patterns.push({ id: 'm02', name: 'The bet', bars: 4, notes: { ch02: [{ t: 0, len: 3840, key: 43 }] } });
  s.playlist.tracks.push({ id: 'r1', name: 'Music' }, { id: 'r2', name: 'Narration' });
  s.audio.push({ id: 'a01', file: 'voice/out/l01.wav', rate: 48000, chans: 1, source: { kind: 'line', node: 'l01' }, follow: true });
  s.playlist.items.push({ id: 'i001', kind: 'pattern', ref: 'm01', track: 'r1', at: { tick: 0 }, len: 7680 });
  s.playlist.items.push({ id: 'i002', kind: 'pattern', ref: 'm02', track: 'r1', at: { tick: 7680 }, len: 15360 });
  s.playlist.items.push({ id: 'i003', kind: 'audio', ref: 'a01', track: 'r2', at: { sec: 1.25 }, lenSec: 2 });
  s.markers.push({ id: 'k01', tick: 0, name: 'cold open', kind: 'section' });
  s.locks.push({ id: 'L001', scope: { pattern: 'm01', channel: 'ch02', fromTick: 0, toTick: 3840 }, by: 'hand' });
  return s;
}

test('a good song passes; its layout comes from the playlist', () => {
  assert.deepEqual(checkSong(goodSong()), []);
  assert.equal(ticksPerBar({ num: 4, den: 4 }), 3840);
  assert.equal(ticksPerBar({ num: 6, den: 8 }), 2880);
  assert.deepEqual(sectionLayout(goodSong()).map((x) => [x.id, x.startBar, x.bars]), [['m01', 1, 2], ['m02', 3, 4]]);
});

test('bad songs: each mistake is named in plain words', () => {
  const bad = (change, re) => { const s = goodSong(); change(s); const e = checkSong(s); assert.ok(e.some((m) => re.test(m)), `${re} not in ${JSON.stringify(e)}`); };
  bad((s) => { s.patterns[0].notes.ch02[0].t = 0.5; }, /"t" must be a whole number of ticks/);
  bad((s) => { s.patterns[0].notes.ch02[0].key = 128; }, /"key" 128 is over 127/);
  bad((s) => { s.patterns[0].notes.ch02[0].vel = 1.2; }, /"vel" 1.2 is over 1/);
  bad((s) => { s.patterns[0].notes.ch02[0].len = 0; }, /"len" 0 is under 1/);
  bad((s) => { s.patterns[0].notes.ch02[0].wobble = 1; }, /"wobble" isn't a note field/);
  bad((s) => { s.patterns[0].notes.ch99 = []; }, /notes for "ch99", which isn't a channel/);
  bad((s) => { s.patterns.push({ id: 'm01', bars: 1 }); }, /two patterns share the id "m01"/);
  bad((s) => { s.playlist.items[0].ref = 'm09'; }, /plays pattern "m09", which doesn't exist/);
  bad((s) => { s.playlist.items[2].at = { tick: 0 }; }, /audio is placed in seconds/);
  bad((s) => { s.channels[0].insert = 'mx77'; }, /mixer insert "mx77", which doesn't exist/);
  bad((s) => { s.tempo.push({ tick: 0, bpm: 100 }); }, /tempo map must be sorted/);
  bad((s) => { s.meter = [{ bar: 1, num: 7, den: 3 }]; }, /7\/3 isn't a usable time signature/);
  bad((s) => { s.audio[0].file = '../../etc/passwd'; }, /path inside the project/);
  bad((s) => { s.locks[0].by = 'ai'; }, /"by" must be hand or ok/);
  bad((s) => { s.sampleRate = 44100; }, /one rate end to end/);
});

test('blobs must exist and match their hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-song-'));
  try {
    const s = goodSong();
    const state = Buffer.from('plugin state');
    const sha = createHash('sha256').update(state).digest('hex');
    s.channels[0].instrument = { format: 'vst3', name: 'Strata', blob: sha };
    assert.match(checkSong(s, { dir }).join(), /is missing from music\/daw\/blobs/);
    mkdirSync(join(dir, 'daw', 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'daw', 'blobs', `${sha}.bin`), state);
    assert.deepEqual(checkSong(s, { dir }), []);
    writeFileSync(join(dir, 'daw', 'blobs', `${sha}.bin`), 'changed');
    assert.match(checkSong(s, { dir }).join(), /doesn't match its hash/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the writer: one note per line, defaults left out, reads back the same', () => {
  const s = goodSong();
  const text = writeSong(s);
  const noteLines = text.split('\n').filter((l) => /^\s*\{"t":/.test(l));
  assert.equal(noteLines.length, 4);
  assert.ok(noteLines.some((l) => l.includes('{"t":480,"len":240,"key":41,"fine":-12,"slide":true}')), 'vel 0.8 left out, fields in order');
  assert.ok(noteLines.some((l) => l.trim().startsWith('{"t":0,"len":3840,"key":43}')));
  const back = readSong(text);
  assert.deepEqual(back.patterns[1].notes.ch02, [{ t: 0, len: 3840, key: 43 }]);
  assert.deepEqual(checkSong(back), []);
  assert.deepEqual(compactNote({ t: 1, len: 2, key: 3, vel: 0.8, rel: 0.5, pan: 0 }), { t: 1, len: 2, key: 3 });
  // a one-note edit changes one line of the file
  const s2 = goodSong(); s2.patterns[0].notes.ch02[1].key = 43;
  const a = text.split('\n'); const b = writeSong(s2).split('\n');
  assert.equal(a.filter((l, i) => l !== b[i]).length, 1);
});
