import { bridgeUrl } from './base';
// Addresses of studio files served by the bridge: /file for the whole file, /thumb for a small cached picture.

/** Pictures that are not studio files: a data address, or the app's own fixtures under /screens/. */
const isLocal = (path: string): boolean => /^(data:|blob:|\/screens\/)/.test(path);

/** The whole file (picture, audio or video) at a studio path; app-local addresses pass through. */
export const fileUrl = (path: string): string =>
  isLocal(path) ? path : bridgeUrl(`/file?path=${encodeURIComponent(path)}`);

const THUMB_MIN = 32;
const THUMB_MAX = 1280;

/** A small cached WebP of a picture; `width` is kept between 32 and 1280. Use fileUrl only to view full size. */
export const thumbUrl = (path: string, width = 480): string =>
  isLocal(path)
    ? path
    : bridgeUrl(`/thumb?path=${encodeURIComponent(path)}&w=${Math.max(THUMB_MIN, Math.min(THUMB_MAX, Math.round(width)))}`);

const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i;

/** True when the path names a video file. */
export const isVideoPath = (path: string): boolean => VIDEO_EXTENSION.test(path);

/** Anything with the service's `call` (the app's ServiceClient). */
interface Caller {
  call<T>(type: string, given?: Record<string, unknown>): Promise<T>;
}

/** Opens the folder holding a studio file in the file manager (files.reveal); answers a short sentence to show. */
export async function revealFile(client: Caller, path: string): Promise<string> {
  try {
    await client.call('files.reveal', { path });
    return 'Folder opened.';
  } catch (error) {
    return error instanceof Error && error.message ? error.message : 'Could not open the folder.';
  }
}
