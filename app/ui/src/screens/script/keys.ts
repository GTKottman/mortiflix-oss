export type Shortcut = 'approve' | 'edit' | 'fix' | 'next' | 'previous';

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  /** The tag name of the focused element. */
  tag: string;
  editable: boolean;
}

const FIELDS = ['INPUT', 'TEXTAREA', 'SELECT'];
const CONTROLS = ['BUTTON', 'A', 'SUMMARY'];

/**
 * Enter = OK, E = Edit the words, F = Fix with a note (Mortiflix rewrites), arrows or J / K move between scenes. Single keys only: never while typing,
 * never with a modifier, and Enter on a focused control belongs to that control.
 */
export function shortcutFor(press: KeyPress): Shortcut | null {
  if (press.ctrlKey || press.metaKey || press.altKey || press.defaultPrevented) return null;
  if (FIELDS.includes(press.tag) || press.editable) return null;
  if (press.key === 'Enter') return CONTROLS.includes(press.tag) ? null : 'approve';
  switch (press.key.toLowerCase()) {
    case 'e':
      return 'edit';
    case 'f':
      return 'fix';
    case 'arrowdown':
    case 'j':
      return 'next';
    case 'arrowup':
    case 'k':
      return 'previous';
    default:
      return null;
  }
}
