// Time on an audio timeline: the ruler's spacing and the snap rule.

/** Seconds between ruler ticks, so a short piece and a long one both read well. */
export function rulerStep(length: number): number {
  if (length > 600) return 120;
  if (length > 180) return 30;
  if (length > 60) return 10;
  return 5;
}

/** The nearest edge within `reach` seconds of `time`, else `time` itself. */
export function snapTime(time: number, edges: readonly number[], reach: number): number {
  let best = time;
  let nearest = reach;
  for (const edge of edges) {
    const distance = Math.abs(edge - time);
    if (distance < nearest) {
      nearest = distance;
      best = edge;
    }
  }
  return best;
}

/** How far a click may be from an edge to snap to it: 8 screen pixels. */
export const SNAP_PIXELS = 8;
