---
name: motion-design
description: The craft of a motion design video, from the look to the final: style frames, layout, type, colour, timing, easing and transitions. Use for every style frame, animatic and build.
---

# Motion design

A motion design video is a sequence of designed frames that move. Design the frames first; motion connects them.

## The look (style frames)

- **A frame is a moment, not a mood board.** Each style frame is a real shot from the script, with its real words,
  at full resolution. If it can't appear in the final video exactly as drawn, it isn't a style frame.
- **Pick the system before the pictures.** Write `design/LOOK.md` first:
  - palette: 1 background, 1–2 neutrals, 1 accent (hex values). The accent marks the one thing to look at.
  - type: one family for headlines, one for body at most. Licensed (Google Fonts are a safe default).
    Sizes on a scale (e.g. 1.25×). Headlines ≥ 5% of frame height in 16:9, larger in 9:16.
  - grid: margins (title-safe 5%, action-safe 3.5%), columns, where text lives.
  - shape language: rounded or sharp, flat or dimensional, line weight, texture (grain, paper, none).
- **Three to five frames** that cover the range: the opening, the densest information moment, a transition
  state, the ending card. If they don't look like one film side by side, the system isn't done.
- **Brand files from the brief win.** Use their logo as given (never redraw it), their colours exactly.

## Layout

- One focal point per frame. Squint: the thing you want seen first must still stand out.
- Align everything to the grid. Text left-aligned unless it's a single centred line.
- Contrast for text ≥ 4.5:1. Never text on a busy area without a plate or a shadow.
- Nothing touches the frame edge except full-bleed shapes.

## Timing

- Narration sets the clock (or the music's beat grid when there's no voice). Every beat starts on a word or a hit.
- **Read time:** on-screen text stays at least `words / 3 + 1` seconds after it finishes animating in.
- **Holds:** let the key idea sit still for a beat. Constant motion is noise.
- Pace changes are structure: a faster middle, a slower landing.

## Motion

- **Easing:** nothing moves linearly except mechanical things. Ease out on entrances (fast in, soft landing),
  ease in on exits. In Remotion, `spring({ frame, fps, config: { damping: 200 } })` for calm, lower damping for bounce.
- **Stagger** related elements by 2–4 frames; never animate a whole layout as one block.
- **Overlap actions:** the next element starts before the last one fully settles.
- **Transitions carry meaning:** a shape from one scene becomes the frame of the next (match cut), or the camera moves
  through the space. Use crossfades only when nothing better connects the two ideas.
- **Anticipation and follow-through** for anything with weight.
- Keep motion inside the safe areas; motion blur on fast moves (or don't move that fast).

## Sound

- Music sits about 18 dB under the voice while it speaks; it can come up in the gaps.
- Sound design (whooshes, clicks, hits) on maybe one action in five: the important ones.
- Mix to -14 LUFS integrated, true peak ≤ -1 dBTP (final-pass skill).

## Before every submission

View every still you send. Run `qc.mjs` on every video and look at the sheet. Read every word on screen once more.
