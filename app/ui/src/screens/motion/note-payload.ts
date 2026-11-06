import { frameAt } from './scenes';
import type { NoteKind, NotePayload } from './types';

const SECONDS_DIGITS = 3;

export interface NoteDraft {
  node: string;
  time: number;
  /** End of a range note; null for the other kinds. */
  end: number | null;
  text: string;
  kind: NoteKind;
  version: number;
  fps: number;
  /** The note's category chosen in the composer, if any. */
  type: string;
  imagePngBase64: string;
  voice: { base64: string; extension: string } | null;
}

/** The body the service takes for one saved note: seconds and frames for the start (and end of a range). */
export function notePayload(note: NoteDraft): NotePayload {
  return {
    node: note.node,
    time: Number(note.time.toFixed(SECONDS_DIGITS)),
    frame: frameAt(note.time, note.fps),
    text: note.text.trim(),
    image_png_base64: note.imagePngBase64,
    send: false,
    kind: note.kind,
    version: note.version,
    fps: note.fps,
    ...(note.type ? { type: note.type } : {}),
    ...(note.kind === 'range' && note.end !== null
      ? { time_end: Number(note.end.toFixed(SECONDS_DIGITS)), frame_end: frameAt(note.end, note.fps) }
      : {}),
    ...(note.voice ? { audio_base64: note.voice.base64, audio_ext: note.voice.extension } : {}),
  };
}
