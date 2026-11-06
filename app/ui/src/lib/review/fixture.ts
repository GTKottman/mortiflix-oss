import { ServiceError, type Listener as ReviewListener } from '../service/client';
import type {
  DecisionResult,
  FrameEntry,
  FramesState,
  Lesson,
  PoolInfo,
  ReviewNote,
  ReviewService,
  StillLine,
  StillsState,
  VideoNotesStatus,
} from './types';

// A stand-in service for screenshots and click-through: `#/look?fixture=review` runs the screen on
// web/screens/look.fixture.json with no service call, and actions change a local copy. Never reaches the real service.

interface FixtureFile {
  frames: Record<string, FramesState>;
  stills: Record<string, StillsState>;
  lessons: Lesson[];
  videonotes: VideoNotesStatus;
  pool: PoolInfo;
}

export type FixtureKind = 'frames' | 'stills';

type Params = Record<string, unknown>;
type Listener = (data: unknown, event: string) => void;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function createReviewFixture(kind: FixtureKind, scenario: string): Promise<ReviewService> {
  const reply = await fetch('/screens/look.fixture.json');
  if (!reply.ok) throw new Error(`the fixture file did not load (${reply.status})`);
  const all = (await reply.json()) as FixtureFile;
  const scenarios = (all[kind] ?? {}) as Record<string, FramesState | StillsState>;
  const start = scenarios[scenario] ?? scenarios['review'];
  if (!start) throw new Error(`the fixture has no "${scenario}" or "review" scenario for ${kind}`);
  const frames = kind === 'frames' ? copy(start as FramesState) : null;
  const stills = kind === 'stills' ? copy(start as StillsState) : null;
  const lessons = copy(all.lessons);
  const listeners = new Map<string, Set<Listener>>();
  let noteCount = 100;

  const changed = () => {
    for (const listener of listeners.get(`${kind}.changed`) ?? []) listener(null, `${kind}.changed`);
  };
  const later = (work: () => void, ms = 1400) =>
    setTimeout(() => {
      work();
      changed();
    }, ms);

  const frameOf = (id: string): FrameEntry => {
    const found = frames?.frames.find((frame) => frame.id === id);
    if (!found) throw new ServiceError(`No frame ${id}`);
    return found;
  };
  const lineOf = (id: string): StillLine => {
    const found = stills?.lines.find((line) => line.line === id);
    if (!found) throw new ServiceError(`No still ${id}`);
    return found;
  };
  const addNote = (id: string, words: string): void => {
    const note: ReviewNote = { id: `n${++noteCount}`, text: words, image: null, pending: true, lesson: null };
    const entry = frames ? frameOf(id) : lineOf(id);
    entry.notes = [...(entry.notes ?? []), note];
    entry.pending_notes = (entry.pending_notes ?? 0) + 1;
  };
  const sendNotes = (entry: FrameEntry | StillLine): void => {
    for (const note of entry.notes ?? []) note.pending = false;
    entry.pending_notes = 0;
  };

  const frameCalls: Record<string, (p: Params) => unknown> = {
    'frames.get': () => copy(frames),
    'frames.ok': (p) => {
      const state = frames as FramesState;
      const frame = frameOf(text(p['frame']));
      frame.state = 'ok';
      state.ok = state.frames.filter((x) => x.state === 'ok').length;
      if (state.frames.some((x) => x.state === 'review' || x.state === 'held'))
        return { next: 'wait' } satisfies DecisionResult;
      const todo = state.frames.filter((x) => x.state === 'todo');
      if (!todo.length) {
        state.waiting_for = 'done';
        return { next: 'done' } satisfies DecisionResult;
      }
      state.waiting_for = 'studio';
      state.round = (state.round ?? 1) + 1;
      for (const next of todo.slice(0, 3)) {
        next.state = 'writing';
        next.round = state.round;
      }
      later(() => {
        for (const next of state.frames.filter((x) => x.state === 'writing')) {
          next.state = 'review';
          next.path = frame.path ?? '';
          next.version = 1;
          next.versions = [{ v: 1, path: next.path, notes: 0, problems: [], inspection: null }];
        }
        state.waiting_for = 'you';
      }, 2200);
      return { next: 'round' } satisfies DecisionResult;
    },
    'frames.fix': (p) => {
      const frame = frameOf(text(p['frame']));
      if (p['text']) addNote(frame.id, text(p['text']));
      frame.state = 'fix';
      sendNotes(frame);
      later(() => {
        frame.version++;
        frame.versions = [
          ...(frame.versions ?? []),
          { v: frame.version, path: frame.path ?? '', notes: 0, problems: [] },
        ];
        frame.state = 'review';
      });
      return { fixing: frame.id };
    },
    'frames.send_anyway': (p) => {
      const frame = frameOf(text(p['frame']));
      frame.state = 'review';
      frame.held = null;
      frame.inspection = { ...(frame.inspection ?? {}), sent_anyway: true };
      return {};
    },
    'frames.retry': (p) => {
      const frame = frameOf(text(p['frame']));
      frame.state = 'fix';
      later(() => {
        frame.version++;
        frame.versions = [
          ...(frame.versions ?? []),
          { v: frame.version, path: frame.path ?? '', notes: 0, problems: [] },
        ];
        frame.state = 'review';
        frame.held = null;
      });
      return {};
    },
    'frames.enough': () => {
      const state = frames as FramesState;
      for (const frame of state.frames) if (frame.state === 'todo') frame.state = 'skipped';
      state.enough = true;
      if (!state.frames.some((x) => x.state === 'review' || x.state === 'held')) state.waiting_for = 'done';
      return {};
    },
  };

  const stillCalls: Record<string, (p: Params) => unknown> = {
    'stills.get': () => copy(stills),
    'stills.ok': (p) => {
      const state = stills as StillsState;
      const line = lineOf(text(p['line']));
      line.state = 'ok';
      const group = state.groups?.find((x) => x.lines.includes(line.line));
      if (!group || group.lines.some((id) => lineOf(id).state !== 'ok'))
        return { next: 'wait' } satisfies DecisionResult;
      group.state = 'ok';
      const next = state.groups?.find((x) => x.state === 'waiting');
      if (!next) return { next: 'done' } satisfies DecisionResult;
      next.state = 'making';
      for (const id of next.lines) lineOf(id).state = 'drawing';
      later(() => {
        next.state = 'review';
        for (const id of next.lines) {
          const made = lineOf(id);
          made.state = 'check';
          made.path = line.path ?? '';
          made.version = 1;
          made.versions = 1;
        }
      }, 2200);
      return { next: 'group' } satisfies DecisionResult;
    },
    'stills.fix': (p) => {
      const line = lineOf(text(p['line']));
      if (p['text']) addNote(line.line, text(p['text']));
      line.state = 'fix';
      sendNotes(line);
      later(() => {
        line.version = (line.version ?? 1) + 1;
        line.versions = line.version;
        line.state = 'check';
        // a still whose render failed (no picture): the redraw gives it one
        if (!line.path) {
          line.path = stills?.lines.find((other) => other.path)?.path ?? '';
          line.error = '';
        }
      });
      return { fixing: true };
    },
    'stills.send_anyway': (p) => {
      const line = lineOf(text(p['line']));
      line.state = 'check';
      line.held = null;
      return {};
    },
    'stills.retry': (p) => {
      const line = lineOf(text(p['line']));
      line.state = 'fix';
      later(() => {
        line.version = (line.version ?? 1) + 1;
        line.versions = line.version;
        line.state = 'check';
        line.held = null;
      });
      return {};
    },
    'stills.make': () => ({ making: 0 }),
    'notes.list': () => ({ notes: [] }),
  };

  const sharedCalls: Record<string, (p: Params) => unknown> = {
    'lessons.list': () => ({ lessons }),
    'videonotes.status': () => all.videonotes,
    'pool.get': () => all.pool,
    'notes.save': (p) => {
      addNote(text(p['node']), text(p['text']));
      return { note: true };
    },
    'notes.delete': (p) => {
      for (const entry of [...(frames?.frames ?? []), ...(stills?.lines ?? [])]) {
        const at = (entry.notes ?? []).findIndex((note) => note.id === p['note']);
        if (at >= 0) {
          entry.notes?.splice(at, 1);
          entry.pending_notes = Math.max(0, (entry.pending_notes ?? 1) - 1);
        }
      }
      return { ok: true };
    },
    'lessons.approve': (p) => {
      const lesson = lessons.find((x) => x.id === p['id']);
      if (lesson) lesson.approved = true;
      return {};
    },
    'lessons.toggle': (p) => {
      const lesson = lessons.find((x) => x.id === p['id']);
      if (lesson) lesson.approved = Boolean(p['on']);
      return {};
    },
    'lessons.delete': (p) => {
      const at = lessons.findIndex((x) => x.id === p['id']);
      if (at >= 0) lessons.splice(at, 1);
      return {};
    },
  };

  const handlers = { ...sharedCalls, ...(kind === 'frames' ? frameCalls : stillCalls) };

  return {
    async call<T>(type: string, params: Params = {}): Promise<T> {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const handler = handlers[type];
      if (!handler) throw new ServiceError(`The screenshot fixture does not know ${type}`, 'unknown_type');
      return handler(params) as T;
    },
    on<T>(event: string, listener: ReviewListener<T>): () => void {
      const set = listeners.get(event) ?? new Set<Listener>();
      const stored = listener as unknown as Listener;
      set.add(stored);
      listeners.set(event, set);
      return () => set.delete(stored);
    },
  };
}

/** The service a review screen talks to: the fixture when the address says `?fixture=<scenario>`, else the real one. */
export const reviewService = (
  kind: FixtureKind,
  fixture: string | null,
  real: ReviewService,
): Promise<ReviewService> => (fixture ? createReviewFixture(kind, fixture) : Promise.resolve(real));
