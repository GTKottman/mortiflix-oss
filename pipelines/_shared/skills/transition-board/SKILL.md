---
name: transition-board
description: Designing every cut of a video before the animatic - for each change from one style frame to the next, the object or idea that carries it, a transition chosen from the owner's remotion-transitions library (or a new one inspired by it), its timing on the narration, and a board panel showing the real in-between frames. Use for any transitions step, or when a cut changes.
---

# The transition board

Every cut is designed. Between each style frame and the next there is **something that carries the change**: a
shape that grows, a line that leads the eye, a camera that moves, an element that becomes another. A transition
without a carrier and a reason doesn't go on the board.

**The screen never goes blank.** No transition fills the frame with a colour (a cover or dip to purple, black or
any flat colour) or blows it out to white (a flash or light leak to white). The scenes' own elements do the
transition: they move, grow, open, fold, carry the eye, or a real object (2D or 3D) passes through the frame and
brings the next scene with it. `board.mjs check` looks at every 10% of each transition and fails a frame that is
flooded with a colour neither scene has, blown out, or emptied of the scenes' elements. Library transitions that
work by covering the frame (most of `04-cover`, dips, flashes) are only usable if the cover itself is made of the
scenes' elements; otherwise choose another or make a new one.

The transitions come from the owner's library, [remotion-transitions](https://github.com/GTKottman/remotion-transitions)
(`$MFX_TRANSITIONS`): 50 transitions in nine families, each a drop-in `<TransitionSeries>` presentation with a
catalog entry and a preview.

```
B=.claude/skills/transition-board/board.mjs
node $B list [--function section-break] [--family 04-cover]   # choose
node $B use liquid-fill flash ...                             # copy them (and their core) into video/src/transitions/
node $B posters                                               # the library's preview stills, for the board
node $B check                                                 # the rules: must pass
node $B panels                                                # one review image per cut
```

## 1. Learn the library

Read `$MFX_TRANSITIONS/TAXONOMY.md` (the nine families, how each works, timing and craft) and skim the catalog with
`node $B list`. Each entry says what it's for (`function`: continuity, energy, section-break, reveal, progression,
contrast, brand…), how it's built (`structure`, `origin`, `edge`), its length range in frames, and its parameters.
Most take `color`: **the incoming scene's background colour**, so the change arrives through a shape in the new
scene's own colour.

## 2. Find each cut's carrier

Go through the approved script and style frames in order. For every change of scene, before choosing anything, write:

- **The carrier**: the object or element in the frames that makes the change happen. Look at both frames: what in
  the outgoing frame can lead into the incoming one (the `$` in the price, the terminal window, the stage track's
  next node, the mark, a line of text, the light)? A good carrier is already on screen.
- **Why**: what the cut means in the story, in one sentence: continuity (the same idea, carried on), a turn (the
  story changes direction), a section break, a reveal, a rise in energy, a breath.
- **Where it lands**: the word or beat in the narration the cut lands on.

## 3. Choose the transition

Pick from the library by what the cut means and what carries it, not for variety's sake:

- **Continuity** inside a section: quiet families (blend, a carry, a match cut, a short motion move).
- **Section breaks and turns**: the bigger moves (carries, portals, a 3D object through the frame, motion with
  weight), reserved so they mean something.
- **A vocabulary**: two to four families across the whole video, used consistently (the same kind of cut means the
  same kind of change). The check warns when one family dominates or when there are too many.
- **Length**: inside the transition's range, and long enough to read under the narration; snap cuts on beats,
  slower ones in breaths.

**3D carriers.** A real 3D object can carry a cut: a wobbling sphere that flies at the camera and fills the lens
as it passes, revealing the next scene behind it; a ribbon or a swarm that sweeps across. Render it in the
studio's Blender (blender-3d skill) as a transparent image sequence (`-F PNG`, RGBA, film transparent) and use it
as the transition's layer, with the outgoing scene before it passes and the incoming scene after. The object is the
carrier, never a flat cover: the scenes stay visible around and through it.

**If nothing in the library fits**, design a new one, inspired by the library entries closest to it: write it in the
library's format (`transition.json` + `index.tsx`, built on `video/src/transitions/core`) in
`video/src/transitions/<new-id>/`, and mark it on the board as `{"new": "<new-id>", "inspired_by": ["<id>", …]}`.
Never edit the library itself (it's the owner's repository; a new transition worth sharing can be proposed there
through its CONTRIBUTING protocol later, by the owner).

Write `transitions/board.json`:

```json
{ "cuts": [
  { "from": "SF01 · The hook", "to": "SF02 · The turn",
    "a": "out/frames/sf01.png", "b": "out/frames/sf02.png",
    "carrier": "the gradient inside the $5,400",
    "why": "The price's colour floods the frame and drains away into the promise: the cost dissolves.",
    "transition": "liquid-fill", "params": { "color": "#0B0913" }, "frames": 96,
    "lands_on": "\"Now\", the first word of beat 2",
    "mids": ["out/board/cut-01-35.png", "out/board/cut-01-65.png"],
    "strip": ["out/board/cut-01/10.png", "…", "out/board/cut-01/90.png"] }
] }
```

Cuts run through the scenes in order (each starts where the last ended). Run `node $B check` until it passes.

## 4. Copy the transitions into the video

`node $B use <id> …` copies the library's `core/` and each chosen transition into `video/src/transitions/` with
their imports fixed. Use them exactly as the library says:

```tsx
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { toPresentation } from './transitions/core';
import liquidFill from './transitions/liquid-fill';

<TransitionSeries.Transition presentation={toPresentation(liquidFill, { color: '#0B0913' })}
  timing={linearTiming({ durationInFrames: 96 })} />
```

Always `linearTiming` (each transition does its own easing). Transitions whose catalog entry `requires` `webgl2`
render with `--gl=angle` (or `--gl=swangle` with no GPU). Keep every cut in one place in the video's code (one
list of cuts), so a changed board changes the video in one edit.

## 5. Render the in-betweens

For each cut, a board composition puts the two style frames in a `<TransitionSeries>` with the chosen transition and
renders real stills **from the transition itself**, at about 35% and 65% of its length, so the owner sees exactly
how one frame becomes the next:

```tsx
const HOLD = 30;   // frames of the outgoing still before the transition starts
<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={HOLD + cut.frames}><Still src={cut.a} /></TransitionSeries.Sequence>
  <TransitionSeries.Transition presentation={...} timing={linearTiming({ durationInFrames: cut.frames })} />
  <TransitionSeries.Sequence durationInFrames={HOLD + cut.frames}><Still src={cut.b} /></TransitionSeries.Sequence>
</TransitionSeries>
// stills at frame HOLD + round(cut.frames * 0.35) and HOLD + round(cut.frames * 0.65)
```

Also render the **strip**: a still every 10% of the transition (10% to 90%), listed as `"strip"` in the cut's
entry: the check reads every one of them for blank frames. Render through `mfx render` (`npx remotion still …
--frame=N`, with `--gl=angle` where needed). Look at every in-between: if the carrier doesn't read in it, the cut
isn't working yet. Fix the choice, not the frame.

## 6. Submit the board

`node $B posters`, then `node $B panels`: one image per cut, reading left to right: the outgoing frame, the real
in-betweens, the incoming frame, and the library's preview still of that transition, dimmed, for reference.

Submit every panel as an image item, labelled `Cut 03 · SF03 → SF04 · Liquid Fill (cover) · carried by the terminal
window`, and `transitions/BOARD.md` as a text item: for each cut, the carrier, the why, the transition and its
family, its length, and the word it lands on. The note: the video's transition vocabulary in two or three lines.

The approved board is the animatic's cut list: the animatic uses these transitions at these lengths, landing on
these words.
