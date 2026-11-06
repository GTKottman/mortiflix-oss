import { isVideo } from './media';
import { mainShot } from './scenes';
import type { ClipStatus, PlanShot, Scene, SceneVersion } from './types';

/** The picture on screen: where it is, whether it plays, and the node a note on it is saved against. */
export interface SceneMedia {
  path: string | null;
  video: boolean;
  node: string | null;
}

/** The viewed version's clip, else the scene's own shot media. */
export function sceneMedia(shots: readonly PlanShot[], version: SceneVersion | null): SceneMedia {
  const shot = mainShot(shots);
  const node = shot?.node ?? null;
  if (version?.file) return { path: version.file, video: true, node };
  const path = shot?.media?.path ?? null;
  return { path, video: Boolean(path && isVideo(path) && shot?.media?.kind === 'video'), node };
}

/** Notes can be written: there is a picture, and the scene is not waiting, failed or approved. A note on an approved
 *  scene could never be sent (Request fix needs a scene in review), so it would sit "Not sent" for ever. */
export function canWriteNote(media: SceneMedia, scene: Scene | undefined, clip: ClipStatus): boolean {
  return Boolean(
    media.path &&
    media.node &&
    scene &&
    !['waiting', 'failed', 'ok'].includes(scene.state) &&
    clip !== 'error',
  );
}
