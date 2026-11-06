// Times as the screens print them. Every screen formats a clock through here, so a time reads the same everywhere.

/** 7 -> "07", for numbered pieces (scene 07). */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 83.4 -> "1:23". Rounds to the nearest second; never negative, never NaN.
 * `truncate` drops the part of a second instead (74.6 -> "1:14"), as the Voice & music screen always printed it.
 */
export function clock(seconds: number, { truncate = false }: { truncate?: boolean } = {}): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  // Truncate after rounding to tenths, so 74.96 (shown elsewhere as "1:15.0") reads "1:15", not "1:14".
  const whole = truncate ? Math.floor(Math.round(safe * 10) / 10) : Math.round(safe);
  return `${Math.floor(whole / 60)}:${pad2(whole % 60)}`;
}

/** 83.44 -> "1:23.4". Rounds to the nearest tenth; never negative, never NaN. */
export function clockTenths(seconds: number): string {
  const tenths = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 10)) : 0;
  return `${Math.floor(tenths / 600)}:${pad2(Math.floor((tenths % 600) / 10))}.${tenths % 10}`;
}

/** How long something has been running: 42 s -> "42 s", 185 s -> "3 min 05 s". Never negative. */
export function elapsedText(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes} min ${pad2(total % 60)} s` : `${total % 60} s`;
}
