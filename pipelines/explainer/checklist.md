# Production checklist

Tick items as you finish them (`- [x]`). The next session resumes from the first unticked one.

## Brief
- [ ] Read the brief and every file in `input/`
- [ ] Brief submitted (three-line restatement + questions with defaults)

## Script
- [ ] Beats written, one idea each, visual note per beat
- [ ] Fits the length (word count) · facts checked against sources
- [ ] Script submitted

## Style frames
- [ ] Remotion project set up in `video/` (remotion-motion skill)
- [ ] Look decided: palette (hex), type (licensed fonts), shape language, texture
- [ ] SF01–SF05 rendered as stills and viewed one by one
- [ ] Checks run · style frames submitted

## Animatic
- [ ] Narration recorded and timed (or music bed chosen), word timings saved
- [ ] Every beat placed on the timeline in the approved look
- [ ] Rendered through `mfx render` · qc.mjs + frame sheet viewed
- [ ] Animatic submitted

## Music (skipped when the owner chose no music)
- [ ] Spotting map and tempo map from the animatic's real timing
- [ ] Blueprint · `strudel.mjs plan` passes
- [ ] Score (notes only) · `strudel.mjs check` at 0 problems · MIDI captured
- [ ] `music/instruments.json` · `instruments` and `audition` pass · render · mixed under the voice
- [ ] Music submitted (animatic with the music, the music alone, MUSIC-SHEET.md)

## Build
- [ ] Owner finishes the music: `strudel.mjs own-master` passes (or `mfx needs-you`, then stop)
- [ ] Final motion: easing, transitions, holds, texture
- [ ] Sound design and mix (-14 LUFS, peaks ≤ -1 dBTP)
- [ ] Full render · qc.mjs PASS · frame sheet viewed · `mfx step done build`

## Final
- [ ] Final + frame sheet submitted
- [ ] Every note answered in the next version (if any)
