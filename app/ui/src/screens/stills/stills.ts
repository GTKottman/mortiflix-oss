import type { CheckRow } from '../../lib/components/FrameCheckGrid.svelte';
import { ITEM_TAGS, type Tag } from '../../lib/review/logic';
import type { PieceWhy } from '../../lib/review/waiting';
import type {
  ItemState,
  ItemVersion,
  ReviewItem,
  ReviewNote,
  SceneState,
  StillGroup,
  StillLine,
  StillLineState,
  StillsState,
} from '../../lib/review/types';

/** A note from `notes.list`: which piece it is on is `node`. */
export type NodeNote = ReviewNote & { node: string };

/** One still with the scene it belongs to: the review item plus what only Stills needs. */
export interface StillView {
  item: ReviewItem;
  group: StillGroup;
  /** 0-based place in the scene. */
  position: number;
  words: string;
  /** The service's own state for the line, before it is mapped to the shared one. */
  lineState: StillLineState;
}

const STATE: Record<StillLineState, ItemState> = {
  todo: 'waiting',
  drawing: 'making',
  fix: 'making',
  check: 'review',
  held: 'held',
  ok: 'ok',
};

const clean = (value: string | undefined): string => value ?? '';
const beatOf = (line: string): string => line.replace(/-\d+$/, '');

/** The scenes: from the service, or (demo studio) made from the lines' beats. */
export function sceneGroups(state: StillsState): StillGroup[] {
  if (state.groups?.length) return state.groups;
  const beats: string[] = [];
  for (const line of state.lines) {
    const beat = line.beat ?? beatOf(line.line);
    if (!beats.includes(beat)) beats.push(beat);
  }
  return beats.map((beat, index) => {
    const lines = state.lines.filter((line) => (line.beat ?? beatOf(line.line)) === beat);
    const sceneState: SceneState = lines.every((line) => line.state === 'ok')
      ? 'ok'
      : lines.some((line) => line.path)
        ? 'review'
        : 'waiting';
    return {
      beat,
      name: `Scene ${index + 1}`,
      index: index + 1,
      count: lines.length,
      lines: lines.map((l) => l.line),
      state: sceneState,
    };
  });
}

/** The line's versions as a list. A bare count means paths follow the -vN.png naming. */
export function lineVersions(line: StillLine): ItemVersion[] {
  if (Array.isArray(line.versions))
    return line.versions.map((v) => ({ v: v.v, path: v.path, notes: v.notes ?? 0 }));
  const count = Number(line.versions) || (line.path ? 1 : 0);
  const out: ItemVersion[] = [];
  for (let v = 1; v <= count; v++) {
    const path =
      v === line.version ? clean(line.path) : clean(line.path).replace(/-v\d+(\.\w+)$/, `-v${v}$1`);
    out.push({ v, path, notes: 0 });
  }
  return out;
}

const isNamed = (group: StillGroup): boolean => Boolean(group.name) && !/^Scene \d+$/.test(group.name);

export function stillViews(state: StillsState, notes: readonly NodeNote[]): StillView[] {
  const groups = sceneGroups(state);
  const last = groups[groups.length - 1];
  return state.lines.map((line) => {
    const group = groups.find((entry) => entry.lines.includes(line.line)) ?? {
      beat: '',
      name: '',
      index: 1,
      count: 1,
      lines: [line.line],
      state: 'waiting' as const,
    };
    const position = group.lines.indexOf(line.line);
    const mine = line.notes ?? notes.filter((note) => note.node === line.line);
    const lastOfScene = position === group.lines.length - 1;
    const lastOfAll = group === last && lastOfScene;
    const item: ReviewItem = {
      id: line.line,
      noun: 'still',
      label: `Scene ${group.index}${isNamed(group) ? ' · ' + group.name : ''} · still ${position + 1} of ${group.lines.length}`,
      path: line.path ?? '',
      version: line.version ?? 1,
      versions: lineVersions(line),
      state: STATE[line.state] ?? 'waiting',
      held: line.held ?? null,
      inspection: line.inspection ?? null,
      problems: line.state === 'ok' ? [] : [...(line.error ? [line.error] : []), ...(line.problems ?? [])],
      lookAt: line.why ?? '',
      notes: mine,
      pending: line.pending_notes ?? mine.filter((note) => note.pending).length,
      tablet: line.tablet ?? null,
      okWords: {
        notes: 'OK · Remake this still',
        none: lastOfAll ? 'OK · Done' : lastOfScene ? 'OK · Next group' : 'OK · Next still',
      },
      ...(line.key_word ? { keyWord: line.key_word } : {}),
      keyVisible: line.check?.key_word_visible ?? null,
    };
    return { item, group, position, words: line.words, lineState: line.state };
  });
}

export const sceneTitle = (group: StillGroup): string =>
  isNamed(group) ? group.name : `Scene ${group.index}`;

export interface StillsHead {
  kicker: string;
  title: string;
  help: string;
}

export function stillsHead(state: StillsState, view: StillView | null): StillsHead {
  const groups = sceneGroups(state);
  if (!view) return { kicker: 'Stills', title: 'The stills', help: '' };
  if (state.lines.length && state.lines.every((line) => line.state === 'ok')) {
    return {
      kicker: `Stills · ${groups.length} of ${groups.length} scenes OK`,
      title: `All ${state.lines.length} stills OK`,
      help: 'Motion makes scene 1 first, from these same pictures.',
    };
  }
  return {
    kicker: `Stills · Scene ${view.group.index} of ${groups.length} · Still ${view.position + 1} of ${view.group.lines.length}`,
    title: sceneTitle(view.group),
    help: '',
  };
}

/**
 * The words where the picture will be while there is none. `working` is how long the screen has seen drawing run
 * ("Working for 1:05."), or '' when it does not know.
 */
export function makingWords(
  view: StillView | null,
  message: string,
  working = '',
): { title: string; body: string } {
  if (message) return { title: `◌ ${message}`, body: working };
  if (view?.lineState === 'drawing') {
    const why =
      'The whole scene is drawn together so its stills match, then each is checked before you see it.';
    return { title: `◌ Drawing scene ${view.group.index}…`, body: working ? `${working} ${why}` : why };
  }
  if (view?.lineState === 'fix') {
    const why = 'Drawing this still again with your notes. It is checked before you see it.';
    return { title: '◌ Drawing this still again…', body: working ? `${working} ${why}` : why };
  }
  if (view?.item.problems.length) {
    return { title: 'This still could not be drawn', body: view.item.problems[0] ?? '' };
  }
  // the reason a still waits (the scene before, the project) comes from stillWaitWords; here nothing is waited for
  if (view) return stillPlaceholder('Not made yet.');
  return { title: '', body: '' };
}

/** The render failed: the service keeps state "check" with an error and no picture. */
export const drawFailed = (view: StillView): boolean =>
  view.lineState === 'check' && !view.item.path && view.item.problems.length > 0;

const FAILED_TAG: Tag = { look: 'bad', glyph: '✕', text: 'Failed' };
const WAITING_TAG: Tag = { look: 'wait', glyph: '○', text: 'Waiting' };

/**
 * Why a still with no picture is not there, as Look and Motion say it: "Failed: <the still's own error, else the
 * project's own words>", "Being made." (the service draws Stills now), "Waiting: <what>" (nothing runs), or a still
 * of a later scene that is drawn after the scene before it is OK. null = it has a picture.
 */
export function stillWaitWords(view: StillView, views: readonly StillView[], why: PieceWhy): string | null {
  if (drawFailed(view)) return `Failed: ${view.item.problems[0] ?? ''}`;
  if (view.item.path) return null;
  const before = view.group.index - 1;
  const open = views.some((other) => other.group.index === before && other.item.state !== 'ok');
  if (view.lineState === 'todo' && before > 0 && open)
    return `Made after scene ${before} is OK, so it gets what you tell us about it.`;
  if (why.failed) return `Failed: ${why.failed}`;
  if (why.here && (view.lineState === 'drawing' || view.lineState === 'fix')) return 'Being made.';
  if (why.waiting) return `Waiting: ${why.waiting.body}`;
  return 'Not made yet.';
}

/** The tag for a still that is not there, from its wait words; null = its own state's tag. */
function waitTag(words: string | null): Tag | null {
  if (!words) return null;
  if (words.startsWith('Failed: ')) return FAILED_TAG;
  if (words === 'Being made.') return ITEM_TAGS.making;
  if (words.startsWith('Waiting: ')) return WAITING_TAG;
  return null;
}

/** The picture's place for a still that is not there, from its wait words. */
export function stillPlaceholder(words: string): { title: string; body: string } {
  if (words.startsWith('Failed: ')) return { title: 'This still could not be drawn', body: words.slice(8) };
  if (words.startsWith('Waiting: ')) return { title: 'Waiting', body: words.slice(9) };
  return { title: 'Not drawn yet', body: words === 'Not made yet.' ? '' : words };
}

/** This scene's stills as grid rows. */
export function sceneStillRows(
  views: readonly StillView[],
  scene: StillGroup,
  activeId: string | undefined,
  why: PieceWhy = { here: false, failed: '', waiting: null },
): CheckRow[] {
  return views
    .filter((view) => view.group === scene)
    .map((view) => ({
      id: view.item.id,
      name: `Still ${view.position + 1}`,
      detail: view.words,
      path: view.item.path,
      tag:
        waitTag(stillWaitWords(view, views, why)) ??
        (view.item.state === 'review' && view.item.id !== activeId
          ? { ...ITEM_TAGS.review, text: 'Next to check' }
          : ITEM_TAGS[view.item.state]),
    }));
}

export const SCENE_TAGS: Record<SceneState, Tag> = {
  ok: { look: 'ok', glyph: '✓', text: 'OK' },
  review: { look: 'fix', glyph: '→', text: 'Your check' },
  making: { look: 'busy', glyph: '◌', text: 'Drawing' },
  fixing: { look: 'fix', glyph: '!', text: 'Being fixed' },
  waiting: { look: 'wait', glyph: '○', text: 'Waits' },
};

/** The Scenes list tag: a scene that waits says which scene it waits for. */
export function sceneTag(group: StillGroup): Tag {
  const tag = SCENE_TAGS[group.state] ?? SCENE_TAGS.waiting;
  if (group.state !== 'waiting') return tag;
  return { ...tag, text: `Waits for ${group.index > 1 ? `scene ${group.index - 1}` : 'the look'}` };
}

/** "Draw all" (demo studio only): nothing to do, drawing now, or ready. */
export type DrawAll = { kind: 'none' } | { kind: 'busy'; text: string } | { kind: 'ready'; count: number };

export function drawAllState(state: StillsState, making: { total: number } | null): DrawAll {
  if (state.mode !== 'lines') return { kind: 'none' };
  const drawing = state.lines.filter((line) => line.state === 'drawing' && !line.path).length;
  const unmade = state.lines.filter((line) => !line.path && line.state !== 'drawing').length;
  if (making || drawing) {
    const left = unmade + drawing;
    const total = making?.total || left;
    return { kind: 'busy', text: `Drawing ${Math.min(total - left + 1, total)} of ${total}` };
  }
  return unmade ? { kind: 'ready', count: unmade } : { kind: 'none' };
}

/** Draw-all is over once nothing is being drawn and every line has a picture or an error. */
export const drawingFinished = (state: StillsState): boolean =>
  !state.lines.some((line) => line.state === 'drawing' || (!line.path && !line.error));

export const sceneOkCount = (groups: readonly StillGroup[]): number =>
  groups.filter((group) => group.state === 'ok').length;

/** While something is being made, the screen reads again this often in case a push from the service was missed. */
export const REREAD_WHILE_WAITING_MS = 10_000;
