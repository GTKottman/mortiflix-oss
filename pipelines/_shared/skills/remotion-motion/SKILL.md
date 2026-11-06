---
name: remotion-motion
description: Build, check and render the video: a Remotion-API (React) project from the template, drawn by Kinetograph (the studio's GPU render engine, no Chrome). Stills for style frames, animatic and final renders through the studio's render queue. Use whenever you make frames or video.
---

# The video (Remotion API, rendered by Kinetograph)

The video is a React project in `video/` written with Remotion's API. The studio renders it with **Kinetograph**: a GPU
engine that runs the same code with no browser. `remotion` and `@remotion/*` imports resolve to Kinetograph's own
implementation of them, so write Remotion as usual. Never run `npx remotion` here: every still and render is
`kinetograph`, through the queue.

Frames are a pure function of the frame number: no timers, no randomness without a seed (`random('seed')` from
remotion), no network at render time. (Kinetograph drives `Math.random`, `Date` and timers from the frame, but don't
lean on it: a seed you choose is the same in every render.)

## Set up (first time)

```
node .claude/skills/remotion-motion/setup.mjs        # video/ from the template, linked to the studio's shared install
```

A project needs no packages to render: Kinetograph bundles `remotion`, `@remotion/*` and React itself. The template's
packages are Remotion's **types** only, for the type check (`npx tsc --noEmit` in `video/`, which the studio runs
before the animatic). The studio installs them once and every project links to them. Don't `npm install` inside
`video/` while it's linked (that would change the shared copy for every project). Need the types of another package?
`rm video/node_modules`, then `npm install` and `npm install <pkg>` in `video/`: this project gets its own copy.
Setup also copies Kinetograph's own skill to `.claude/skills/kinetograph` (its full authoring reference); where it
says something different, this skill wins.

Set `src/video.ts` from the brief: size (16:9 → 1920×1080, 9:16 → 1080×1920, 1:1 → 1080×1080), 30 fps, length.
Put the look from `design/LOOK.md` in `look`.

**Fonts: load every family you use.** Kinetograph reads no system fonts: `system-ui`, `Arial`, `sans-serif` and
`monospace` are not there, and text in a family that isn't loaded is drawn in a fallback (and warned about). Use
`@remotion/google-fonts/<Family>` (`const { fontFamily } = loadFont()` at the top of a file; downloaded once, then
cached) or local files in `video/public/` with `@font-face` / `staticFile()`; never a font you can't license. Code
and numbers in a mono face: load one (`@remotion/google-fonts/JetBrainsMono`). The fallback covers symbols and emoji
(monochrome), not CJK, Arabic or Devanagari: load a font for those.

## Build scenes

- One component per beat in `src/scenes/`, placed in `Main.tsx` with `<Sequence from={...} durationInFrames={...}>`
  (`<Series>`, `<Loop>`, `<Freeze>` and `@remotion/transitions`' `<TransitionSeries>` work as documented).
- Timing in frames comes from the narration's word timings (`voice/timing.json`) or the music's beat grid: put the
  numbers in `src/timing.ts`, never scattered magic numbers.
- Motion: `spring()` and `interpolate(..., { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })`,
  `interpolateColors`, `Easing`. Easing per the motion-design skill.
- Audio: `<Audio src={staticFile('voice.wav')} />` (files in `video/public/`).
- Images and video from the brief: copy them into `video/public/`, `<Img>` / `<OffthreadVideo>` (or `<Video>`). PNG,
  JPEG, GIF, WebP and SVG pictures; local files only (a remote URL is not drawn).
- Styling: inline `style`, `className` with a `.css` import, and SVG all work; Kinetograph's own CSS engine lays them
  out and draws them as a browser would. Canvas 2D and WebGL fragment shaders in a `<canvas>` work too (redraw the
  whole canvas from the frame number every frame, never on top of the last one).

### What Kinetograph does not draw: avoid it

Unsupported content is left out of the frame (or approximated) with a `warning:` on stderr, so a render can "succeed"
with something missing. Don't use:

- CSS: `image-rendering`, `background-attachment: fixed`, `box-decoration-break: clone`, vertical `writing-mode`,
  multi-column, the old `clip`, `list-style-image`, `evenodd` clip paths, `shape()`, `mask-composite` other than add,
  `backdrop-filter` other than `blur()` (blur and glow are capped at 128 px), CSS filter functions (`blur()`) or basic
  shapes on elements *inside* an `<svg>`, remote URLs and fonts that aren't loaded.
- Elements: form controls, `<IFrame>` (needs a browser), text inside an SVG *picture* file (`<Img src="a.svg">`; SVG
  written in JSX draws its text).
- `preserve-3d` scenes whose planes cross each other (drawn back to front, no depth buffer).
- Packages: `@remotion/three` (no Three.js), `@remotion/player`, `@remotion/renderer`, `@remotion/bundler`,
  `@remotion/lambda`, `@remotion/studio`. Any other `@remotion/*` not in this list stops the build:
  `transitions`, `motion-blur`, `noise`, `paths`, `shapes`, `layout-utils`, `animation-utils`, `captions`,
  `google-fonts`, `fonts`, `lottie`, `gif`, `media-utils`, `media`, `light-leaks`, `starburst`, `sfx` (each needs its
  types installed, see Set up).
- Kinetograph-only elements and effects (`<Layer>`, `<Text>`, `<Rect>`, `dropShadow()`...): they render, but the type
  check runs against Remotion's types and fails on them. Stay with the Remotion API, HTML, CSS and SVG.

## Render: always through the queue

Everything that draws frames goes through `mfx render` (one heavy job at a time, studio-wide). The CLI is `kinetograph`
(on the PATH in a session; never `npx kinetograph`, which would fetch another version):

```
# a style frame (a still at a chosen frame)
mfx render --label "SF01" -- kinetograph still src/index.ts 45 --comp Main -o ../out/frames/sf01.png
# a contact sheet of 12 frames across the video (the cheapest look at the whole motion)
mfx render --label "strip" -- kinetograph strip src/index.ts -n 12 --comp Main -o ../out/frames/strip.png
# the animatic (full size; --draft is half size, a --scale rounds each side down to an even number)
mfx render --label "animatic" -- kinetograph render src/index.ts --comp Main -o ../out/animatic.mp4
# the final
mfx render --label "final" -- kinetograph render src/index.ts --comp Main -o ../out/final.mp4 --codec h264 --crf 18
mfx render-wait <id>     # repeat until state is done or failed
```

Run `mfx render` from inside `video/` (the render runs in the folder you call it from). Don't add `--json` to a queued
render: the queue reads its `rendering frame N/T` line for progress. Other export flags are Remotion's names:
`--range a..b` (b not included; `a..=b` includes it), `--codec h265|prores|vp9|gif`, `--pixel-format`, `--concurrency N`
(default half the cores, at most 4). There are no `--gl` modes: every render is drawn the same way on the GPU.

- Stills for style frames: render, then **view each one** before submitting.
- After every video render: `node .claude/skills/final-pass/qc.mjs out/<file>.mp4 ...` and look at the sheet.
- A failed render: read `output_tail`, fix, re-queue.

## Check without rendering (no queue needed)

These run the code on the CPU, draw nothing and take seconds; run them from `video/`:

- `npx tsc --noEmit`: the type check the studio runs before the animatic. Fix every error (a misspelled prop renders
  silently wrong, it never fails a render).
- `kinetograph doctor src/index.ts --comp Main`: every frame, what the render would leave out or approximate, with
  the frames. Run it before any long render and bring it to 100% clean.
- `kinetograph lint src/index.ts --comp Main`: text overflowing its box or the frame, overlapping text, layers off the
  frame, missing fonts and files. Fix what it says.
- `kinetograph inspect src/index.ts --frame 45 --comp Main`: every layer's position, size and text lines, when
  something sits in the wrong place.

## Faster iteration

A still takes about a second. Check a beat with three stills (start, middle, settled) or one `strip` before rendering
motion, and `doctor` before every full render.
