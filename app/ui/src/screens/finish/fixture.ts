import { fileUrl } from '../../lib/files';
import type { FinishApi } from './api';
import type { Counts, FinalStatus } from './types';

// The review fixtures (web/screens/finish.fixture.json): the screen's states without the service.
// Open /app/?fixture=none|blocked|rendering|queued|done|stale|error|missing#/finish. Nothing is ever called.

interface FixtureFile {
  title: string;
  poster: string;
  video: string;
  path: string;
  total: number;
  made: number;
  len: number;
  seq: { width: number; height: number; fps: number };
  counts: Counts;
  states: Record<string, FinalStatus & { made?: number; missing?: boolean }>;
}

const GONE = '/tmp/mfx-test-studio/fixtures/gone.mp4';
/** The app's own short clip, so the fixture plays without any studio file. */
const CLIP = '/screens/fixtures/clip.mp4';

export async function fixtureApi(name: string): Promise<FinishApi> {
  const response = await fetch('/screens/finish.fixture.json');
  const file = (await response.json()) as FixtureFile;
  let current = file.states[name] ?? file.states.none ?? { state: 'none' };

  const asStatus = (state: typeof current): FinalStatus => ({ ...state, file: file.path });
  return {
    status: async () => asStatus(current),
    make: async () => {
      current = file.states.rendering ?? current;
    },
    cancel: async () => {
      current = file.states.none ?? current;
    },
    film: async () => ({
      title: file.title,
      width: file.seq.width,
      height: file.seq.height,
      fps: file.seq.fps,
      lengthSec: file.len,
      shotsTotal: file.total,
      shotsMade: current.made ?? file.made,
      counts: file.counts,
    }),
    checks: async () => null,
    playSrc: () => (current.missing ? fileUrl(GONE) : CLIP),
    posterSrc: () => file.poster,
    openInArtCraft: async () => undefined,
  };
}
