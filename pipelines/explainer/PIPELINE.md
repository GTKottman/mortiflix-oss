# Explainer video

A motion design explainer, built in Kinetograph: usually 30 seconds to 2 minutes, but the brief's length rules (a custom
length such as 25 min is a long-form explainer: the same steps, still one beat per idea and one shot per beat, the
script fitted to that length). After it, a viewer understands one idea and remembers one thing. The owner reviews each stage in the studio (`.mortiflix/GATES.md`). Nothing of a step is made before the steps before it are approved: no drafts ahead, no renders before the gate.

Skills (read the one a step names before starting it):
- `.claude/skills/motion-design/SKILL.md`: the craft, from style frames to the final.
- `.claude/skills/remotion-motion/SKILL.md`: the video project (Remotion-API TSX, rendered by Kinetograph), stills, renders.
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
| `script` | document | Write it (or tidy the owner's own, which is then spoken verbatim). Beats as paragraphs: one idea per beat, each starting with its id (`B01 · …`) and a one-line visual note in *italics*. Fit the length (`script-fits-length`). Submit `script.md`, and write `script/beats.json` (the canvas, see GATES.md). |
| `voice` | audio | Skipped when the brief has no narration. The voiceover skill on the approved script: one line per sentence in `voice/lines.json` (ids `b01-1`, …), a clip per line in `voice/clips/`, word timings in `voice/timing.json`. The narration is exactly what the voice engine made (ElevenLabs `pcm_48000`, lossless): never sped up or slowed down, never compressed, limited, EQ'd or loudness-normalized; only the silence at line edges is cut. Too long for the brief: fewer words, never a faster voice (the picture is cut to the voice). The owner checks each scene's voice before anything is drawn. |
| `style-frames` | frames | After the voice is approved and the owner picked a look: start from `design/look-brief.json` (their style pack's files, or the font, colours, vibe and look they chose; use them as given). Three to five stills at full resolution, each a real moment of the video (opening, the key idea, the ending card), in one coherent look. Make the style frames straight in Kinetograph from the style pack (open its `pack_files` pictures, take their palette, type and shapes). Submit PNGs labelled `SF01 · Opening` etc., and write `design/frames.json` saying which beats each frame shows. |
| `transitions` | frames | After the owner picked the transitions: `design/transition-brief.json` (their transition pack's transitions to pick from, or the library). The transition-board skill: for every cut between consecutive scenes, the carrier (the object or element that makes it happen), why, a transition from the remotion-transitions library (or a new one inspired by it), its length and the word it lands on. `board.mjs check` passes; submit one panel per cut (outgoing frame, real in-betweens, incoming frame, the library's preview) and `BOARD.md`. The approved board is the cut list from here on. |
| `animatic` | video | After the owner picked the motion: `design/motion-brief.json` (their motion pack's moves, easing and pace, and the rule packs to follow, or "left to you"). Every beat timed to the approved narration (never re-recorded here) with simple motion in the approved look, cut with the approved board's transitions. No music yet: the music step scores this timing. The owner judges pace and order here, not polish. 720p is fine. Write `out/scenes.json` (one scene per beat, its frames in the video). |
| `music` | video | Skipped when the owner chose no music. Otherwise the music skill, start to finish: the dramatic reading, the spotting map from the animatic's real timing, the blueprint, the score (notes only), `strudel.mjs check` at 0 problems (it captures the MIDI), instruments for every channel and the audition (no sample boosted more than 12 dB), the stems (`strudel.mjs render --stems`), then the mix with Dubstage (`$MFX_DUBSTAGE`, soundtrack v1): the narration untouched, the score under it, effects from the SFX pack, one plain delivery gain, `--bus-out` so the voice can be proven untouched (mix minus bus = the voice times one gain). Never mix with ffmpeg filters, compressors or limiters on the voice. Submit the animatic with the music mixed in, the music alone, and `music/MUSIC-SHEET.md`. When the owner finishes it themselves (the brief's music answer), the note says the MIDI pack is ready on the project page. |
| `build` | internal | The final animation at full quality: easing, transitions, texture, sound design, the soundtrack is `sound/mix.wav` (Dubstage, approved at the music step), used as it is: never re-mixed, compressed or limited; if the animation moved, run Dubstage again with the new timing, the narration untouched. When the owner finishes the music from the MIDI, start with `strudel.mjs own-master` (music skill §9): without their master yet, `mfx needs-you` and stop; with it, run Dubstage with `music/own-master/master.wav` as the score (`=Auto@<offset_sec>`) and the narration untouched, never the stand-in. Through `mfx render`. Run every check (`mfx checks build`), then `mfx step done build --checks checks/build.json`. |
| `final` | video | The final at full resolution with the frame sheet as a second item (and `out/music/midi.zip` and the stems when the owner asked for the MIDI pack: music skill §11). Corrections loop: fix, re-run the checks, submit the next version. |

## Status lines

Use `mfx status <key>`: `brief`, `research`, `script`, `frames`, `voice`, `music`, `animatic`, `build`, `qc`, `deliver`.

## Start of every session

Read `checklist.md` (copied here on the first session), `JOURNAL.md` and `feedback/`; resume from the first unticked
item. Keep the checklist current: it's how the next session picks up.
