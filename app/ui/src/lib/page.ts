/** A parameter of the page address before the hash, e.g. /app/?project=black-october#/motion. */
export const pageParam = (name: string): string | null => new URLSearchParams(location.search).get(name);
