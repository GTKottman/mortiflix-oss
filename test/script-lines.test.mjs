// Script lines: a beat's own lines plus voice lines it doesn't list, never the same words twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linesOf } from '../src/svc/script.mjs';

test('script lines: a voice split of a two-sentence line shows each sentence once', () => {
  const beat = { id: 'b01', lines: [{ id: 'b01-1', words: 'So, this week? Call it Black October.' }] };
  const voice = [
    { id: 'b01-1', script: 'So, this week?' },
    { id: 'b01-2', script: 'Call it Black October.' },
  ];
  assert.deepEqual(linesOf(beat, voice).map((l) => l.id), ['b01-1']);
  assert.equal(linesOf(beat, voice)[0].words, 'So, this week? Call it Black October.');
});

test('script lines: a voice line with words the script does not have is still listed', () => {
  const beat = { id: 'b02', lines: [{ id: 'b02-1', words: 'The big one.' }] };
  const voice = [{ id: 'b02-1', script: 'The big one.' }, { id: 'b02-2', script: 'It lets a stranger in.' }];
  assert.deepEqual(linesOf(beat, voice).map((l) => l.id), ['b02-1', 'b02-2']);
});

test('script lines: words rewritten by a Fix win over the old lines and the old voice words', () => {
  const voice = [{ id: 'b03-1', script: 'Old first.' }, { id: 'b03-2', script: 'Old second.' }];
  // no stored lines: the voice lines had the old words
  const fixed = { id: 'b03', words: 'New first. New second! A third one?' };
  assert.deepEqual(linesOf(fixed, voice), [
    { id: 'b03-1', words: 'New first.' },
    { id: 'b03-2', words: 'New second!' },
    { id: 'b03-3', words: 'A third one?' },
  ]);
  // stored lines from an owner edit, then the words rewritten after
  const edited = { id: 'b03', words: 'Brand new.', lines: [{ id: 'b03-1', words: 'Old first.' }, { id: 'b03-2', words: 'Old second.' }] };
  assert.deepEqual(linesOf(edited, voice).map((l) => l.words), ['Brand new.']);
  // lines that still say the words are kept as they are
  const same = { id: 'b03', words: 'Old first. Old second.', lines: [{ id: 'b03-1', words: 'Old first.' }, { id: 'b03-2', words: 'Old second.' }] };
  assert.deepEqual(linesOf(same, voice).map((l) => l.id), ['b03-1', 'b03-2']);
});
