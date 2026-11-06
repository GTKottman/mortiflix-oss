// The voice step makes the music (Director 1, 2026-11-02: "Music segments: none planned yet" sat next to "Every line and
// cue is approved"). MusicStore says when music is missing, what is left to make, and makes it through the cost OK.
import { describe, expect, it } from 'vitest';
import { MusicStore } from '../src/screens/voice/music.svelte';
import type { VoiceService } from '../src/screens/voice/mock';
import type { MusicCue, MusicPlan } from '../src/screens/voice/types';

const cue = (id: string, state: MusicCue['state'], path?: string): MusicCue => ({
  id,
  from_sec: 0,
  to_sec: 5,
  state,
  credits: 100,
  ...(path ? { path } : {}),
});

function store(plan: MusicPlan, calls: [string, unknown][] = []) {
  const service = {
    call: (method: string, params?: unknown) => {
      calls.push([method, params]);
      return Promise.resolve(plan);
    },
  } as unknown as VoiceService;
  const s = new MusicStore(service, () => undefined);
  s.plan = plan;
  return s;
}

describe('music the voice step owes', () => {
  it('none planned is missing music', () => {
    expect(store({ enabled: true, expected: true, cues: [] }).missingMusic).toBe(true);
  });
  it('a project that expects no music is never missing it', () => {
    expect(store({ enabled: false, cues: [] }).missingMusic).toBe(false);
  });
  it('planned cues are to make, with their credits; made and OK cues are not', () => {
    const s = store({
      enabled: true,
      expected: true,
      cues: [cue('mc01', 'planned'), cue('mc02', 'stale', '/m2.mp3'), cue('mc03', 'ok', '/m3.mp3')],
    });
    expect(s.toMake.map((c) => c.id)).toEqual(['mc01', 'mc02']);
    expect(s.toMakeCredits).toBe(200);
    expect(s.missingMusic).toBe(true);
  });
  it('every cue OK: nothing missing', () => {
    expect(store({ enabled: true, expected: true, cues: [cue('mc01', 'ok', '/m.mp3')] }).missingMusic).toBe(
      false,
    );
  });
  it('Make the music is the OK on the cost (step.confirm_cost music)', async () => {
    const calls: [string, unknown][] = [];
    await store({ enabled: true, expected: true, cues: [cue('mc01', 'planned')] }, calls).makeAll();
    expect(calls[0]).toEqual(['step.confirm_cost', { step: 'music' }]);
  });
});

// Dirs 1 and 2 (2026-11-02): Make the music made 4 cues at once. The first music is made alone and heard first.
describe('Make the music: the first music alone', () => {
  const plan = (cues: MusicCue[]) => store({ enabled: true, expected: true, cues }).makeNow;
  it('nothing made: Make Music 1 first, its credits only', () => {
    expect(plan([cue('mc01', 'planned'), cue('mc02', 'planned'), cue('mc03', 'planned')])).toEqual({
      cues: [cue('mc01', 'planned')],
      credits: 100,
      label: 'Make Music 1 first',
      wait: null,
    });
  });
  it('Music 1 made, not OK yet: no button, it says to hear it', () => {
    const m = plan([cue('mc01', 'made', '/m1.mp3'), cue('mc02', 'planned'), cue('mc03', 'planned')]);
    expect(m.label).toBeNull();
    expect(m.wait).toBe('Hear Music 1 and OK it, then make the other 2.');
  });
  it('Music 1 OK: Make the other N, their credits', () => {
    const m = plan([cue('mc01', 'ok', '/m1.mp3'), cue('mc02', 'planned'), cue('mc03', 'planned')]);
    expect([m.label, m.credits, m.cues.length]).toEqual(['Make the other 2', 200, 2]);
  });
});
