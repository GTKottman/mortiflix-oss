/** Enter = OK, F = Fix on a review screen. Single keys only: never while typing, with a modifier, or with a dialog open. */
export function reviewKeys(handlers: { ok: () => void; fix: () => void }): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
      // Enter on a focused control activates that control, not OK.
      if (event.key === 'Enter' && /^(BUTTON|A|SUMMARY)$/.test(target.tagName)) return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Enter') handlers.ok();
    else if (event.key.toLowerCase() === 'f') handlers.fix();
    else return;
    event.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

/** In a note box: Enter keeps the note, Shift+Enter is a new line, Enter while an input method composes is the IME's. */
export const keepsNote = (event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing'>): boolean =>
  event.key === 'Enter' && !event.shiftKey && !event.isComposing;
