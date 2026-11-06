import type { ActiveWork } from '../../lib/review/active-work.svelte';
import type { WaitingWords } from '../../lib/review/waiting';
import { getContext, setContext } from 'svelte';
import type { ReviewService } from '../../lib/review/types';
import { isNotBuiltYet } from '../../lib/service/client';
import type { Problems } from '../../lib/stores/problems.svelte';
import type { MotionApi } from './api';
import { Decisions, type Dialog } from './decisions.svelte';
import { NoteWriter, type Transcript } from './note-writer.svelte';
import { NoteRecorder } from '../../lib/review/note-recorder.svelte';
import { canWriteNote, sceneMedia, type SceneMedia } from './scene-media';
import {
  decisionText,
  latestNumber,
  notesOfScene,
  pickBeat,
  shotsOf,
  statusOf,
  unresolvedOf,
  versionsOf,
  viewedVersion,
} from './scenes';
import { TabletLink } from './tablet-link.svelte';
import { tabletLine } from './tablet';
import type {
  ClipStatus,
  Draft,
  Plan,
  PlanShot,
  RestAnswer,
  Scene,
  SceneLesson,
  SceneList,
  SceneNote,
  SceneVersion,
} from './types';
import { LOAD_PROBLEM, PLAN_PROBLEM, PROBLEM, reason, SOON } from './words';

export type { Dialog, Transcript };

const DEFAULT_FPS = 30;

/** What the video player lets the screen do: read the playhead, move it, pause, step. */
export interface PlayerHandle {
  now(): number;
  paused(): boolean;
  seek(seconds: number): void;
  pause(): void;
  togglePlay(): void;
  step(direction: 1 | -1): void;
}

/** The Motion screen's state: which scene and version is on view, what loaded. The note being written, the
 *  decisions and the tablet live in their own parts (`writer`, `decisions`, `tabletLink`); the one-line methods
 *  below hand them to the components. The service is reached only through `api`. */
export class MotionSession {
  list = $state<SceneList | null>(null);
  plan = $state<Plan | null>(null);
  notes = $state<SceneNote[]>([]);
  lessons = $state<SceneLesson[]>([]);
  loaded = $state(false);
  /** The service does not know the Motion calls yet. */
  soon = $state(false);
  failure = $state<string | null>(null);
  beat = $state<string | null>(null);
  /** An older version picked in the version row; null = the newest. */
  picked = $state<number | null>(null);
  compare = $state(false);
  side = $state<'before' | 'after'>('after');
  /** The inspector's open tab: 'notes', 'scenes' or 'lessons'. */
  tab = $state('notes');
  /** The note linked between the timeline and the Notes list. */
  selected = $state<string | null>(null);
  highlighted = $state<string | null>(null);
  clip = $state<ClipStatus>('idle');
  clipError = $state('');
  /** The playhead in seconds. */
  time = $state(0);
  /** The clip's length in seconds, once it has loaded. */
  duration = $state(0);
  /** When this screen first saw each scene being made (Date.now()), for the elapsed time beside it. */
  makingSince = $state<Record<string, number>>({});
  /**
   * What the screen says instead of "Generating… so far" when a scene is marked making but the service is not
   * working on Motion now (set by the screen from `work.active` and the step states); null = it really works.
   */
  waiting = $state<WaitingWords | null>(null);
  /** Whether the service really works on Motion now, and its Resume (set by the screen). */
  work = $state.raw<ActiveWork | null>(null);
  readonly voice = new NoteRecorder();
  /** The service itself, for the shared lesson buttons. */
  readonly service: ReviewService;
  readonly api: MotionApi;
  readonly problems: Problems;
  readonly projectId: () => string;
  player: PlayerHandle | null = null;
  /** The scene being checked; when the tablet approves it, the screen moves on. */
  active: string | null = null;
  readonly #writer: NoteWriter;
  readonly #decisions: Decisions;
  readonly #tablet: TabletLink;
  readonly #asked: string | null;
  readonly #remember: (beat: string) => void;
  #resume: { time: number; paused: boolean } | null = null;
  /** Each load() gets the next number; an answer whose number is not the latest is dropped (as on Stills). */
  #latest = 0;
  #askedCalls = false;
  /** The service's calls (hello `types`), once read; null = not known, so nothing is hidden. */
  calls = $state.raw<ReadonlySet<string> | null>(null);
  /** Calls that answered "unknown" here: their buttons are hidden from then on. */
  missing = $state.raw<ReadonlySet<string>>(new Set());

  constructor(config: {
    api: MotionApi;
    service: ReviewService;
    problems: Problems;
    projectId: () => string;
    /** The scene asked for in the address (a beat or a shot id). */
    asked: string | null;
    /** Writes the scene into the address. */
    remember: (beat: string) => void;
  }) {
    this.api = config.api;
    this.service = config.service;
    this.problems = config.problems;
    this.projectId = config.projectId;
    this.#asked = config.asked;
    this.#remember = config.remember;
    this.#writer = new NoteWriter(this);
    this.#decisions = new Decisions(this);
    this.#tablet = new TabletLink(this);
  }

  // ---------- what is on screen ----------

  get scenes(): Scene[] {
    return this.list?.scenes ?? [];
  }
  get index(): number {
    return this.scenes.findIndex((scene) => scene.beat === this.beat);
  }
  get scene(): Scene | undefined {
    return this.scenes[this.index];
  }
  get total(): number {
    return this.scenes.length;
  }
  get done(): number {
    return this.scenes.filter((scene) => scene.state === 'ok').length;
  }
  get fps(): number {
    return this.list?.fps ?? this.plan?.fps ?? DEFAULT_FPS;
  }
  get shots(): PlanShot[] {
    return shotsOf(this.plan, this.beat);
  }
  get versions(): SceneVersion[] {
    return versionsOf(this.scene);
  }
  get latest(): number {
    return latestNumber(this.scene);
  }
  get viewed(): SceneVersion | null {
    return viewedVersion(this.versions, { picked: this.picked, compare: this.compare, side: this.side });
  }
  get media(): SceneMedia {
    return sceneMedia(this.shots, this.viewed);
  }
  get sceneNotes(): SceneNote[] {
    return notesOfScene(this.notes, this.shots);
  }
  get unresolved(): SceneNote[] {
    return unresolvedOf(this.sceneNotes);
  }
  get lessonsUsed(): number {
    return this.lessons.filter((lesson) => lesson.approved && lesson.on !== false).length;
  }
  get lessonsUndecided(): number {
    return this.lessons.filter((lesson) => !lesson.approved).length;
  }
  get canNote(): boolean {
    return canWriteNote(this.media, this.scene, this.clip);
  }
  /** The scene is ready to be judged: Approve and Request fix can be used. */
  /** The scene after this one, already made or being made ahead. */
  get nextScene() {
    return this.list?.next ?? null;
  }
  get canDecide(): boolean {
    return this.scene?.state === 'review' && !this.busy && !this.soon && this.clip !== 'error';
  }
  get tabletLine() {
    const scene = this.scene;
    if (!scene) return null;
    return tabletLine({
      status: this.tablet,
      scene: scene.tablet,
      index: this.index,
      total: this.total,
      latest: this.latest,
    });
  }
  get decisionText(): string {
    const scene = this.scene;
    if (!scene) return '';
    return decisionText({
      why: this.why,
      busy: this.busy,
      soon: this.soon,
      scene,
      index: this.index,
      total: this.total,
      clip: this.clip,
      notes: this.sceneNotes.length,
      unresolved: this.unresolved.length,
      latest: this.latest,
      lessons: this.lessonsUsed,
    });
  }
  get sceneStatus() {
    return statusOf(this.scene, this.index, this.why);
  }
  /** What is known about the work behind a scene that is not made (null on the mock or before the screen set it). */
  get why() {
    return this.work?.why('the scenes') ?? null;
  }

  /** The service has this call (or it is not known yet): a button that needs it is shown. */
  supports(type: string): boolean {
    return !this.missing.has(type) && (this.calls === null || this.calls.has(type));
  }

  #lacks(type: string): void {
    this.missing = new Set([...this.missing, type]);
  }

  // ---------- loading ----------

  async load(): Promise<void> {
    const mine = ++this.#latest;
    if (!this.#askedCalls) {
      this.#askedCalls = true;
      void this.api.calls().then((calls) => (this.calls = calls));
    }
    const noteSoon = (error: unknown): never[] => {
      if (isNotBuiltYet(error)) this.soon = true;
      return [];
    };
    try {
      const scenes = this.api.scenes().catch((error: unknown) => {
        if (isNotBuiltYet(error)) {
          this.soon = true;
          return null;
        }
        throw error;
      });
      // the shots: a failure keeps the last ones and says so (it was swallowed to null: notes silently unavailable)
      const plan = this.api.plan().then(
        (answer) => ({ answer, error: null as string | null }),
        (error: unknown) => ({ answer: this.plan, error: reason(error) }),
      );
      const [notes, lessons] = [this.api.notes().catch(noteSoon), this.api.lessons().catch(noteSoon)];
      void this.refreshTablet();
      const list = await scenes;
      const [shots, noteList, lessonList] = await Promise.all([plan, notes, lessons]);
      if (mine !== this.#latest) return; // a newer load started: this answer is stale
      this.list = list;
      this.failure = null;
      [this.plan, this.notes, this.lessons] = [shots.answer, noteList, lessonList];
      this.loaded = true;
      this.problems.clear(LOAD_PROBLEM);
      if (shots.error) {
        this.problems.raise({
          id: PLAN_PROBLEM,
          kind: 'warn',
          text: `The shots could not be read: ${shots.error}. Notes can be written once they load.`,
        });
      } else this.problems.clear(PLAN_PROBLEM);
      this.#settle();
    } catch (error) {
      if (mine !== this.#latest) return;
      // one failed read (often the 10 s poll) keeps what is on screen, with a warning; only a first load fails whole
      if (this.loaded) {
        this.problems.raise({
          id: LOAD_PROBLEM,
          kind: 'warn',
          text: `The scenes did not refresh: ${reason(error)}. What you see may be old.`,
          fix: {
            label: 'Try again',
            run: async () => {
              await this.load();
              return 'Refreshed.';
            },
          },
        });
      } else this.failure = reason(error);
    }
  }

  /** Keeps the scene on view valid; moves on when the one being checked was approved elsewhere (the tablet). */
  #settle(): void {
    const scenes = this.scenes;
    const since: Record<string, number> = {};
    for (const { beat, state } of scenes) {
      if (state === 'making') since[beat] = this.makingSince[beat] ?? Date.now();
    }
    this.makingSince = since;
    if (!scenes.some((scene) => scene.beat === this.beat) && this.list) {
      this.beat = pickBeat(this.list, this.plan, null, this.#asked);
    }
    if (this.scene?.state === 'ok' && this.active === this.beat) {
      const next = scenes.slice(this.index + 1).find((scene) => scene.state === 'review');
      if (next) this.select(next.beat);
    }
    const scene = this.scene;
    if (scene && scene.state !== 'ok') this.active = scene.beat;
  }

  select(beat: string): void {
    this.#writer.leave(this.beat);
    this.beat = beat;
    this.#writer.arrive(beat);
    this.picked = null;
    this.compare = false;
    this.selected = null;
    this.problems.clear(PROBLEM);
    this.#remember(beat);
  }

  /** What the player says about the clip on screen (loading, ready, would not load). */
  setClip(status: ClipStatus, error = ''): void {
    this.clip = status;
    this.clipError = error;
  }

  // ---------- versions ----------

  /** Remembers the playhead so the next clip opens where this one was. */
  keepPosition(): void {
    if (this.player) this.#resume = { time: this.player.now(), paused: this.player.paused() };
  }
  takeResume(): { time: number; paused: boolean } | null {
    const resume = this.#resume;
    this.#resume = null;
    return resume;
  }
  pickVersion(index: number): void {
    this.#changeView(() => (this.picked = index === this.versions.length - 1 ? null : index));
  }
  setCompare(on: boolean): void {
    this.#changeView(() => {
      this.compare = on;
      this.side = 'after';
    });
  }
  setSide(side: 'before' | 'after'): void {
    this.#changeView(() => (this.side = side));
  }

  /** Changes what is on view; a new clip opens at the playhead the old one had (only when the clip really changes). */
  #changeView(change: () => void): void {
    const before = this.media.path;
    this.keepPosition();
    change();
    if (this.media.path === before) this.#resume = null;
  }

  // ---------- notes and lessons ----------

  /** True when the words were saved; false keeps the editor open. */
  editNote(id: string, text: string): Promise<boolean> {
    return this.#guarded(
      () => this.api.editNote(id, text),
      'Editing notes comes in the next studio update.',
      'notes.edit',
    );
  }
  async resolveNote(note: SceneNote): Promise<void> {
    await this.#guarded(
      () => this.api.resolveNote(note.id, !note.resolved),
      'Resolving notes comes in the next studio update.',
      'notes.resolve',
    );
  }
  async removeNote(id: string): Promise<void> {
    await this.#guarded(() => this.api.removeNote(id));
  }
  /** True when the words were saved; false keeps the editor open. */
  editLesson(id: string, text: string): Promise<boolean> {
    return this.#guarded(() => this.api.editLesson(id, text));
  }
  async switchLesson(lesson: SceneLesson): Promise<void> {
    await this.#guarded(() => this.api.switchLesson(lesson.id, lesson.on === false));
  }

  async #guarded(work: () => Promise<void>, soon = SOON, type?: string): Promise<boolean> {
    let done = true;
    try {
      await work();
    } catch (error) {
      done = false;
      if (isNotBuiltYet(error) && type) this.#lacks(type);
      this.raise(isNotBuiltYet(error) ? soon : reason(error));
    }
    await this.load();
    return done;
  }

  /** Shows a warning in the problems bar, replacing the last one this screen raised. */
  raise(text: string): void {
    this.problems.raise({ id: PROBLEM, kind: 'warn', text });
  }

  // ---------- the note being written (NoteWriter) ----------

  get draft(): Draft {
    return this.#writer.draft;
  }
  get marking(): boolean {
    return this.#writer.marking;
  }
  get transcripts(): Record<string, Transcript> {
    return this.#writer.transcripts;
  }
  get hasDraft(): boolean {
    return this.#writer.hasDraft;
  }
  setTime(seconds: number): void {
    this.time = seconds;
    this.#writer.setTime(seconds);
  }
  markFrame(): void {
    this.#writer.markFrame();
  }
  markRange(): void {
    this.#writer.markRange();
  }
  noteAboutScene(): void {
    this.#writer.noteAboutScene();
  }
  cancelDraft(): void {
    this.#writer.cancelDraft();
  }
  saveDrawing(drawing: {
    canvas: HTMLCanvasElement;
    time: number;
    text: string;
    audio: Blob | null;
  }): Promise<void> {
    return this.#writer.saveDrawing(drawing);
  }
  noteSaved(note: { id: string } | string | undefined, hadVoice: boolean): Promise<void> {
    return this.#writer.noteSaved(note, hadVoice);
  }
  transcribed(event: { note: string; text?: string; error?: string }): void {
    this.#writer.transcribed(event);
  }
  pickNote(note: SceneNote): void {
    this.#writer.pickNote(note);
  }

  // ---------- Request fix, Approve, the rest of the scenes (Decisions) ----------

  get dialog(): Dialog {
    return this.#decisions.dialog;
  }
  set dialog(value: Dialog) {
    this.#decisions.dialog = value;
  }
  get rest(): RestAnswer | null {
    return this.#decisions.rest;
  }
  set rest(value: RestAnswer | null) {
    this.#decisions.rest = value;
  }
  /** What is being sent right now, in words; empty = nothing. */
  get busy(): string {
    return this.#decisions.busy;
  }
  askFix(): void {
    this.#decisions.askFix();
  }
  askApprove(): void {
    this.#decisions.askApprove();
  }
  sendFix(): Promise<void> {
    return this.#decisions.sendFix();
  }
  approve(remakeNext = false): Promise<void> {
    return this.#decisions.approve(remakeNext);
  }
  askRest(): Promise<void> {
    return this.#decisions.askRest();
  }
  makeRest(): Promise<void> {
    return this.#decisions.makeRest();
  }

  // ---------- the tablet (TabletLink) ----------

  get tablet() {
    return this.#tablet.status;
  }
  refreshTablet(): Promise<void> {
    return this.#tablet.refresh();
  }
  checkSync(): Promise<void> {
    return this.#tablet.checkSync();
  }
  sendSceneToTablet(): Promise<void> {
    return this.#tablet.sendScene();
  }
  stopTablet(): Promise<void> {
    return this.#tablet.stop();
  }
}

const KEY = Symbol('motion-session');

export const provideMotion = (session: MotionSession): MotionSession => setContext(KEY, session);

export function useMotion(): MotionSession {
  const session = getContext<MotionSession | undefined>(KEY);
  if (!session) throw new Error('The Motion session is missing: render inside MotionScreen.');
  return session;
}
