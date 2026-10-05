---
name: remotion-motion
description: Build, preview and render the video in Remotion (React): project setup from the template, stills for style frames, animatic and final renders through the studio's render queue. Use whenever you make frames or video.
---

# Remotion

The video is a React project in `video/`. Frames are a pure function of the frame number: no timers, no randomness
without a seed (`random('seed')` from remotion), no network at render time.

## Set up (first time)

```
node .claude/skills/remotion-motion/setup.mjs        # video/ from the template, linked to the studio's shared install
```

The studio installs Remotion (and its Chrome, ~750 MB) once and every project links to it: seconds, not a fresh
install. Don't `npm install` inside `video/` while it's linked (that would change the shared copy for every project).
Need another package? `rm video/node_modules`, then `npm install` and `npm install <pkg>` in `video/`: this project
gets its own copy.

Set `src/video.ts` from the brief: size (16:9 → 1920×1080, 9:16 → 1080×1920, 1:1 → 1080×1080), 30 fps, length.
Put the look from `design/LOOK.md` in `look`. Fonts: `@remotion/google-fonts/<Family>` (`loadFont()` at the top of a
file) or local files in `video/public/` with `staticFile()`; never a font you can't license.

## Build scenes

- One component per beat in `src/scenes/`, placed in `Main.tsx` with `<Sequence from={...} durationInFrames={...}>`.
- Timing in frames comes from the narration's word timings (`voice/timing.json`) or the music's beat grid: put the
  numbers in `src/timing.ts`, never scattered magic numbers.
- Motion: `spring()` and `interpolate(..., { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })`. Easing per the
  motion-design skill.
- Audio: `<Audio src={staticFile('voice.wav')} />` (files in `video/public/`).
- Images and video from the brief: copy them into `video/public/`, `<Img>` / `<OffthreadVideo>`.

## Render: always through the queue

Everything that starts Remotion's browser goes through `mfx render` (one heavy job at a time, studio-wide):

```
# a style frame (a still at a chosen frame)
mfx render --label "SF01" -- npx remotion still src/index.ts Main ../out/frames/sf01.png --frame=45
# the animatic (720p is enough for timing)
mfx render --label "animatic" -- npx remotion render src/index.ts Main ../out/animatic.mp4 --scale=0.6667
# the final
mfx render --label "final" -- npx remotion render src/index.ts Main ../out/final.mp4 --codec=h264 --crf=18
mfx render-wait <id>     # repeat until state is done or failed
```

Run `mfx render` from inside `video/` (the render runs in the folder you call it from).

- Stills for style frames: render, then **view each one** before submitting.
- After every video render: `node .claude/skills/final-pass/qc.mjs out/<file>.mp4 ...` and look at the sheet.
- A failed render: read `output_tail`, fix, re-queue. GPU flags (`--gl=angle`) can speed renders up on machines that
  support them; use one `--gl` mode for every render of a video so cuts never shimmer.

## Faster iteration

`npx remotion still` at a few key frames is far cheaper than a full render. Check a beat with three stills (start,
middle, settled) before rendering motion.
