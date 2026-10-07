# Social short

A 45 second to 3 minute short for a feed, usually vertical. People decide in the first second whether to keep watching, and
most watch with the sound off. The owner reviews each stage in the studio (`.mortiflix/GATES.md`).

Skills: `motion-design`, `remotion-motion`, `voiceover` (only if the brief wants narration), `final-pass`.

## Core rules

1. **Hook first.** Frame 0 shows the most interesting thing. No logo intro.
2. **One idea, one call to action.** If there are three messages, ask which one at the brief.
3. **Sound off works.** Every word that matters is on screen; captions if there's narration.
4. **Platform safe zones:** keep text clear of the platform's buttons and captions (`platform-safe-zones`).
5. **Reuse approved work** and **answer every note** (`pin_changes`).

## Steps

| Step | Review | What happens |
|---|---|---|
| `brief` | questions | Restate the message in one line and the hook you'd open with. Ask about tone, the CTA, music, narration, each with a default. |
| `style-frames` | frames | The on-screen script (as a text item: every line with its time) plus 2–3 full-resolution stills: the hook frame, a middle frame, the CTA card. |
| `transitions` | frames | The transition-board skill: for every cut between consecutive scenes, the carrier (the object or element that makes it happen), why, a transition from the remotion-transitions library (or a new one inspired by it), its length and the word it lands on. `board.mjs check` passes; submit one panel per cut (outgoing frame, real in-betweens, incoming frame, the library's preview) and `BOARD.md`. The approved board is the cut list from here on. |
| `final` | video | Animate, mix (if there's sound), `qc.mjs` with the brief's size and length, look at the sheet. Submit the video and the sheet. |

## Status lines

`brief`, `frames`, `build`, `qc`, `deliver`.
