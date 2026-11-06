import { describe, expect, it } from 'vitest';
import { clampTime, markerPercent, stepFrame } from '../src/lib/player/time';

describe('clampTime', () => {
  it('keeps a time inside the video', () => {
    expect(clampTime(-1, 10)).toBe(0);
    expect(clampTime(12, 10)).toBe(10);
    expect(clampTime(4, 10)).toBe(4);
  });
});

describe('stepFrame', () => {
  it('lands on the next and previous frame', () => {
    expect(stepFrame(1, 1, 30, 60)).toBeCloseTo(1 + 1 / 30);
    expect(stepFrame(1, -1, 30, 60)).toBeCloseTo(1 - 1 / 30);
  });
  it('snaps a time between frames to a frame', () => {
    expect(stepFrame(1.01, 1, 30, 60)).toBeCloseTo(31 / 30);
  });
  it('stops at both ends', () => {
    expect(stepFrame(0, -1, 30, 60)).toBe(0);
    expect(stepFrame(60, 1, 30, 60)).toBe(60);
  });
});

describe('markerPercent', () => {
  it('places a marker along the timeline', () => {
    expect(markerPercent(15, 60)).toBe(25);
    expect(markerPercent(90, 60)).toBe(100);
  });
  it('is 0 while the length is unknown', () => {
    expect(markerPercent(5, 0)).toBe(0);
  });
});
