import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioExtension, clipUrl, pictureUrl } from '../src/screens/motion/media';
import { playerKeys } from '../src/screens/motion/keys';
import type { MotionSession } from '../src/screens/motion/motion.svelte';

describe('motion media addresses', () => {
  it('serves studio files through the bridge', () => {
    expect(clipUrl('a b/c.mp4')).toBe('/file?path=a%20b%2Fc.mp4');
    expect(pictureUrl('x.png', 480)).toBe('/thumb?path=x.png&w=480');
  });

  it('leaves data, blob and fixture addresses as they are', () => {
    for (const local of ['data:image/png;base64,AA', 'blob:abc', '/screens/motion/a.png']) {
      expect(clipUrl(local)).toBe(local);
      expect(pictureUrl(local, 480)).toBe(local);
    }
  });

  it('names a recording by its type', () => {
    expect(audioExtension('audio/ogg;codecs=opus')).toBe('ogg');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    expect(audioExtension('audio/webm')).toBe('webm');
  });
});

describe('playerKeys', () => {
  type Listener = (event: Partial<KeyboardEvent>) => void;
  let listener: Listener | undefined;
  let dialogOpen = false;

  function stubDocument() {
    vi.stubGlobal('HTMLElement', function HTMLElement() {});
    vi.stubGlobal('document', {
      addEventListener: (_: string, fn: Listener) => (listener = fn),
      removeEventListener: () => (listener = undefined),
      querySelector: () => (dialogOpen ? {} : null),
    });
  }

  function session() {
    const calls: string[] = [];
    const motion = {
      player: { togglePlay: () => calls.push('play'), step: (n: number) => calls.push(`step ${n}`) },
      markFrame: () => calls.push('mark'),
    } as unknown as MotionSession;
    return { calls, motion };
  }

  const press = (key: string, extra: Partial<KeyboardEvent> = {}) =>
    listener?.({ key, preventDefault: () => undefined, ...extra });

  afterEach(() => {
    vi.unstubAllGlobals();
    dialogOpen = false;
  });

  it('plays, steps and marks with single keys', () => {
    stubDocument();
    const { calls, motion } = session();
    playerKeys(motion);
    for (const key of [' ', ',', '.', 'm', 'M']) press(key);
    expect(calls).toEqual(['play', 'step -1', 'step 1', 'mark', 'mark']);
  });

  it('ignores keys with a modifier, with a dialog open, and other keys', () => {
    stubDocument();
    const { calls, motion } = session();
    playerKeys(motion);
    press('m', { ctrlKey: true });
    press('x');
    dialogOpen = true;
    press(' ');
    expect(calls).toEqual([]);
  });

  it('stops listening when told to', () => {
    stubDocument();
    const stop = playerKeys(session().motion);
    stop();
    expect(listener).toBeUndefined();
  });
});
