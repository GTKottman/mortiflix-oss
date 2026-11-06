import type { Listener } from '../../lib/service/client';
import type { ReviewService, VideoNotesStatus } from '../../lib/review/types';
import type { StudioOption } from '../../lib/service/types';
import type { NotePayload, Scene, SceneLesson, SceneNote } from './types';

// The screen on fixture answers: open #/motion?mock=review|rendering|error. Nothing is sent to the service and
// nothing is written to the project. Add &seed=notes|ab for sample notes (ab = two versions too),
// &tabletdemo=notlinked|unopened|reviewing|notes|none|unreachable|notsent, and &sync=tablet for the tablet disagreement.

export const MOCK_MODES = ['review', 'rendering', 'error'] as const;
export type MockMode = (typeof MOCK_MODES)[number];

export const isMockMode = (value: string | null): value is MockMode =>
  MOCK_MODES.some((mode) => mode === value);

export interface MockOptions {
  mode: MockMode;
  seed: string | null;
  tablet: string | null;
  sync: string | null;
}

/** The options row's pills in the fixture (the real row asks the service). */
export const MOCK_PILLS: StudioOption[] = [
  { id: 'slow', label: 'Slower', does: 'Slows the motion down a little.' },
  { id: 'calm', label: 'Less busy', does: 'Removes small moving parts.' },
];

const NAMES = [
  'Call it Black October',
  'PHP2Shell, the big one',
  'Plex2Shell at home',
  'Businesses’ own fires',
  'Today’s to-do list',
  'Patch now',
];
const CLIP = '/screens/fixtures/clip.mp4';
const MISSING = '/tmp/mfx-test-studio/fixtures/gone.mp4';
const STILL = '/screens/fixtures/still.png';
const LATENCY_MS = 60;
const MAKING_MS = 1400;

const reachable: VideoNotesStatus = {
  enabled: true,
  tablet_seen: 'x',
  addresses: [{ kind: 'tailnet', url: 'x', reachable: true }],
  problems: [],
};
const TABLET_DEMOS: Record<
  string,
  { status: VideoNotesStatus; scene?: { status: string; notes: number; error?: string } }
> = {
  notlinked: { status: { enabled: true, tablet_seen: null, addresses: [], problems: [] } },
  unopened: { status: reachable, scene: { status: 'to review', notes: 0 } },
  reviewing: { status: reachable, scene: { status: 'reviewing', notes: 1 } },
  notes: { status: reachable, scene: { status: 'done', notes: 3 } },
  none: { status: reachable, scene: { status: 'done', notes: 0 } },
  notsent: {
    status: reachable,
    scene: { status: 'not sent', notes: 0, error: 'the Video Notes folder is not writable' },
  },
  unreachable: {
    status: {
      enabled: true,
      tablet_seen: 'x',
      addresses: [{ kind: 'tailnet', url: 'x', reachable: false }],
      problems: ['Tailscale is off on this PC.'],
    },
  },
};

type Params = Record<string, unknown>;

export function createMockService({ mode, seed, tablet, sync }: MockOptions): ReviewService {
  const clip = mode === 'error' ? MISSING : CLIP;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string) => listeners.get(event)?.forEach((listener) => listener({}, event));
  const demo = tablet ? TABLET_DEMOS[tablet] : undefined;
  let noteCount = 0;

  const scenes: Scene[] = NAMES.map((name, i) => ({
    beat: `b0${i + 1}`,
    name,
    state: i === 0 ? (mode === 'rendering' ? 'making' : 'review') : 'waiting',
    clip: i === 0 && mode !== 'rendering' ? { file: clip } : null,
    eta_s: i === 0 && mode === 'rendering' ? 120 : null,
  }));
  const first = scenes[0];
  if (first && seed === 'ab') {
    first.versions = [
      { n: 1, file: clip, at: '2026-11-01T22:10' },
      { n: 2, file: clip, at: '2026-11-01T22:31' },
    ];
  }
  let notes: SceneNote[] = [];
  let lessons: SceneLesson[] = [];
  if (seed === 'notes' || seed === 'ab') {
    const version = seed === 'ab' ? 2 : 1;
    lessons = [
      {
        id: 'l1',
        text: 'Size the main title to read clearly at a glance on the final frame.',
        approved: false,
        scope: 'project',
      },
      {
        id: 'l2',
        text: 'Captions stay on screen for at least 2 seconds.',
        approved: true,
        on: true,
        scope: 'all',
      },
    ];
    notes = [
      {
        id: 'n1',
        node: 's01',
        time: 2.4,
        frame: 72,
        kind: 'frame',
        image: STILL,
        pending: true,
        lesson: 'l1',
        type: 'composition',
        version,
        tablet: 'x/1',
        text: 'The engine drawing is too small next to the cards. Make it about twice as big.',
      },
      {
        id: 'n2',
        node: 's01',
        time: 4.1,
        time_end: 5.2,
        frame: 123,
        kind: 'range',
        image: STILL,
        pending: true,
        resolved: false,
        type: 'timing',
        version,
        text: 'The door opens before the voice says “without logging in”. Wait for the words.',
      },
      {
        id: 'n3',
        node: 's01',
        time: 0,
        frame: 0,
        kind: 'scene',
        pending: false,
        resolved: true,
        type: 'pacing',
        version: 1,
        text: 'Overall a little busy; keep fewer things moving at once.',
      },
    ];
    noteCount = 3;
  }

  const later = (change: () => void) =>
    setTimeout(() => {
      change();
      emit('node.changed');
    }, MAKING_MS);

  const handlers: Record<string, (params: Params) => unknown> = {
    'motion.scene.get': () => ({
      scenes: scenes.map((scene) => ({
        ...scene,
        tablet: scene.state === 'review' ? (demo?.scene ?? null) : null,
      })),
      current: Math.max(
        0,
        scenes.findIndex((scene) => scene.state !== 'ok'),
      ),
      mode: 'one',
    }),
    'preview.plan': () => ({
      shots: scenes.map((scene, i) => ({
        node: `s0${i + 1}`,
        beat: scene.beat,
        dur_sec: 6,
        media: scene.clip ? { kind: 'video', path: scene.clip.file } : { kind: 'image', path: STILL },
      })),
    }),
    'notes.list': () => ({ notes }),
    'lessons.list': () => ({ lessons }),
    'notes.save': (params) => {
      const payload = params as unknown as NotePayload;
      const id = `n${++noteCount}`;
      const lesson: SceneLesson = {
        id: `l${noteCount}`,
        text: `Mock lesson for note ${noteCount}: check the title size at viewing size.`,
        approved: false,
        scope: 'project',
      };
      lessons.push(lesson);
      notes.push({
        id,
        node: payload.node,
        time: payload.time,
        frame: payload.frame,
        kind: payload.kind,
        version: payload.version,
        ...(payload.time_end !== undefined ? { time_end: payload.time_end } : {}),
        ...(payload.type ? { type: payload.type } : {}),
        text: payload.text,
        image: `data:image/png;base64,${payload.image_png_base64}`,
        pending: true,
        lesson: lesson.id,
      });
      return { note: { id }, lesson };
    },
    'notes.delete': (params) => {
      notes = notes.filter((note) => note.id !== params['note']);
      return {};
    },
    'notes.edit': (params) => {
      notes = notes.map((note) =>
        note.id === params['note'] ? { ...note, text: String(params['text']) } : note,
      );
      return {};
    },
    'notes.resolve': (params) => {
      notes = notes.map((note) =>
        note.id === params['note'] ? { ...note, resolved: Boolean(params['on']) } : note,
      );
      return {};
    },
    'notes.transcribe': () => ({}),
    'notes.send': () => {
      const scene = scenes.find((s) => s.state === 'review');
      notes = notes.map((note) => ({ ...note, pending: false }));
      if (scene) {
        scene.state = 'making';
        scene.eta_s = 90;
        later(() => {
          scene.state = 'review';
          scene.eta_s = null;
          const versions = scene.versions ?? [{ n: 1, file: clip }];
          scene.versions = [
            ...versions,
            { n: versions.length + 1, file: clip, at: new Date().toISOString() },
          ];
        });
      }
      return {};
    },
    'lessons.approve': (params) => {
      lessons = lessons.map((l) =>
        l.id === params['id'] ? { ...l, approved: true, on: true, scope: String(params['scope']) } : l,
      );
      return {};
    },
    'lessons.toggle': (params) => {
      lessons = lessons.map((l) =>
        l.id === params['id']
          ? { ...l, approved: Boolean(params['on']) || Boolean(l.approved), on: Boolean(params['on']) }
          : l,
      );
      return {};
    },
    'lessons.delete': (params) => {
      lessons = lessons.filter((l) => l.id !== params['id']);
      notes = notes.map((note) => (note.lesson === params['id'] ? { ...note, lesson: null } : note));
      return {};
    },
    'lessons.edit': (params) => {
      lessons = lessons.map((l) => (l.id === params['id'] ? { ...l, text: String(params['text']) } : l));
      return {};
    },
    'motion.scene.approve': (params) => {
      const at = scenes.findIndex((scene) => scene.beat === params['beat']);
      const current = scenes[at];
      if (current) current.state = 'ok';
      const next = scenes[at + 1];
      if (!next) return { next: null };
      next.state = 'making';
      next.eta_s = 120;
      later(() => {
        next.state = 'review';
        next.eta_s = null;
        next.clip = { file: clip };
      });
      return { next: next.beat };
    },
    'motion.scene.all': (params) =>
      params['confirm']
        ? {}
        : {
            needs_confirm: true,
            rest: 5,
            warning: 'Scenes made ahead of time will not have the lessons from notes you have not given yet.',
          },
    'videonotes.status': () => demo?.status ?? { enabled: false },
    'videonotes.resend': () => ({}),
    'videonotes.setup': () => ({}),
    'sync.check': () =>
      sync === 'tablet'
        ? [
            {
              case: 'tablet',
              text: 'The tablet still shows scene 1 as waiting, but you already approved it here. The app wins.',
              fix: { type: 'sync.fix' },
            },
          ]
        : [],
    'sync.fix': () => ({ done: true, text: 'Closed scene 1 on the tablet. Your notes there are kept.' }),
  };

  return {
    call: <T>(type: string, params: Params = {}) =>
      new Promise<T>((resolve, reject) =>
        setTimeout(() => {
          const handler = handlers[type];
          if (handler) resolve(handler(params) as T);
          else reject(new Error(`The fixture has no answer for ${type}.`));
        }, LATENCY_MS),
      ),
    on: <T = unknown>(event: string, listener: Listener<T>) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      set.add(listener as Listener);
      return () => set.delete(listener as Listener);
    },
  };
}
