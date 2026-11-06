import { describe, expect, it } from 'vitest';
import { keyAction, type KeyInput } from '../src/screens/voice/keys';

const press = (key: string, over: Partial<KeyInput> = {}): KeyInput => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  target: { tagName: 'DIV' } as unknown as EventTarget,
  ...over,
});

describe('voice keys', () => {
  it('maps the screen keys', () => {
    expect(keyAction(press('Enter'), true)).toBe('approve');
    expect(keyAction(press('F'), false)).toBe('fix');
    expect(keyAction(press('n'), false)).toBe('next');
    expect(keyAction(press(' '), true)).toBe('play');
    expect(keyAction(press('ArrowRight'), true)).toBe('later');
    expect(keyAction(press('Escape'), false)).toBe('escape');
  });

  it('needs a selected clip to play or move', () => {
    expect(keyAction(press(' '), false)).toBeNull();
    expect(keyAction(press('ArrowLeft'), false)).toBeNull();
  });

  it('stays out of typing, modifiers and focused buttons', () => {
    expect(
      keyAction(press('f', { target: { tagName: 'INPUT' } as unknown as EventTarget }), true),
    ).toBeNull();
    expect(
      keyAction(
        press('n', { target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }),
        true,
      ),
    ).toBeNull();
    expect(keyAction(press('n', { ctrlKey: true }), true)).toBeNull();
    expect(
      keyAction(press('Enter', { target: { tagName: 'BUTTON' } as unknown as EventTarget }), true),
    ).toBeNull();
    expect(keyAction(press(' ', { target: { tagName: 'A' } as unknown as EventTarget }), true)).toBeNull();
    expect(keyAction(press('x'), true)).toBeNull();
  });
});
