/**
 * Grows a textarea to fit its words. Pass the words so it re-fits as they change; it also re-fits when the
 * box gets narrower or wider (the window or the column resized), so wrapped words are never cut off.
 */
export function autosize(node: HTMLTextAreaElement, words: string) {
  const fit = () => {
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight + 2}px`;
  };
  void words;
  fit();
  let width = 0;
  const watch =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(([entry]) => {
          const now = entry?.contentRect.width ?? 0;
          if (now === width) return;
          width = now;
          fit();
        });
  watch?.observe(node);
  return { update: fit, destroy: () => watch?.disconnect() };
}
