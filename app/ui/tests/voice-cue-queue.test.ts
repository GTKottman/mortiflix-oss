// Dir3 (61dc, 2026-11-02): "Queue to make" on Music 2-5 did nothing after Music 1 was queued. The first music is made
// alone and heard before the rest (a paid test first); the button now says so, naming the cue to make first.
import { describe, expect, it } from 'vitest';
import { VoiceModel } from '../src/screens/voice/model.svelte';

const why = (queued: string[], anyMade: boolean, id: string) =>
  VoiceModel.prototype.whyNotQueueCue.call(
    {
      noKey: null,
      music: { anyMade },
      basket: { cues: new Map(queued.map((q) => [q, {}])) },
    } as unknown as VoiceModel,
    id,
  );

describe('queueing music cues', () => {
  it('the first cue joins the queue', () => expect(why([], false, 'mc01')).toBeNull());
  it('before any music is made, a second cue says which cue to make first', () =>
    expect(why(['mc01'], false, 'mc02')).toBe(
      'The first music is made alone: make Music 1 (Make the queue), hear it, then queue the rest.',
    ));
  it('once one is made, every cue joins (one confirm for all)', () => {
    for (const id of ['mc02', 'mc03', 'mc04', 'mc05']) expect(why(['mc02', 'mc03'], true, id)).toBeNull();
  });
});
