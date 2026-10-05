import { Composition } from 'remotion';
import { Main } from './Main';
import { video } from './video';

// One composition per deliverable. Size, rate and length come from video.ts (set them from the brief).
export const Root = () => (
  <>
    <Composition
      id="Main"
      component={Main}
      width={video.width}
      height={video.height}
      fps={video.fps}
      durationInFrames={Math.round(video.seconds * video.fps)}
    />
  </>
);
