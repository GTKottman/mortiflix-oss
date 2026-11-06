// The pen marks on a picture. Points are kept as 0..1 of the picture, so they fit any size on screen.

export type MarkTool = 'pen' | 'highlighter' | 'arrow' | 'marker' | 'circle' | 'eraser';
export type Point = readonly [number, number];
export interface Mark {
  tool: Exclude<MarkTool, 'eraser'>;
  points: Point[];
  /** Its own colour; without one it takes the colour the picture is painted with. */
  colour?: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the picture sits inside a canvas when it is shown whole (letterboxed). */
export function fitBox(canvasW: number, canvasH: number, pictureW: number, pictureH: number): Box {
  const scale = Math.min(canvasW / pictureW, canvasH / pictureH);
  const w = pictureW * scale;
  const h = pictureH * scale;
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** A pointer position on the canvas as 0..1 of the picture. */
export function toPicturePoint(box: Box, canvasX: number, canvasY: number): Point {
  return [clamp((canvasX - box.x) / box.w), clamp((canvasY - box.y) / box.h)];
}

/** Distance from `p` to the segment a-b (projection clamped to the segment). */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const RING_STEPS = 48;
const HIGHLIGHT = 0.4;

/** The Video Notes app's six pen colours. */
export const MARK_COLOURS = ['#FF3B4E', '#FFD60A', '#30D158', '#0A84FF', '#FFFFFF', '#000000'] as const;
const LIGHT_MARKS: readonly string[] = ['#FFD60A', '#FFFFFF'];

/** The line the owner sees for a mark: the pen's stroke, the arrow's shaft, the circle's ring (as a polygon). */
function outline(mark: Mark): Point[] {
  const first = mark.points[0];
  const last = mark.points[mark.points.length - 1];
  if (!first || !last || mark.tool !== 'circle') return mark.points;
  const cx = (first[0] + last[0]) / 2;
  const cy = (first[1] + last[1]) / 2;
  const rx = Math.abs(last[0] - first[0]) / 2;
  const ry = Math.abs(last[1] - first[1]) / 2;
  return Array.from({ length: RING_STEPS + 1 }, (_, i): Point => {
    const angle = (i / RING_STEPS) * Math.PI * 2;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
  });
}

/** How far `at` is from what is drawn for `mark` (its line, or its stored points), 0..1 of the picture. */
function markDistance(mark: Mark, at: Point): number {
  let nearest = Infinity;
  for (const point of mark.points)
    nearest = Math.min(nearest, Math.hypot(point[0] - at[0], point[1] - at[1]));
  const line = outline(mark);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (a && b) nearest = Math.min(nearest, segmentDistance(at, a, b));
  }
  return nearest;
}

/** The index of the mark whose drawn line passes nearest to `at`, within `reach` (0..1), or -1. */
export function nearestMark(marks: readonly Mark[], at: Point, reach = 0.04): number {
  let best = -1;
  let bestDistance = reach;
  marks.forEach((mark, index) => {
    const distance = markDistance(mark, at);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Draws the marks into a 2D context, inside `box`. */
export function paintMarks(
  context: CanvasRenderingContext2D,
  box: Box,
  marks: readonly Mark[],
  colour: string,
): void {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const width = Math.max(3, box.w / 150);
  const at = (point: Point): Point => [box.x + point[0] * box.w, box.y + point[1] * box.h];
  let number = 0;
  for (const mark of marks) {
    const first = mark.points[0];
    const last = mark.points[mark.points.length - 1];
    if (!first || !last) continue;
    context.strokeStyle = mark.colour ?? colour;
    context.lineWidth = mark.tool === 'highlighter' ? width * 6 : width;
    context.globalAlpha = mark.tool === 'highlighter' ? HIGHLIGHT : 1;
    if (mark.tool === 'marker') {
      paintMarker(
        context,
        at(first),
        Math.max(12, Math.min(box.w, box.h) / 24),
        ++number,
        mark.colour ?? colour,
      );
      continue;
    }
    context.beginPath();
    if (mark.tool === 'pen' || mark.tool === 'highlighter') {
      mark.points.forEach((point, index) => {
        const [x, y] = at(point);
        if (index) context.lineTo(x, y);
        else context.moveTo(x, y);
      });
    } else if (mark.tool === 'circle') {
      const [ax, ay] = at(first);
      const [zx, zy] = at(last);
      context.ellipse(
        (ax + zx) / 2,
        (ay + zy) / 2,
        Math.abs(zx - ax) / 2 + 1,
        Math.abs(zy - ay) / 2 + 1,
        0,
        0,
        Math.PI * 2,
      );
    } else {
      const [ax, ay] = at(first);
      const [zx, zy] = at(last);
      const angle = Math.atan2(zy - ay, zx - ax);
      const head = context.lineWidth * 5;
      context.moveTo(ax, ay);
      context.lineTo(zx, zy);
      for (const turn of [2.6, -2.6]) {
        context.moveTo(zx, zy);
        context.lineTo(zx + head * Math.cos(angle + turn), zy + head * Math.sin(angle + turn));
      }
    }
    context.stroke();
  }
  context.globalAlpha = 1;
}

/** A numbered dot, as on the tablet: light figures on the dark colours, dark on the light ones. */
function paintMarker(
  context: CanvasRenderingContext2D,
  [x, y]: Point,
  radius: number,
  number: number,
  colour: string,
): void {
  context.globalAlpha = 1;
  context.fillStyle = colour;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = LIGHT_MARKS.includes(colour.toUpperCase()) ? '#000000' : '#FFFFFF';
  context.font = `800 ${radius * 1.2}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(number), x, y);
}
