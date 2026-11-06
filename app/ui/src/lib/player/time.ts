// The small calculations behind the video player, kept apart from the markup so they can be tested.

/** Keeps a time inside the video. */
export function clampTime(seconds: number, duration: number): number {
  return Math.max(0, Math.min(Number.isFinite(duration) ? duration : 0, seconds));
}

/** The time one frame before (-1) or after (+1) `seconds`, landing on a frame boundary. */
export function stepFrame(seconds: number, direction: 1 | -1, fps: number, duration: number): number {
  const frame = 1 / fps;
  const next = (Math.round(seconds * fps) + direction) * frame;
  return clampTime(next, duration);
}

/** Where a marker sits along the timeline, 0 to 100 (percent). */
export function markerPercent(time: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return (clampTime(time, duration) / duration) * 100;
}

/** The speeds the player offers. */
export const SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
