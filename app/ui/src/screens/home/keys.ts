// Arrow keys move between the rows and cards on Home.

/** The link to focus when `key` is pressed on `current`, or null when the key is not a move or there is none. */
export function neighbour(
  links: readonly HTMLElement[],
  current: HTMLElement,
  key: string,
): HTMLElement | null {
  if (!key.startsWith('Arrow')) return null;
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  const index = links.indexOf(current);
  return index < 0 ? null : (links[index + step] ?? null);
}
