# Explainer video

A 30-second to 2-minute motion design explainer, built in Remotion. After it, a viewer understands one idea and
remembers one thing. The owner reviews each stage in the studio (`.mortiflix/GATES.md`).

Skills (read the one a step names before starting it):
- `.claude/skills/motion-design/SKILL.md`: the craft, from style frames to the final.
- `.claude/skills/remotion-motion/SKILL.md`: the Remotion project, stills, renders.
- `.claude/skills/transition-board/SKILL.md`: every cut, designed and carried, from the transitions library.
- `.claude/skills/voiceover/SKILL.md`: narration and word timing.
- `.claude/skills/music/SKILL.md`: the music engine: the original score, written to the approved animatic, as MIDI.
- `.claude/skills/final-pass/SKILL.md`: `qc.mjs`, the automated checks plus the frame sheet.

## Core rules

1. **One idea.** Everything serves the one thing the viewer should remember (from the brief). Cut anything that doesn't.
2. **Reuse approved work.** The approved script is spoken word for word. The approved style frames fix the look:
   palette, type, shape language, texture. The approved animatic fixes the timing.
3. **Real assets only from the brief or with a clear licence.** Note every outside asset's source and licence in
   `assets/SOURCES.md`. Never imitate a real brand that isn't the owner's own.
4. **Look before you send.** Every still you submit, you've viewed. Every video you submit, you've run through
   `qc.mjs` and looked at its frame sheet.
5. **Every note answered** in the next version (`pin_changes`).

## Steps

| Step | Review | What happens |
|---|---|---|
| `brief` | questions | Read the brief and any files. Restate it in three lines (what, for whom, the one takeaway) as the note. Ask only questions that change the video, each with a default: tone, the call to action, must-say facts, narration voice (if narrated). |
| `script` | document | Write it (or tidy the owner's own, which is then spoken verbatim). Beats as paragraphs: one idea per beat, each with a one-line visual note in *italics*. Fit the length (`script-fits-length`). Submit `script.md`. |
| `style-frames` | frames | Runs beside the script. Three to five stills at full resolution, each a real moment of the video (opening, the key idea, the ending card), in one coherent look. Submit PNGs labelled `SF01 · Opening` etc. |
| `transitions` | frames | The transition-board skill: for every cut between consecutive scenes, the carrier (the object or element that makes it happen), why, a transition from the remotion-transitions library (or a new one inspired by it), its length and the word it lands on. `board.mjs check` passes; submit one panel per cut (outgoing frame, real in-betweens, incoming frame, the library's preview) and `BOARD.md`. The approved board is the cut list from here on. |
| `animatic` | video | Narration first (voiceover skill), then every beat timed to it with simple motion in the approved look, cut with the approved board's transitions. No music yet: the music step scores this timing. The owner judges pace and order here, not polish. 720p is fine. |
| `music` | video | Skipped when the owner chose no music. Otherwise the music skill, start to finish: the dramatic reading, the spotting map from the animatic's real timing, the blueprint, the score (notes only), `strudel.mjs check` at 0 problems (it captures the MIDI), instruments for every channel and the audition, the render, the mix under the voice. Submit the animatic with the music mixed in, the music alone, and `music/MUSIC-SHEET.md`. When the owner finishes it themselves (the brief's music answer), the note says the MIDI pack is ready on the project page. |
| `build` | internal | The final animation at full quality: easing, transitions, texture, sound design, the mix with the approved music (re-timed only if the animation moved). When the owner finishes the music from the MIDI, start with `strudel.mjs own-master` (music skill §9): without their master yet, `mfx needs-you` and stop; with it, mix their master, never the stand-in. Through `mfx render`. Run every check (`mfx checks build`), then `mfx step done build --checks checks/build.json`. |
| `final` | video | The final at full resolution with the frame sheet as a second item (and `out/music/midi.zip` and the stems when the owner asked for the MIDI pack: music skill §11). Corrections loop: fix, re-run the checks, submit the next version. |

## Status lines

Use `mfx status <key>`: `brief`, `research`, `script`, `frames`, `voice`, `music`, `animatic`, `build`, `qc`, `deliver`.

## Start of every session

Read `checklist.md` (copied here on the first session), `JOURNAL.md` and `feedback/`; resume from the first unticked
item. Keep the checklist current: it's how the next session picks up.
