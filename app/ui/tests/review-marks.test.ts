import { describe, expect, it } from 'vitest';
import { fitBox, nearestMark, toPicturePoint, type Mark } from '../src/lib/review/marks';

describe('marks', () => {
  it('fits a 16:9 picture whole inside a taller canvas', () => {
    const box = fitBox(800, 800, 1600, 900);
    expect(box.w).toBe(800);
    expect(box.h).toBe(450);
    expect(box.y).toBe(175);
  });

  it('keeps pointer points inside the picture, as 0..1', () => {
    const box = { x: 0, y: 100, w: 800, h: 450 };
    expect(toPicturePoint(box, 400, 325)).toEqual([0.5, 0.5]);
    expect(toPicturePoint(box, -50, 9000)).toEqual([0, 1]);
  });

  it('finds the mark nearest a click, or none', () => {
    const marks: Mark[] = [
      {
        tool: 'pen',
        points: [
          [0.1, 0.1],
          [0.2, 0.2],
        ],
      },
      {
        tool: 'circle',
        points: [
          [0.7, 0.7],
          [0.9, 0.9],
        ],
      },
    ];
    expect(nearestMark(marks, [0.71, 0.7])).toBe(1);
    expect(nearestMark(marks, [0.5, 0.5])).toBe(-1);
  });
});
