import { audioExtension, blobBase64, pngBase64 } from './media';
import type { MotionSession } from './motion.svelte';
import { ParkedDrafts, pinFrame, pinRange, pinScene } from './draft';
import { notePayload } from './note-payload';
import { noteSeconds, emptyDraft } from './scenes';
import type { NoteKind, NoteSaved, SceneNote } from './types';
import { PROBLEM, reason } from './words';

export interface Transcript {
  state: 'working' | 'done' | 'error';
  text?: string;
  error?: string;
}

interface NoteToSave {
  canvas: HTMLCanvasElement;
  time: number;
  text: string;
  audio: Blob | null;
  kind: NoteKind;
  end: number | null;
}

/** Writing a note: marking a frame or range, the voice, saving it with its picture, and the voice transcript. */
export class NoteWriter {
  draft = $state(emptyDraft());
  /** The Mark screen is open on this draft. */
  marking = $state(false);
  transcripts = $state<Record<string, Transcript>>({});
  readonly #session: MotionSession;
  readonly #parked = new ParkedDrafts();

  constructor(session: MotionSession) {
    this.#session = session;
  }

  get hasDraft(): boolean {
    const { draft } = this;
    return draft.locked || draft.text.trim() !== '' || this.#session.voice.audio !== null;
  }

  /** Where the playhead is, for marks: the player's own reading, else the last one reported. */
  #now(): number {
    return this.#session.player?.now() ?? this.#session.time;
  }

  setTime(seconds: number): void {
    if (!this.draft.locked) this.draft.time = seconds;
  }

  markFrame(): void {
    if (!this.#session.canNote) return;
    this.#session.player?.pause();
    this.draft = pinFrame(this.draft, this.#now());
    this.marking = true;
  }

  markRange(): void {
    if (!this.#session.canNote) return;
    this.#session.player?.pause();
    this.draft = pinRange(this.draft, this.#now());
    if (this.draft.timeEnd !== null) this.marking = true;
  }

  noteAboutScene(): void {
    if (!this.#session.canNote) return;
    this.#session.player?.pause();
    this.draft = pinScene(this.draft);
    this.marking = true;
  }

  cancelDraft(): void {
    this.reset();
    this.marking = false;
  }

  /** The owner leaves a scene: a note half written stays with it. */
  leave(beat: string | null): void {
    if (beat && this.hasDraft)
      this.#parked.park(beat, { draft: this.draft, audio: this.#session.voice.audio });
    this.reset();
  }

  /** The owner arrives at a scene: its parked note, if any, comes back. */
  arrive(beat: string): void {
    const parked = this.#parked.take(beat);
    this.draft = parked?.draft ?? emptyDraft();
    this.#session.voice.audio = parked?.audio ?? null;
  }

  /** Empties the note being written and its recording. */
  reset(): void {
    this.draft = emptyDraft();
    this.#session.voice.clear();
  }

  /** Saves a note written on the Mark screen: the frame with the owner's marks on it. Throws if it fails. */
  async saveDrawing(drawing: {
    canvas: HTMLCanvasElement;
    time: number;
    text: string;
    audio: Blob | null;
  }): Promise<void> {
    const { mode, timeEnd } = this.draft;
    const saved = await this.#save({ ...drawing, kind: mode, end: timeEnd });
    this.reset();
    this.marking = false;
    await this.noteSaved(saved.note, drawing.audio !== null);
  }

  async #save(note: NoteToSave): Promise<NoteSaved> {
    const session = this.#session;
    const { media } = session;
    if (!media.node) throw new Error('This scene has no picture to mark yet.');
    const payload = notePayload({
      node: media.node,
      time: note.time,
      end: note.end,
      text: note.text,
      kind: note.kind,
      version: session.viewed?.n ?? session.latest,
      fps: session.fps,
      type: this.draft.type,
      imagePngBase64: pngBase64(note.canvas),
      voice: note.audio
        ? { base64: await blobBase64(note.audio), extension: audioExtension(note.audio.type) }
        : null,
    });
    return session.api.saveNote(payload);
  }

  /** A note was saved (here or by the drawing window): write out its voice, show it, reload. */
  async noteSaved(note: { id: string } | string | undefined, hadVoice: boolean): Promise<void> {
    const session = this.#session;
    session.problems.clear(PROBLEM);
    const id = typeof note === 'string' ? note : note?.id;
    if (hadVoice && id) {
      this.transcripts[id] = { state: 'working' };
      session.api
        .transcribe(id)
        .catch((error: unknown) => (this.transcripts[id] = { state: 'error', error: reason(error) }));
    }
    session.highlighted = id ?? null;
    session.selected = id ?? null;
    session.tab = 'notes';
    await session.load();
  }

  transcribed(event: { note: string; text?: string; error?: string }): void {
    this.transcripts[event.note] = event.error
      ? { state: 'error', error: event.error }
      : { state: 'done', ...(event.text ? { text: event.text } : {}) };
  }

  /** Jumps the video to a note and links it with its card. */
  pickNote(note: SceneNote): void {
    const session = this.#session;
    session.selected = note.id;
    session.highlighted = note.id;
    session.tab = 'notes';
    session.player?.pause();
    session.player?.seek(noteSeconds(note, session.fps));
  }
}
