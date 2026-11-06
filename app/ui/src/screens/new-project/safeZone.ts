// The drawing of a platform's safe zone: where titles can sit without being cropped or covered.

export interface SafeZoneShape {
  width: number;
  height: number;
  /** Margin kept clear on every side. */
  margin: number;
  /** Rectangles the platform's own buttons and caption cover (tall shapes only). */
  covered: { x: number; y: number; width: number; height: number }[];
}

const HEIGHT = 90;
const MARGIN_SHARE = 0.08;
const TALL_FROM = 1.2;

export function safeZoneShape(aspect: string): SafeZoneShape {
  const [across, down] = aspect.split(':').map(Number);
  if (!across || !down) return safeZoneShape('16:9');
  const width = Math.round((HEIGHT * across) / down);
  const tall = down / across > TALL_FROM;
  const covered = tall
    ? [
        {
          x: width - Math.round(width * 0.16),
          y: Math.round(HEIGHT * 0.4),
          width: Math.round(width * 0.16),
          height: Math.round(HEIGHT * 0.4),
        },
        { x: 0, y: Math.round(HEIGHT * 0.8), width, height: Math.round(HEIGHT * 0.2) },
      ]
    : [];
  return { width, height: HEIGHT, margin: Math.round(width * MARGIN_SHARE), covered };
}

/** The red areas are explained only when the drawing has them (9:16 and 4:5). */
export const safeZoneNote = (aspect: string): string =>
  safeZoneShape(aspect).covered.length
    ? 'Dashed line: keep titles inside it. Red: covered by the platform buttons and caption.'
    : 'Dashed line: keep titles inside it. Edges can be cropped on some screens.';
