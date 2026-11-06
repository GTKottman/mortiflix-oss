import { fileUrl, isVideoPath, thumbUrl } from '../../lib/files';

/** Pictures that are not studio files: a data address, or the screen's own fixtures. */
const isLocal = (path: string): boolean => /^(data:|blob:|\/screens\/)/.test(path);

export const clipUrl = (path: string): string => (isLocal(path) ? path : fileUrl(path));
export const pictureUrl = (path: string, width: number): string =>
  isLocal(path) ? path : thumbUrl(path, width);
export const isVideo = isVideoPath;

/** A clip that never loads or never seeks fires no event at all (MDN HTMLMediaElement: loadeddata, seeked, error are
 *  the only signals): after this long the note is not left "saving" forever. */
const GRAB_WAIT_MS = 15_000;

function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The picture of a video at a time, or of a still, as a canvas the size of the original. */
export async function grabFrame(src: string, time: number, video: boolean): Promise<HTMLCanvasElement> {
  const media = document.createElement(video ? 'video' : 'img');
  media.crossOrigin = 'anonymous'; // before src, so the frame can be drawn to a canvas
  const loaded = new Promise<void>((resolve, reject) => {
    media.addEventListener(video ? 'loadeddata' : 'load', () => resolve(), { once: true });
    media.addEventListener('error', () => reject(new Error('The picture could not be loaded.')), {
      once: true,
    });
  });
  if (media instanceof HTMLVideoElement) {
    media.muted = true;
    media.preload = 'auto';
  }
  media.src = src;
  try {
    await within(loaded, GRAB_WAIT_MS, 'The picture took too long to load. Try again.');
  } catch (error) {
    media.removeAttribute('src'); // stops the download (MDN: emptying src then load())
    if (media instanceof HTMLVideoElement) media.load();
    throw error;
  }
  if (media instanceof HTMLVideoElement && time) {
    const seeked = new Promise<void>((resolve) =>
      media.addEventListener('seeked', () => resolve(), { once: true }),
    );
    media.currentTime = time;
    await within(seeked, GRAB_WAIT_MS, 'The video did not reach that moment. Try again.');
  }
  const width =
    (media instanceof HTMLVideoElement ? media.videoWidth : (media as HTMLImageElement).naturalWidth) || 1280;
  const height =
    (media instanceof HTMLVideoElement ? media.videoHeight : (media as HTMLImageElement).naturalHeight) ||
    720;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(media, 0, 0, width, height);
  return canvas;
}

const STRIP_HEIGHT = 144;
const strips = new Map<string, string[]>();

/** `count` frames spread over the clip as small pictures, handed over as they land; kept per clip and count. */
export async function clipStrip(
  src: string,
  count: number,
  stop: AbortSignal,
  onframes: (frames: string[]) => void,
): Promise<void> {
  const key = `${count}|${src}`;
  const kept = strips.get(key);
  if (kept) {
    onframes(kept);
    return;
  }
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  const reached = (event: string) =>
    within(
      new Promise<void>((resolve) => video.addEventListener(event, () => resolve(), { once: true })),
      GRAB_WAIT_MS,
      'The clip did not load.',
    );
  const frames: string[] = [];
  try {
    const loaded = reached('loadeddata');
    video.src = src;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.height = STRIP_HEIGHT;
    canvas.width = Math.round((STRIP_HEIGHT * video.videoWidth) / (video.videoHeight || 1));
    for (let index = 0; index < count && !stop.aborted; index++) {
      const seeked = reached('seeked');
      video.currentTime = ((index + 0.5) / count) * video.duration;
      await seeked;
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.7));
      if (!stop.aborted) onframes([...frames]);
    }
    if (frames.length === count) strips.set(key, frames);
  } catch {
    // The strip is only a help: the player says what is wrong with the clip.
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export const pngBase64 = (canvas: HTMLCanvasElement): string =>
  canvas.toDataURL('image/png').split(',')[1] ?? '';

export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('The recording could not be read.'));
    reader.readAsDataURL(blob);
  });
}

export const audioExtension = (type: string): string =>
  /ogg/.test(type) ? 'ogg' : /mp4|aac/.test(type) ? 'm4a' : 'webm';
