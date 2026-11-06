import { bridgeUrl } from '../../lib/base';
import type { ReviewService, VideoNotesStatus } from '../../lib/review/types';
import type { NotePayload, NoteSaved, Plan, RestAnswer, SceneLesson, SceneList, SceneNote } from './types';

/** One disagreement between the app and the tablet, from `sync.check`. */
export interface SyncCase {
  case: string;
  text: string;
  fix?: unknown;
}

/** Everything the Motion screen asks of the service, by the words on screen. */
export interface MotionApi {
  /** The calls the service answers (its hello `types`, from the bridge's /api/status); null when not known. */
  calls(): Promise<ReadonlySet<string> | null>;
  scenes(): Promise<SceneList>;
  plan(): Promise<Plan | null>;
  notes(): Promise<SceneNote[]>;
  lessons(): Promise<SceneLesson[]>;
  saveNote(payload: NotePayload): Promise<NoteSaved>;
  editNote(id: string, text: string): Promise<void>;
  resolveNote(id: string, resolved: boolean): Promise<void>;
  removeNote(id: string): Promise<void>;
  /** Writes a voice note out as words; the words come back as the `notes.transcribed` event. */
  transcribe(id: string): Promise<void>;
  /** One fix from every note waiting on the shot. */
  sendNotes(node: string): Promise<void>;
  approve(beat: string, remakeNext?: boolean): Promise<{ next?: string | null }>;
  restOfTheScenes(confirm: boolean): Promise<RestAnswer>;
  editLesson(id: string, text: string): Promise<void>;
  switchLesson(id: string, on: boolean): Promise<void>;
  tablet(): Promise<VideoNotesStatus | null>;
  sendToTablet(project: string, beat: string): Promise<void>;
  stopTablet(): Promise<void>;
  syncCheck(project: string): Promise<SyncCase | null>;
  syncFix(project: string): Promise<string>;
}

export function motionApi(service: ReviewService): MotionApi {
  const call = async (type: string, params: Record<string, unknown> = {}): Promise<void> => {
    await service.call(type, params);
  };
  return {
    async calls() {
      try {
        const answer = (await (await fetch(bridgeUrl('/api/status'))).json()) as {
          hello?: { types?: unknown };
        };
        const types = answer.hello?.types;
        return Array.isArray(types) ? new Set(types.map(String)) : null;
      } catch {
        return null; // not known: nothing is hidden, a call the service lacks says so when pressed
      }
    },
    scenes: () => service.call<SceneList>('motion.scene.get'),
    plan: () => service.call<Plan | null>('preview.plan', {}),
    notes: async () => (await service.call<{ notes?: SceneNote[] }>('notes.list')).notes ?? [],
    lessons: async () =>
      (await service.call<{ lessons?: SceneLesson[] }>('lessons.list', { scope: 'project' })).lessons ?? [],
    saveNote: (payload) => service.call<NoteSaved>('notes.save', { ...payload }),
    editNote: (id, text) => call('notes.edit', { note: id, text }),
    resolveNote: (id, resolved) => call('notes.resolve', { note: id, on: resolved }),
    removeNote: (id) => call('notes.delete', { note: id }),
    transcribe: (id) => call('notes.transcribe', { note: id }),
    sendNotes: (node) => call('notes.send', { node }),
    approve: (beat, remakeNext = false) =>
      service.call<{ next?: string | null }>('motion.scene.approve', {
        beat,
        ...(remakeNext ? { remake_next: true } : {}),
      }),
    restOfTheScenes: (confirm) =>
      service.call<RestAnswer>('motion.scene.all', confirm ? { confirm: true } : {}),
    editLesson: (id, text) => call('lessons.edit', { id, text }),
    switchLesson: (id, on) => call('lessons.toggle', { id, on }),
    tablet: () => service.call<VideoNotesStatus>('videonotes.status').catch(() => null),
    sendToTablet: (project, beat) => call('videonotes.resend', { project, scene: beat }),
    stopTablet: () => call('videonotes.setup', { enabled: false }),
    async syncCheck(project) {
      try {
        const answer = await service.call<SyncCase[]>('sync.check', { project });
        return (Array.isArray(answer) ? answer : []).find((entry) => entry.case === 'tablet') ?? null;
      } catch {
        return null;
      }
    },
    async syncFix(project) {
      const answer = await service.call<{ text?: string } | undefined>('sync.fix', {
        case: 'tablet',
        project,
      });
      return answer?.text ?? 'Done.';
    },
  };
}
