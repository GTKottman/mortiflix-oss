/** The colour marks are drawn in: the app's warning colour, read from the page. */
export const markColour = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();
