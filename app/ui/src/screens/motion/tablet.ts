import type { Tag } from '../../lib/review/logic';
import { plural } from '../../lib/words';
import type { VideoNotesStatus } from '../../lib/review/types';
import type { SceneTablet } from './types';

/** The tablet pill for one scene: the words, and what it offers. */
export interface TabletLine extends Tag {
  /** The pill opens a menu (send again, stop sending). */
  menu: boolean;
  /** The pill ends with a link to Settings. */
  link: boolean;
  /** The send failed: a Resend button sits next to the pill. */
  resend?: boolean;
}

/** False when Video Notes is on and has no address the tablet can reach. */
export const tabletReachable = (status: VideoNotesStatus | null): boolean =>
  !(status?.enabled && status.problems?.length && !(status.addresses ?? []).some((a) => a.reachable));

export interface TabletFacts {
  status: VideoNotesStatus | null;
  /** What the tablet says about this scene. */
  scene: SceneTablet | null | undefined;
  /** 0-based index of the scene and how many there are. */
  index: number;
  total: number;
  /** The newest version number of this scene. */
  latest: number;
}

/** What to say about the tablet; null when Video Notes is off (nothing is shown). */
export function tabletLine({ status, scene, index, total, latest }: TabletFacts): TabletLine | null {
  if (!status?.enabled) return null;
  const line = (look: Tag['look'], glyph: string, text: string, menu = true): TabletLine => ({
    look,
    glyph,
    text,
    menu,
    link: false,
  });
  if (!tabletReachable(status))
    return line('bad', '✕', 'Can’t reach the tablet. Notes can still be added here.');
  if (!scene) {
    return status.tablet_seen
      ? line('wait', '○', 'This scene is not on your tablet yet. Notes are entered here.')
      : { ...line('wait', '○', 'No tablet linked. Notes are entered here only.', false), link: true };
  }
  if (scene.status === 'not sent') {
    const why = scene.error ? `: ${scene.error}` : '.';
    return { ...line('bad', '✕', `Not sent to your tablet${why}`), resend: true };
  }
  if (scene.status === 'reviewing') {
    return line(
      'busy',
      '◌',
      `Your tablet is reviewing this scene. Its notes are entered on the tablet (${plural(scene.notes ?? 0, 'note')} so far).`,
    );
  }
  if (scene.status === 'done') {
    if (scene.notes) {
      return line(
        'fix',
        '!',
        `Tablet sent OK with ${plural(scene.notes, 'note')}. Remaking this scene as Version ${latest + 1}.`,
      );
    }
    return line(
      'ok',
      '✓',
      index + 1 < total
        ? `Tablet sent OK with no notes. Making scene ${index + 2}.`
        : 'Tablet sent OK with no notes. This was the last scene.',
    );
  }
  return line('wait', '○', 'Sent to your tablet, not opened yet. Notes can be added here meanwhile.');
}
