import { describe, expect, it } from 'vitest';
import { sceneWaitWords, statusOf } from '../src/screens/motion/scenes';
import type { Scene } from '../src/screens/motion/types';

const scene = (state: Scene['state']): Scene => ({ beat: 'b01', name: 'Scene', state });
const none = { here: false, failed: '', waiting: null };

describe('why a scene is not there yet (per scene, like Look)', () => {
  it('scene 1 never "waits for the scene before"', () => {
    expect(sceneWaitWords(scene('waiting'), 0, { ...none, here: true })).toBe('Being made.');
    expect(
      sceneWaitWords(scene('waiting'), 0, {
        ...none,
        waiting: {
          title: 'Waiting for Stills',
          body: "Stills isn't made yet, so the scenes can't start yet.",
        },
      }),
    ).toBe("Waiting: Stills isn't made yet, so the scenes can't start yet.");
    expect(sceneWaitWords(scene('waiting'), 0, none)).toBeNull();
  });

  it('a project that stopped on a problem: Failed, for a scene waiting or marked making', () => {
    const why = { ...none, failed: 'the scenes kept failing to render' };
    expect(sceneWaitWords(scene('waiting'), 0, why)).toBe('Failed: the scenes kept failing to render');
    expect(sceneWaitWords(scene('making'), 2, why)).toBe('Failed: the scenes kept failing to render');
    expect(statusOf(scene('making'), 2, why)).toEqual({ mark: 'cut', text: 'Failed' });
  });

  it('a later scene keeps "waits for scene N approval"; made scenes are untouched', () => {
    expect(sceneWaitWords(scene('waiting'), 1, { ...none, here: true })).toBeNull();
    expect(statusOf(scene('waiting'), 1, { ...none, here: true }).text).toBe('Waiting for scene 1 approval');
    expect(sceneWaitWords(scene('review'), 0, { ...none, failed: 'x' })).toBeNull();
    expect(statusOf(scene('waiting'), 0, { ...none, here: true })).toEqual({
      mark: 'busy',
      text: 'Being made',
    });
  });
});
