// Waveform shapes for audio clips. Real peaks come from the service (`audio.peaks`); until they arrive, or when the
// service has none, a steady pseudo-random shape per clip is drawn so a clip always looks the same.

/** One peak per bucket, 0 (silent) to 1 (loudest). */
export type Peaks = readonly number[];

const PEAKS_PER_SECOND = { voice: 10, music: 4 } as const;
const MIN_BUCKETS = 12;
const MAX_BUCKETS = 220;

/** How many peaks a clip of this length needs. */
export function bucketCount(seconds: number, music: boolean): number {
  const perSecond = music ? PEAKS_PER_SECOND.music : PEAKS_PER_SECOND.voice;
  return Math.max(MIN_BUCKETS, Math.min(MAX_BUCKETS, Math.round(seconds * perSecond)));
}

export function hashString(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** A stand-in shape: speech-like bursts for voice, a slow swell for music. */
export function placeholderPeaks(seed: string, count: number, music: boolean): number[] {
  let state = hashString(seed);
  const phase = state % 7;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0;
    return (state % 1000) / 1000;
  };
  return Array.from({ length: count }, (_, i) => {
    const envelope = music
      ? 0.35 + 0.3 * Math.sin((i / count) * 12.6 + phase) + random() * 0.2
      : (0.2 + random() * 0.8) * Math.pow(Math.sin((Math.PI * (i + 0.5)) / count), 0.4);
    return Math.max(0.06, Math.min(1, envelope));
  });
}

/** SVG path data (viewBox 0 0 100 100): one vertical stroke per peak, centred. */
export function wavePath(peaks: Peaks): string {
  const count = peaks.length;
  let path = '';
  peaks.forEach((peak, i) => {
    const half = Math.max(0.04, Math.min(1, peak)) * 46;
    const x = (((i + 0.5) * 100) / count).toFixed(2);
    path += `M${x} ${(50 - half).toFixed(2)}V${(50 + half).toFixed(2)}`;
  });
  return path;
}
