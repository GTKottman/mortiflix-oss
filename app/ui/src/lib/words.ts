// Counted words as the screens print them.

/** plural(1, 'scene') -> "1 scene"; plural(3, 'scene') -> "3 scenes"; plural(2, 'person', 'people') -> "2 people". */
export const plural = (count: number, word: string, many = `${word}s`): string =>
  `${count} ${count === 1 ? word : many}`;
