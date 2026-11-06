import { seconds, type Tag, ITEM_TAGS } from '../../lib/review/logic';
import { plural } from '../../lib/words';
import type { CheckRow } from '../../lib/components/FrameCheckGrid.svelte';
import type { FrameEntry, FrameState, FramesState, ItemState, ReviewItem } from '../../lib/review/types';
import type { PieceWhy } from '../../lib/review/waiting';

const STATE: Record<FrameState, ItemState> = {
  todo: 'waiting',
  writing: 'making',
  fix: 'making',
  review: 'review',
  ok: 'ok',
  held: 'held',
  skipped: 'waiting',
};

/** How many frames the Look has: the service's total, else the plan, else the ones listed. */
export const frameTotal = (state: FramesState): number => state.total || state.planned || state.frames.length;

function toItem(frame: FrameEntry, state: FramesState): ReviewItem {
  const versions = (frame.versions ?? []).map((entry) => ({
    v: entry.v,
    path: entry.path,
    notes: entry.notes ?? 0,
  }));
  const shown = (frame.versions ?? []).find((entry) => entry.v === frame.version);
  const kept = frame.state === 'fix' && frame.fix_sent === false;
  return {
    id: frame.id,
    noun: 'frame',
    label: frame.label,
    path: frame.path ?? '',
    version: frame.version,
    versions,
    state: STATE[frame.state] ?? 'waiting',
    held: frame.held ?? null,
    inspection: frame.inspection ?? null,
    problems: shown?.problems ?? [],
    lookAt: frame.note ?? '',
    notes: frame.notes ?? [],
    pending: frame.pending_notes ?? 0,
    tablet: frame.tablet ?? null,
    okWords: state.ok_words,
    ...(kept ? { waitWords: FIX_KEPT } : {}),
  };
}

/** A frame with Fix pressed whose notes wait for the rest of the round (or Send fixes). */
export const FIX_KEPT = 'Fix kept: sent with the others when every frame has your decision, or press Send fixes.';

export const frameItems = (state: FramesState): ReviewItem[] =>
  state.frames.map((frame) => toItem(frame, state));

/** The frame's place in the list, 1-based. */
export const frameNumber = (state: FramesState, id: string): number =>
  state.frames.findIndex((f) => f.id === id) + 1;

export interface LookHead {
  kicker: string;
  title: string;
  help: string;
}

export function lookHead(state: FramesState, item: ReviewItem | null): LookHead {
  const count = frameTotal(state);
  if (!item) return { kicker: 'Look', title: 'The first frames', help: '' };
  if (state.waiting_for === 'done') {
    return {
      kicker: `Look · ${count} of ${count} frames OK`,
      title: `All ${count} frames OK`,
      help: 'Stills are drawn next, one scene at a time, in this look.',
    };
  }
  const frame = state.frames.find((entry) => entry.id === item.id);
  const hold = frame?.hold_s ? ` · holds ${seconds(frame.hold_s)}` : '';
  const rounds = (state.rounds ?? 0) > 1 ? ` · Round ${frame?.round ?? state.round} of ${state.rounds}` : '';
  return {
    kicker: `Look · Frame ${frameNumber(state, item.id)} of ${count}${hold}${rounds}`,
    title: item.label,
    help: frame?.why ? `Why this moment: ${frame.why}` : '',
  };
}

/** The words where the picture will be while it is not made. `making` = this frame is being written now. */
export function makingWords(
  state: FramesState,
  making: boolean,
  message: string,
  working = '',
): { title: string; body: string } {
  if (message) return { title: message, body: working };
  if (making && state.waiting_for === 'studio') {
    const rounds = (state.rounds ?? 0) > 1 ? ` of ${state.rounds}` : '';
    return {
      title: '◌ Writing this frame…',
      body: `Round ${state.round ?? 1}${rounds}. ${working ? `${working} ` : ''}Each frame goes through the studio's own checks before you see it.`,
    };
  }
  return { title: 'Not made yet', body: 'It is made after the frames before it are OK.' };
}

export { failedWords } from '../../lib/review/waiting';
export type FrameWhy = PieceWhy;

/**
 * Why a frame that is not made waits. Only a frame in a later round waits for the frames before it; a frame of the
 * round being made is being made, failed, or waits for something named (Dir2: SF01 said "made after the frames
 * before it" with none before it).
 */
export function frameWaitWords(state: FramesState, id: string, why: FrameWhy): string {
  const frame = state.frames.find((entry) => entry.id === id);
  if (!frame) return 'Not made yet.';
  const earlier = state.frames.filter(
    (entry) => entry.round < frame.round && entry.state !== 'ok' && entry.state !== 'skipped',
  );
  if (earlier.length) {
    return `Made after round ${frame.round - 1}'s frames are OK, so it gets what you tell us about them.`;
  }
  if (why.failed) return `Failed: ${why.failed}`;
  if (why.here) return 'Being made.';
  if (why.waiting) return `Waiting: ${why.waiting.body}`;
  return 'Not made yet.';
}

/** The picture's place for a frame that waits, from its wait words. */
export function waitPlaceholder(words: string): { title: string; body: string } {
  if (words.startsWith('Failed: ')) return { title: 'This frame could not be made', body: words.slice(8) };
  if (words === 'Being made.')
    return { title: '◌ Being made…', body: 'It goes through the studio’s own checks before you see it.' };
  if (words.startsWith('Waiting: ')) return { title: 'Waiting', body: words.slice(9) };
  return { title: 'Not made yet', body: words === 'Not made yet.' ? '' : words };
}

/** The screen with no frame listed yet: Mortiflix writing (with how long) or nothing started. */
export function noFramesWords(state: FramesState, working: string): { title: string; body: string } {
  if (state.waiting_for === 'studio') {
    return {
      title: '◌ Mortiflix is writing the first round of frames…',
      body: `${working ? `${working} ` : ''}They appear here one at a time, ready for you to check.`,
    };
  }
  return {
    title: 'No frames yet',
    body: 'Each part of your video gets one frame, in the look of your pack. Mortiflix has not started them yet.',
  };
}

/** The Frames list: every frame, by round. A frame to check that is not the active one says "Next to check". */
export function frameRows(
  state: FramesState,
  items: readonly ReviewItem[],
  activeId: string | undefined,
): CheckRow[] {
  return items.map((item, index) => {
    const frame = state.frames[index];
    const skipped = frame?.state === 'skipped';
    const tag: Tag = skipped
      ? { look: 'wait', glyph: '○', text: 'Skipped' }
      : item.state === 'review' && item.id !== activeId
        ? { ...ITEM_TAGS.review, text: 'Next to check' }
        : item.waitWords?.startsWith('Failed: ')
          ? { look: 'bad', glyph: '!', text: 'Failed' }
          : item.waitWords === FIX_KEPT
            ? { look: 'fix', glyph: '•', text: 'Fix kept' }
            : ITEM_TAGS[item.state];
    return {
      id: item.id,
      name: `${index + 1} · ${item.label}`,
      detail: frame?.hold_s ? `holds ${seconds(frame.hold_s)}` : '',
      path: item.path,
      tag,
      group: `Round ${frame?.round ?? 1}`,
    };
  });
}

export const framesLeft = (state: FramesState): number =>
  state.frames.filter((f) => f.state === 'todo').length;

/** "Stop here" is offered once every frame of the first round is OK, while some frames are not made yet. */
export const canStopEarly = (state: FramesState): boolean => {
  const first = state.frames.filter((f) => f.round === 1);
  return (
    first.length > 0 &&
    first.every((f) => f.state === 'ok') &&
    state.waiting_for !== 'done' &&
    !state.enough &&
    framesLeft(state) > 0
  );
};

/** The button's words and its hover: what stopping early does. */
export const STOP_LABEL = 'Stop here: these frames are enough';
export const stopHelp = (state: FramesState): string =>
  `The OK'd frames already set the look. Skips the ${plural(framesLeft(state), 'frame')} not made yet; Stills are then drawn in this look.`;

export const skipQuestion = (state: FramesState): string =>
  `Skip the ${plural(framesLeft(state), 'frame')} not made yet?`;

/** While something is being made, the screen reads again this often in case a push from the service was missed. */
export const REREAD_WHILE_WAITING_MS = 10_000;
