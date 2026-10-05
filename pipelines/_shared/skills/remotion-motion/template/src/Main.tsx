import { AbsoluteFill, Sequence, spring, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { look } from './video';

// A starting point only: one title beat with an eased entrance and a hold. Replace it with the script's beats.
const Title = ({ text }: { text: string }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: `0 ${look.safe * 100 * 2}%` }}>
      <div
        style={{
          fontFamily: look.font,
          fontSize: height * 0.08,
          fontWeight: 700,
          color: look.ink,
          opacity: enter,
          transform: `translateY(${interpolate(enter, [0, 1], [height * 0.03, 0])}px)`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

export const Main = () => (
  <AbsoluteFill style={{ backgroundColor: look.background }}>
    <Sequence durationInFrames={150}>
      <Title text="Replace me with beat one" />
    </Sequence>
  </AbsoluteFill>
);
