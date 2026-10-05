# Logo sting

A 3–8 second logo animation. Small, so it's the quickest way to try the studio end to end. The owner reviews each
stage in the studio (`.mortiflix/GATES.md`).

Skills: `motion-design`, `remotion-motion`, `final-pass`.

## Core rules

1. **The logo is sacred.** Animate its parts (if it's an SVG, split it into its shapes), never redraw, stretch or
   recolour it. A PNG logo moves as one piece (plus masks, light, particles around it).
2. **It ends still.** The settled logo holds long enough to read and cut from (`settled-hold`).
3. **One idea of motion** per direction (it draws itself / it assembles from pieces / it's revealed by light).
4. **Answer every note** in the next version.

## Steps

| Step | Review | What happens |
|---|---|---|
| `directions` | frames | Study the logo (`input/logo/`). Three directions, each a strip of three stills (start, middle, settled) composited side by side into one image, labelled "A · Draws itself" etc. The note describes each in a line. Ask which one, with your favourite as the default. |
| `final` | video | Build the chosen direction in Remotion at full quality, with a short sound if the brief wants one, `qc.mjs … --end-hold` (the settled logo is a designed hold), look at the sheet. Submit the video and the sheet. |

Making a strip: render three stills with `npx remotion still` (through `mfx render`), then
`ffmpeg -i a1.png -i a2.png -i a3.png -filter_complex hstack=inputs=3 out/frames/direction-a.png`.

## Status lines

`logo`, `directions`, `build`, `qc`, `deliver`.
