import { describe, expect, it } from 'vitest';
import { rulerStep, snapTime } from '../src/lib/audio/time';
import { bucketCount, placeholderPeaks, wavePath } from '../src/lib/audio/waveform';

describe('audio time', () => {
  it('spaces the ruler by the length of the piece', () => {
    expect([30, 90, 300, 900].map(rulerStep)).toEqual([5, 10, 30, 120]);
  });

  it('snaps to the nearest edge in reach and otherwise keeps the time', () => {
    expect(snapTime(4.9, [0, 5, 9], 0.3)).toBe(5);
    expect(snapTime(4.0, [0, 5, 9], 0.3)).toBe(4.0);
    expect(snapTime(1, [], 1)).toBe(1);
  });
});

describe('waveform', () => {
  it('sizes the peaks by length, within bounds', () => {
    expect(bucketCount(0.2, false)).toBe(12);
    expect(bucketCount(3, false)).toBe(30);
    expect(bucketCount(3, true)).toBe(12);
    expect(bucketCount(900, false)).toBe(220);
  });

  it('draws the same placeholder for the same seed', () => {
    const a = placeholderPeaks('b01-1', 30, false);
    expect(a).toEqual(placeholderPeaks('b01-1', 30, false));
    expect(a).not.toEqual(placeholderPeaks('b01-2', 30, false));
    expect(a.every((p) => p >= 0.06 && p <= 1)).toBe(true);
  });

  it('turns peaks into one stroke each', () => {
    expect(wavePath([1, 0]).match(/M/g)).toHaveLength(2);
    expect(wavePath([])).toBe('');
  });
});
