import { fileUrl } from '../files';
import { paintMarks, type Mark } from './marks';
import type { ReviewService } from './types';

// Saving a note on a picture: the picture with the owner's marks drawn on it goes to the service as one PNG.
// Notes are kept until Fix sends them all as one change (owner: "collect, send all at once").

export interface NoteDraft {
  /** The piece the note is about (its service id). */
  node: string;
  /** The studio path of the picture; empty = a words-only note (no picture sent). */
  path: string;
  text: string;
  marks?: readonly Mark[];
  audio?: Blob | null;
}

function loadPicture(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const picture = new Image();
    picture.crossOrigin = 'anonymous';
    picture.onload = () => resolve(picture);
    picture.onerror = () => reject(new Error('The picture could not be loaded.'));
    picture.src = fileUrl(path);
  });
}

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('The recording could not be read.'));
    reader.readAsDataURL(blob);
  });
}

const audioExtension = (type: string): string =>
  /ogg/.test(type) ? 'ogg' : /mp4|aac/.test(type) ? 'm4a' : 'webm';

/** The picture with the marks on it, as base64 PNG. */
export async function pictureWithMarks(
  path: string,
  marks: readonly Mark[],
  colour: string,
): Promise<string> {
  const picture = await loadPicture(path);
  const canvas = document.createElement('canvas');
  canvas.width = picture.naturalWidth || 1280;
  canvas.height = picture.naturalHeight || 720;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw the picture.');
  context.drawImage(picture, 0, 0, canvas.width, canvas.height);
  paintMarks(context, { x: 0, y: 0, w: canvas.width, h: canvas.height }, marks, colour);
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

export async function saveNote(service: ReviewService, draft: NoteDraft, colour: string): Promise<void> {
  // The picture (with any marks drawn on) goes with the note; a typed note from the note box passes no path and sends none.
  const marked = Boolean(draft.path);
  const payload: Record<string, unknown> = {
    node: draft.node,
    time: 0,
    frame: 0,
    text: draft.text.trim(),
    ...(marked ? { image_png_base64: await pictureWithMarks(draft.path, draft.marks ?? [], colour) } : {}),
    send: false,
  };
  if (draft.audio) {
    payload['audio_base64'] = await readBase64(draft.audio);
    payload['audio_ext'] = audioExtension(draft.audio.type);
  }
  await service.call('notes.save', payload);
}
