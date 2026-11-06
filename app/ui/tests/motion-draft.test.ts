import { describe, expect, it } from 'vitest';
import {
  draftProblem,
  ParkedDrafts,
  pinForVoice,
  pinFrame,
  pinRange,
  pinScene,
} from '../src/screens/motion/draft';
import { notePayload, type NoteDraft } from '../src/screens/motion/note-payload';
import { canWriteNote, sceneMedia } from '../src/screens/motion/scene-media';
import { emptyDraft } from '../src/screens/motion/scenes';
import type { PlanShot, Scene } from '../src/screens/motion/types';

describe('marking a note', () => {
  it('Mark frame pins the instant and drops any range end', () => {
    const draft = pinFrame({ ...emptyDraft(), mode: 'range', timeEnd: 4 }, 2.5);
    expect(draft).toMatchObject({ mode: 'frame', locked: true, time: 2.5, timeEnd: null });
  });

  it('Mark range: first press starts, second press ends', () => {
    const started = pinRange(emptyDraft(), 3);
    expect(started).toMatchObject({ mode: 'range', locked: true, time: 3, timeEnd: null });
    expect(pinRange(started, 5)).toMatchObject({ time: 3, timeEnd: 5 });
  });

  it('Mark range accepts the end before the start', () => {
    const started = pinRange(emptyDraft(), 5);
    expect(pinRange(started, 3)).toMatchObject({ time: 3, timeEnd: 5 });
  });

  it('Mark range at one spot still covers a moment', () => {
    const started = pinRange(emptyDraft(), 5);
    const done = pinRange(started, 5.01);
    expect(done.timeEnd).toBeCloseTo(5.1);
  });

  it('a note about the scene is pinned without a range end', () => {
    expect(pinScene({ ...emptyDraft(), timeEnd: 2 })).toMatchObject({
      mode: 'scene',
      locked: true,
      timeEnd: null,
    });
  });

  it('recording pins only a free-running frame note', () => {
    expect(pinForVoice(emptyDraft(), 7)).toMatchObject({ locked: true, time: 7 });
    const range = { ...emptyDraft(), mode: 'range' as const };
    expect(pinForVoice(range, 7)).toBe(range);
    const pinned = pinFrame(emptyDraft(), 1);
    expect(pinForVoice(pinned, 7)).toBe(pinned);
  });
});

describe('draftProblem', () => {
  it('asks for words or a voice first, and focuses the field', () => {
    expect(draftProblem(emptyDraft(), false)).toEqual({ text: 'Write or speak a note first.', focus: true });
  });

  it('asks to end an open range', () => {
    const open = { ...pinRange(emptyDraft(), 1), text: 'Too slow' };
    expect(draftProblem(open, false)?.text).toMatch(/Set range end/);
  });

  it('lets a written or spoken note through', () => {
    expect(draftProblem({ ...emptyDraft(), text: 'Too slow' }, false)).toBeNull();
    expect(draftProblem(emptyDraft(), true)).toBeNull();
  });
});

describe('ParkedDrafts', () => {
  it('gives a parked note back once, to its own scene only', () => {
    const shelf = new ParkedDrafts();
    const draft = { ...emptyDraft(), text: 'half' };
    shelf.park('b1', { draft, audio: null });
    expect(shelf.take('b2')).toBeUndefined();
    expect(shelf.take('b1')?.draft).toBe(draft);
    expect(shelf.take('b1')).toBeUndefined();
  });
});

describe('notePayload', () => {
  const base: NoteDraft = {
    node: 'n1',
    time: 2.34567,
    end: null,
    text: '  too slow ',
    kind: 'frame',
    version: 2,
    fps: 30,
    type: '',
    imagePngBase64: 'PNG',
    voice: null,
  };

  it('rounds seconds, counts frames and trims the words', () => {
    const payload = notePayload(base);
    expect(payload).toMatchObject({ time: 2.346, frame: 70, text: 'too slow', send: false, version: 2 });
    expect(payload).not.toHaveProperty('time_end');
    expect(payload).not.toHaveProperty('type');
    expect(payload).not.toHaveProperty('audio_base64');
  });

  it('adds the range end, the type and the voice only when there are some', () => {
    const payload = notePayload({
      ...base,
      kind: 'range',
      end: 4,
      type: 'timing',
      voice: { base64: 'AUDIO', extension: 'webm' },
    });
    expect(payload).toMatchObject({
      time_end: 4,
      frame_end: 120,
      type: 'timing',
      audio_base64: 'AUDIO',
      audio_ext: 'webm',
    });
  });
});

describe('sceneMedia and canWriteNote', () => {
  const shot = (extra: Partial<PlanShot>): PlanShot => ({ node: 'n1', beat: 'b1', ...extra }) as PlanShot;
  const review: Scene = { beat: 'b1', name: 'b1', state: 'review' };

  it('prefers the viewed version, which always plays', () => {
    const media = sceneMedia([shot({})], { n: 2, file: 'v2.mp4' });
    expect(media).toEqual({ path: 'v2.mp4', video: true, node: 'n1' });
  });

  it('falls back to the shot media and knows a still from a video', () => {
    const still = sceneMedia([shot({ media: { kind: 'image', path: 'a.png' } })], null);
    expect(still).toEqual({ path: 'a.png', video: false, node: 'n1' });
    const clip = sceneMedia([shot({ media: { kind: 'video', path: 'a.mp4' } })], null);
    expect(clip.video).toBe(true);
  });

  it('has no picture without shots', () => {
    expect(sceneMedia([], null)).toEqual({ path: null, video: false, node: null });
  });

  it('notes need a picture, a scene that is not waiting or failed, and a clip that loaded', () => {
    const media = { path: 'a.mp4', video: true, node: 'n1' };
    expect(canWriteNote(media, review, 'ready')).toBe(true);
    expect(canWriteNote(media, { ...review, state: 'waiting' }, 'ready')).toBe(false);
    expect(canWriteNote(media, { ...review, state: 'failed' }, 'ready')).toBe(false);
    expect(canWriteNote(media, review, 'error')).toBe(false);
    expect(canWriteNote({ ...media, path: null }, review, 'ready')).toBe(false);
    expect(canWriteNote(media, undefined, 'ready')).toBe(false);
  });
});
