// Dir1 (2026-11-02): a queued project offered Resume, which answered "not paused (queued)". Queued now says where it
// stands and offers nothing to press.
import { describe, expect, it } from 'vitest';
import { queuedWords, waitingWords } from '../src/lib/review/waiting';
import { stageById } from '../src/lib/stages';

describe('queued for a session slot', () => {
  it('says how many are ahead and is not idle (no Resume)', () => {
    expect(queuedWords(2)).toEqual({ title: 'Queued', body: 'Queued: starts when a slot frees (2 ahead).' });
    const w = waitingWords(stageById('look'), [], 'the frames', 0);
    expect(w.body).toBe('Queued: starts when a slot frees (0 ahead).');
    expect(w.idle).toBeUndefined();
  });
  it('not queued: the old idle words', () => {
    expect(waitingWords(stageById('look'), [], 'the frames').idle).toBe(true);
  });
});
