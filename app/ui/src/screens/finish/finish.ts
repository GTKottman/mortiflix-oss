import type {
  Blocker,
  Check,
  Counts,
  FilmInfo,
  FinalState,
  FinalStatus,
  FixTarget,
  GraphAnswer,
  HandoffPlan,
  VoiceMusicAnswer,
} from './types';
import { clock } from '../../lib/time';
import { plural } from '../../lib/words';

// The Finish screen's rules, free of markup so they can be tested.

const BYTES_PER_GB = 1e9;
const BYTES_PER_MB = 1e6;

/** 84,000,000 -> "84 MB", 1.2e9 -> "1.2 GB". */
export function formatSize(bytes: number): string {
  return bytes > BYTES_PER_GB
    ? `${(bytes / BYTES_PER_GB).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / BYTES_PER_MB))} MB`;
}

/** "1:00 · 1920×1080 · 30 fps · MP4 · 84 MB": only what is known. Picture size comes from the file once it loads. */
export function specLine(
  status: FinalStatus,
  film: FilmInfo | null,
  picture: { width: number; height: number } | null,
): string {
  const width = picture?.width ?? film?.width;
  const height = picture?.height ?? film?.height;
  return [
    clock(status.length_sec ?? film?.lengthSec ?? 0),
    width && height ? `${width}×${height}` : '',
    film?.fps ? `${film.fps} fps` : '',
    'MP4',
    status.size ? formatSize(status.size) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "6 shots · 18 voice lines · 1 music piece · 14 effects · 27 captions" */
export function productionSummary(counts: Counts): string {
  return [
    plural(counts.shots, 'shot'),
    plural(counts.lines, 'voice line'),
    counts.music ? plural(counts.music, 'music piece') : 'no music',
    counts.sfx ? plural(counts.sfx, 'effect') : 'no effects',
    plural(counts.captions, 'caption'),
  ].join(' · ');
}

/** The sentence that stops the video being made, with where to fix it; null when nothing does. */
export function blockerFor(film: FilmInfo | null, checks: readonly Check[] | null): Blocker | null {
  if (film && film.shotsTotal && film.shotsMade < film.shotsTotal) {
    const missing = film.shotsTotal - film.shotsMade;
    const verb = film.shotsTotal === 1 ? 'shot is' : 'shots are';
    return {
      text: `${missing} of ${film.shotsTotal} ${verb} not made yet, so the video can't be put together.`,
      label: 'Go to Motion ›',
      target: { route: '/motion' },
    };
  }
  const failed = checks?.find((check) => check.ok === false && check.checked !== false && check.items?.[0]);
  const item = failed?.items?.[0];
  if (!failed || !item) return null;
  const onSound = failed.key === 'sound';
  return {
    text: `${item.shot ? `${item.shot.toUpperCase()}: ` : ''}${item.text || 'Something looks wrong.'}`,
    label: onSound ? 'Go to Sound ›' : 'Go to Motion ›',
    target: { route: onSound ? '/sound' : '/motion', shot: item.shot },
  };
}

/** The router path for a fix target, e.g. "/motion?shot=b02". */
export const pathFor = (target: FixTarget): string =>
  target.shot ? `${target.route}?shot=${encodeURIComponent(target.shot)}` : target.route;

/** "made 2026-11-02T03:58:12.123Z" read as the owner's own date and time (MDN Intl.DateTimeFormat, dateStyle /
 *  timeStyle); a value that is not a date is left out rather than shown raw. */
export function madeWhen(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Opening in ArtCraft writes a new ArtCraft project over the last one (artcraft.mjs: the old file is removed first),
 *  so changes made there by hand are lost: the owner is told before, not after. */
export const ARTCRAFT_REBUILDS =
  'This makes a new ArtCraft project from the film and replaces the last one. Changes you made there by hand are lost.';

/** The file's own name from its path. */
export const fileName = (path: string | undefined): string => path?.split('/').pop() || 'final.mp4';

/** The film's receipt and title from the three service answers. */
export function filmFrom(graph: GraphAnswer, voice: VoiceMusicAnswer, plan: HandoffPlan): FilmInfo {
  const clips = plan.clips ?? [];
  const count = (kind: string, track?: string) =>
    clips.filter((clip) => clip.kind === kind || (track !== undefined && clip.track === track)).length;
  const shots = (graph.nodes ?? []).filter((node) => node.kind === 'shot');
  return {
    title: plan.title || plan.sequence?.name || '',
    width: plan.sequence?.width,
    height: plan.sequence?.height,
    fps: plan.sequence?.fps,
    lengthSec: voice.length_sec ?? plan.sequence?.length_sec ?? 0,
    shotsTotal: shots.length,
    shotsMade: shots.filter((node) => (node.versions ?? []).some((version) => version.path)).length,
    poster: voice.shots?.[0]?.media?.path,
    counts: {
      shots: count('shot'),
      lines: count('line'),
      music: count('music', 'A2'),
      sfx: count('sfx', 'A3') || count('sound'),
      captions: (plan.captions ?? []).length,
      markers: (plan.markers ?? []).length,
    },
  };
}

/** Where the video stands in the render queue; an unknown count is said as unknown, never as a number. */
export function queueWords(ahead: number | undefined): string {
  if (ahead === undefined) return 'Other renders are ahead of it.';
  if (ahead === 0) return 'It is next in the queue.';
  return `${ahead} render${ahead === 1 ? '' : 's'} ahead of it.`;
}

/** The line under the title: what state the video is in. */
export function headLede(state: FinalState, lost: boolean): string {
  if (lost) return 'The file is gone. Make it again and it will appear here.';
  switch (state) {
    case 'done':
      return 'Your finished video is ready to review and download.';
    case 'stale':
      return 'This is the earlier version. Something changed after it was made.';
    case 'rendering':
      return 'Putting the shots, voice and sound together. This page updates by itself.';
    case 'none':
      return 'The finished film, with its voice, music and sounds.';
  }
}
