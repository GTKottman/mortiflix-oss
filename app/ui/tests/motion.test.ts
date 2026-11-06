import { describe, expect, it } from 'vitest';
import {
  clock,
  decisionText,
  draftWhere,
  emptyDraft,
  noteSeconds,
  noteWhere,
  pickBeat,
  statusOf,
  unresolvedOf,
  versionsOf,
  viewedVersion,
  type FootFacts,
  sceneLength,
} from '../src/screens/motion/scenes';
import { tabletLine } from '../src/screens/motion/tablet';
import type { Scene, SceneList, SceneNote } from '../src/screens/motion/types';

const scene = (beat: string, state: Scene['state'], extra: Partial<Scene> = {}): Scene => ({
  beat,
  name: beat,
  state,
  ...extra,
});

describe('clock', () => {
  it('shows minutes, seconds and tenths', () => {
    expect(clock(0)).toBe('0:00.0');
    expect(clock(65.25)).toBe('1:05.3');
    expect(clock(-3)).toBe('0:00.0');
  });
});

describe('statusOf', () => {
  it('says what each scene state means, in words', () => {
    expect(statusOf(scene('b1', 'ok'), 0)).toEqual({ mark: 'ok', text: 'Approved' });
    expect(statusOf(scene('b1', 'review'), 0).text).toBe('Ready for review');
    expect(statusOf(scene('b2', 'waiting'), 1).text).toBe('Waiting for scene 1 approval');
    expect(statusOf(scene('b1', 'waiting'), 0).text).toBe('Waiting');
    expect(statusOf(scene('b1', 'failed'), 0).mark).toBe('cut');
  });

  it('calls a scene with a clip Regenerating and one without Generating', () => {
    expect(statusOf(scene('b1', 'making'), 0).text).toBe('Generating');
    expect(statusOf(scene('b1', 'making', { clip: { file: 'a.mp4' } }), 0).text).toBe('Regenerating');
  });
});

describe('versions', () => {
  const versions = [
    { n: 1, file: 'a' },
    { n: 2, file: 'b' },
    { n: 3, file: 'c' },
  ];

  it('uses the one clip as Version 1 when the service lists none', () => {
    expect(versionsOf(scene('b1', 'review', { clip: { file: 'a.mp4' } }))).toEqual([{ n: 1, file: 'a.mp4' }]);
    expect(versionsOf(scene('b1', 'waiting'))).toEqual([]);
  });

  it('shows the newest, an older one picked, or a side of Compare', () => {
    expect(viewedVersion(versions, { picked: null, compare: false, side: 'after' })?.n).toBe(3);
    expect(viewedVersion(versions, { picked: 0, compare: false, side: 'after' })?.n).toBe(1);
    expect(viewedVersion(versions, { picked: 0, compare: true, side: 'before' })?.n).toBe(2);
    expect(viewedVersion(versions, { picked: 0, compare: true, side: 'after' })?.n).toBe(3);
    expect(viewedVersion([], { picked: null, compare: false, side: 'after' })).toBeNull();
  });
});

describe('notes', () => {
  const frame: SceneNote = { id: 'a', node: 's01', time: 2.4, frame: 72, kind: 'frame', pending: true };
  const range: SceneNote = { id: 'b', node: 's01', time: 4.1, time_end: 5.2, kind: 'range', pending: true };
  const whole: SceneNote = { id: 'c', node: 's01', time: 0, kind: 'scene', pending: true, resolved: true };

  it('says where a note points', () => {
    expect(noteWhere(frame)).toBe('0:02.4');
    expect(noteWhere(range)).toBe('0:04.1 – 0:05.2');
    expect(noteWhere(whole)).toBe('Whole scene');
  });

  it('jumps to the note’s frame, else its time', () => {
    expect(noteSeconds(frame, 30)).toBe(2.4);
    expect(noteSeconds(range, 30)).toBe(4.1);
    expect(noteSeconds(whole, 30)).toBe(0);
  });

  it('counts the notes still to send, not the resolved ones', () => {
    expect(unresolvedOf([frame, range, whole]).map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('the note being written', () => {
  it('says where it points', () => {
    const draft = emptyDraft();
    expect(draftWhere({ ...draft, time: 1.5 }, 30)).toBe('At the playhead 0:01.5 · frame 45');
    expect(draftWhere({ ...draft, locked: true, time: 1.5 }, 30)).toBe('Frame 0:01.5 · frame 45');
    expect(draftWhere({ ...draft, mode: 'range', time: 1 }, 30)).toBe(
      'Range from 0:01.0 · press Set range end',
    );
    expect(draftWhere({ ...draft, mode: 'range', time: 1, timeEnd: 2 }, 30)).toBe('Range 0:01.0 – 0:02.0');
    expect(draftWhere({ ...draft, mode: 'scene' }, 30)).toBe('Whole scene');
  });
});

describe('pickBeat', () => {
  const list: SceneList = {
    scenes: [scene('b01', 'ok'), scene('b02', 'review'), scene('b03', 'waiting')],
    current: 1,
  };
  const plan = { shots: [{ node: 's03', beat: 'b03' }] };

  it('keeps the scene on view when it is still there', () => {
    expect(pickBeat(list, plan, 'b01', null)).toBe('b01');
  });

  it('takes a beat or a shot asked for in the address', () => {
    expect(pickBeat(list, plan, null, 'b03')).toBe('b03');
    expect(pickBeat(list, plan, null, 's03')).toBe('b03');
  });

  it('falls back to the scene the studio is on', () => {
    expect(pickBeat(list, plan, null, 'nope')).toBe('b02');
    expect(pickBeat({ scenes: [] }, plan, null, null)).toBeNull();
  });
});

describe('decisionText', () => {
  const facts = (state: Scene['state'], extra: Partial<FootFacts> = {}): FootFacts => ({
    busy: '',
    soon: false,
    scene: scene('b02', state),
    index: 1,
    total: 6,
    clip: 'ready',
    notes: 0,
    unresolved: 0,
    latest: 1,
    lessons: 2,
    ...extra,
  });

  it('says why a waiting scene cannot be judged', () => {
    expect(decisionText(facts('waiting'))).toBe('Scene 2 waits for scene 1 approval.');
    expect(decisionText(facts('waiting', { index: 0 }))).toBe('Scene 1 is not made yet.');
  });

  it('tells what Request fix will send and make', () => {
    expect(decisionText(facts('review', { notes: 3, unresolved: 2 }))).toBe(
      '3 notes saved · 2 not sent. Request fix sends them as one change and makes Version 2.',
    );
  });

  it('tells what approving makes next, with the lessons', () => {
    expect(decisionText(facts('review'))).toBe('No notes. Approving makes scene 3 next, with 2 lessons.');
    expect(decisionText(facts('review', { index: 5 }))).toBe(
      'No notes. Approving makes the last scene final.',
    );
  });

  it('puts what is being sent first', () => {
    expect(decisionText(facts('review', { busy: '◌ Approving scene 2' }))).toBe('◌ Approving scene 2');
  });

  it('blocks both buttons’ words when the clip did not load', () => {
    expect(decisionText(facts('review', { clip: 'error' }))).toMatch(/did not load/);
  });
});

describe('tabletLine', () => {
  const on = {
    enabled: true,
    tablet_seen: 'x',
    addresses: [{ kind: 'k', url: 'u', reachable: true }],
    problems: [],
  };
  const base = { status: on, scene: null, index: 0, total: 6, latest: 1 };

  it('shows nothing while Video Notes is off', () => {
    expect(tabletLine({ ...base, status: { enabled: false } })).toBeNull();
    expect(tabletLine({ ...base, status: null })).toBeNull();
  });

  it('offers the Settings link when no tablet was ever linked', () => {
    const line = tabletLine({ ...base, status: { ...on, tablet_seen: null } });
    expect(line?.link).toBe(true);
    expect(line?.menu).toBe(false);
  });

  it('says a failed send with its error and offers Resend', () => {
    const line = tabletLine({
      ...base,
      scene: { status: 'not sent', notes: 0, error: 'the Video Notes folder is not writable' },
    });
    expect(line?.text).toBe('Not sent to your tablet: the Video Notes folder is not writable');
    expect(line?.look).toBe('bad');
    expect(line?.resend).toBe(true);
    expect(tabletLine({ ...base, scene: { status: 'to review', notes: 0 } })?.resend).toBeFalsy();
  });

  it('says a tablet OK with notes remakes the scene as the next version', () => {
    const line = tabletLine({ ...base, scene: { status: 'done', notes: 3 } });
    expect(line?.text).toBe('Tablet sent OK with 3 notes. Remaking this scene as Version 2.');
  });

  it('says it cannot reach the tablet when no address answers', () => {
    const line = tabletLine({
      ...base,
      status: {
        ...on,
        addresses: [{ kind: 'k', url: 'u', reachable: false }],
        problems: ['Tailscale is off.'],
      },
    });
    expect(line?.look).toBe('bad');
  });
});

describe('the scene length', () => {
  it('adds up every shot, not the first one', () => {
    const shot = (dur_sec?: number) => ({ id: 's', node: 'n', beat: 'b', dur_sec }) as never;
    expect(sceneLength([shot(2), shot(3.5), shot()])).toBe(5.5);
    expect(sceneLength([shot(), shot()])).toBeUndefined();
  });
});
