// Voice & music on the 61dc data (Dir3, 2026-11-02): the screen sat on "Loading the lines…", then showed
// effect_update_depth_exceeded. Problems.clear wrote the list even when the id was absent, so the Voice notice effects
// (each clears its own id) woke each other forever; and a new sentence with no take (b08-2) has null times.
import { describe, expect, it } from 'vitest';
import { Problems } from '../src/lib/stores/problems.svelte';
import { VoiceModel } from '../src/screens/voice/model.svelte';
import { pauseAfter } from '../src/screens/voice/review';
import type { VoiceService } from '../src/screens/voice/mock';

const line = (
  node: string,
  start: number | null,
  dur: number | null,
  path: string | null,
  changed = false,
) => ({
  node,
  words: `Words of ${node}.`,
  path,
  start_sec: start,
  dur_sec: dur,
  beat: node.slice(0, 3),
  beat_no: Number(node.slice(1, 3)),
  state: 'ready',
  words_changed: changed,
});

// the 61dc view after the script sync: changed lines, b06-2 gone, b08-2 new with no take and no times
const VIEW = {
  length_sec: 50,
  voice: [
    line('b01-1', 0, 2.142, 'canvas/media/b01-1/a.wav'),
    line('b03-1', 11.693, 6.56, 'canvas/media/b03-1/b.wav', true),
    line('b06-1', 32.373, 1.417, 'canvas/media/b06-1/c.wav', true),
    line('b08-1', 46.661, 9.366, 'canvas/media/b08-1/d.wav', true),
    line('b08-2', 38.166, null, null),
    line('b10-2', 71.268, 2, 'canvas/media/b10-2/e.wav'),
  ],
  cues: [{ id: 'm01', node: 'm01', scored: false, state: 'planned' }],
  shots: [],
};

const service: VoiceService = {
  call: (async (type: string) => {
    if (type === 'voicemusic.view') return VIEW;
    if (type === 'voice.list') return { speaker: 'Tracy K', needs_key: null };
    if (type === 'cast.get' || type === 'voice.cast.get') return { members: [] };
    if (type === 'voice.check') return { lines: [] };
    if (type === 'voice.speed.get')
      return { speed: 1, speeds: [1], seconds: 80, chosen_sec: null, over_sec: null };
    throw new Error(`not in the fixture: ${type}`);
  }) as VoiceService['call'],
  on: (() => () => undefined) as VoiceService['on'],
};

describe('Voice & music on the 61dc view', () => {
  it('clearing a notice that is not raised changes nothing (the loop: every clear wrote the list)', () => {
    const problems = new Problems();
    problems.raise({ id: 'voice-err', kind: 'bad', text: 'x' });
    const before = problems.list;
    problems.clear('eleven-key');
    problems.clear('music-err');
    expect(problems.list).toEqual(before);
    problems.clear('voice-err');
    expect(problems.current).toBeNull();
  });

  it('loads: a line with no take has 0 s, and it counts among the lines to re-read', async () => {
    const stop = $effect.root(() => undefined);
    const model = new VoiceModel(service, { line: null, cue: null, issuesOpen: false });
    await model.load();
    expect(model.loadError).toBeNull();
    const b082 = model.lines.find((l) => l.node === 'b08-2');
    expect(b082?.dur_sec).toBe(0);
    expect(b082?.start_sec).toBe(38.166);
    expect(model.changedLines.map((l) => l.node)).toEqual(['b03-1', 'b06-1', 'b08-1', 'b08-2']);
    expect(Number.isFinite(model.length)).toBe(true);
    stop();
  });

  it("the pause shows the line's own pause (lines.json gap_after), also for a line with no take", () => {
    const lines = VIEW.voice.map((l) => ({ ...l, start_sec: l.start_sec ?? 0, dur_sec: l.dur_sec ?? 0 }));
    const check = (id: string, gap: number) =>
      ({
        id,
        role: 'narrator',
        text: '',
        tags: [],
        gap_after: gap,
        stability: null,
        checked: true,
        ok: false,
        missing: [],
        extra: [],
      }) as never;
    expect(pauseAfter(lines, 2, check('b06-1', 0.35))).toBe(0.35);
    expect(pauseAfter(lines, 4, check('b08-2', 0.3))).toBe(0.3);
    expect(pauseAfter(lines, 0, check('b01-1', 0.25))).toBe(0.25);
  });
});
