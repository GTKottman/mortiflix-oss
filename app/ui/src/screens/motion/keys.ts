import type { MotionSession } from './motion.svelte';

const FORM = /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY|AUDIO)$/;

/** The player's single keys on the Motion screen: Space plays, comma and period step one frame, M marks the
 *  frame. Never while typing, on a control, with a modifier or a dialog open; the player's own keys win when it
 *  has focus. Enter and F (approve, request fix) are the shared review keys. Returns the stop function. */
export function playerKeys(motion: MotionSession): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLElement && (FORM.test(target.tagName) || target.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    const keys: Record<string, () => void> = {
      ' ': () => motion.player?.togglePlay(),
      ',': () => motion.player?.step(-1),
      '.': () => motion.player?.step(1),
      m: () => motion.markFrame(),
      M: () => motion.markFrame(),
    };
    const run = keys[event.key];
    if (!run) return;
    // Holding Space or M would toggle play / drop marks on every repeat; held comma and period keep stepping.
    if (event.repeat && (event.key === ' ' || event.key.toLowerCase() === 'm')) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    run();
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
