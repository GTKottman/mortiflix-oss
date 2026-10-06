---
name: music
description: Scoring a video with original music written in Strudel, after the animatic is approved - a dramatic reading, a spotting map from the locked timing, a blueprint (motif, chart, roles, story sections with an intensity curve), the score, a machine check (harmony lock, hits within a frame, the curve), the render, the mix under the voice, and an optional MIDI pack. Use for any music step or a change to a cue.
---

# Music

Music is drama organised in time. The approved animatic fixes the timing, so the cue is written **to the picture**:
it builds where the video builds, holds back where it needs room, and lands its hits on the frames that matter.

```
M=.claude/skills/music/strudel.mjs
node $M check  --video-sec 118.4 --fps 30     # music/score.strudel.js against music/blueprint.json: must pass
node $M render [--stems]                      # out/music/score.wav (+ one file per part)
node $M midi                                  # out/music/midi/: every part, the arrangement, CUE-SHEET.md
```

Read `craft/picture-scoring.md` before your first blueprint, `craft/melody-craft.md` before writing the motif,
`craft/harmony-lock.md` before the score, and `craft/rich-voicing.md` once the lock passes.

## 0. What the owner set up

`$MFX_MUSIC` is `{"engine": "strudel" | "none", "midi": true | false}`. Strudel is at `$MFX_STRUDEL`, and renders in
the Chrome at `$MFX_CHROME`. If either is missing: `mfx needs-you "Music isn't set up: run mortiflix setup music,
then resume."` Never improvise music any other way.

## 1. Read the drama

From the approved script, the animatic and the brief, write in `music/SPOTTING.md`:

- **The dramatic reading** in one sentence, as a transformation: `confusion -> recognition -> confidence`.
- **What the music must not do**: compete with the voice, hit every cut, explain what the picture already says.

## 2. Spot the picture

Build the spotting map from the **real timing**: `voice/timing.json` (every line and word), the animatic's cut and
beat list (`video/src/timing.ts` or its plan), and its length (ffprobe). One row per event that changes meaning:

```
time    | event                         | significance            | response
0.00    | black, first word             | establish               | pad alone, low register
8.40    | "...for the first time."      | the problem lands       | aftermath: drop out for a bar
31.20   | logo resolves                 | structural: the turn    | direct hit, tonic arrival
```

Classify each as structural, dramatic, physical or optional, and choose for each: **direct hit**, **anticipation**
(change just before), **aftermath** (let the image land, then react) or **no hit**. Hit the few that change meaning,
not every cut.

## 3. Map the tempo

Choose the BPM (and `offset_sec`, where bar 1 starts in the video) so the structural hits fall on bar lines or strong
beats: `seconds per bar = beats_per_bar × 60 / BPM`. Test tempos, don't force awkward bars:

```js
// candidate tempos, scored by how far each hit lands from its nearest beat
for (let bpm = 70; bpm <= 140; bpm += 0.5) { const beat = 60 / bpm; const err = hits.map((t) => Math.abs(((t - off) / beat) - Math.round((t - off) / beat)) * beat); /* keep the smallest max(err) */ }
```

A minor event may sit between beats. If one tempo can't serve the structural hits, move `offset_sec`, or use a
pickup, a held bar or a section of a different length inside the music, never a tempo that drifts.

## 4. The blueprint: `music/blueprint.json`

```json
{
  "title": "a real title", "bpm": 96, "meter": "4/4", "bars": 48, "scale": "D:dorian", "offset_sec": 0.6,
  "dramatic_reading": "confusion -> recognition -> confidence",
  "motif": { "rhythm": "...", "contour": "...", "length_bars": 2, "role": "Glass hook", "returns": ["bar 17, an octave up", "bar 41, augmented"] },
  "sections": [
    { "name": "The quote that comes back", "start_bar": 1, "end_bar": 8, "function": "establish: pad and sub only, the motif withheld", "intensity": 2, "picture": "the $5,400 price counts up" }
  ],
  "hits": [ { "t_sec": 31.2, "bar": 13, "beat": 1, "kind": "direct", "what": "logo resolves" } ],
  "chart": [ { "bars": [1, 8], "chords": ["Dm9", "Cmaj7", ["Gm7", "A7sus4"], "Dm9"] } ],
  "roles": [ { "channel": 1, "harmony": "bass", "name": "Sub", "job": "roots, the floor", "sound": "sine, low-passed" } ],
  "ending": "how it ends and why (a held chord under the end card, or a question left unresolved)"
}
```

Decide in this order: the motif and hook (melody craft) → tempo, meter and scale → the chart → the roles → the story.

- **Sections** cover bars 1..bars, contiguous. Names are specific and story-bearing, never "Intro/Verse/Chorus/A/B"
  (a returning idea is "Return of …"). Each `function` says what happens: establish, develop, destabilise,
  withhold, release, reinterpret, resolve, and what rises or is held back.
- **`intensity` (0-10) is the picture's energy curve**, section by section: the check measures each section
  (parts playing, notes per beat, velocity, range) and fails if the order disagrees. Builds really build;
  breakdowns really thin out. Don't raise everything at once: contrast makes intensity legible.
- **Under speech**, keep the speech-critical register (roughly 300 Hz–3 kHz) clear: simpler lines, sustained
  material, rests. The music opens up in the gaps between lines and after the last word.
- **The chart** is built from the scale's own chords; borrowed colours where they serve the story. Vary the harmony
  across sections, and slow the harmonic rhythm to suspend time, speed it up to drive.
- **Roles**: 3 to 10, each on its own channel 1–16 (drums on 10), with a vivid name and a job in the story.

## 5. The score: `music/score.strudel.js`

```js
setcpm(96 / 4)                                      // BPM / beats per bar: one cycle is one bar
const BARS = 48
const cue = (p) => p.filterWhen((t) => t < BARS)    // every part ends with the cue (Strudel loops otherwise)
const lift = "<0!12 1!20 0!4 1!12>"                  // a section mask, one value per bar: off 1-12, on 13-32, off 33-36, on 37-48

sub:   cue(note("<d2 c2 [g1 a1] d2>").s("sine").lpf(300).velocity(.8).gain(.7)).midichan(1)
pad:   cue(note("<[d3,f3,a3,c4,e4] ...>").s("triangle").attack(.4).release(1.2).room(.4).velocity(.6).gain(.3)).midichan(2)
hook:  cue(note("<[a4 ~ c5 d5] ...>").s("square").lpf(2200).delay(.25).velocity("<.7 .85>").gain(.18).mask(lift)).midichan(3)
drums: cue(stack(
         note("36 ~ ~ 36 ~ ~ 36 ~").s("sine").decay(.18).sustain(0),
         note("~ 38").s("pink").decay(.12).sustain(0).gain(.35),
         note("42*8").s("white").decay(.03).sustain(0).gain(.15).velocity("<.5 .8>*4")
       ).mask(lift)).midichan(10)
```

- **Every part** is a labelled block, wrapped in `cue(…)`, with `.midichan(n)` = its role's channel.
- **Drums** on channel 10 carry General MIDI numbers as their note (36 kick, 38 snare, 42 closed hat, 46 open hat,
  49 crash): the MIDI pack maps them straight into any drum rack, and noise sounds ignore the pitch.
- **`.velocity()` is the playing dynamic** (it goes to the MIDI); **`.gain()` is the mix level** (it doesn't).
- **Sections** are masks or `<…>` sequences with one value per bar, aligned to the blueprint's bars; `arrange()`
  works too. Name each mask after its section.
- **Sounds**: Strudel's built-in synths need no downloads and carry no licence questions: `sine`, `triangle`,
  `square`, `sawtooth`, `supersaw`, `white`/`pink`/`brown` noise, FM (`.fm()`, `.fmh()`), with filters
  (`lpf`, `hpf`, `lpenv`), envelopes (`attack`, `decay`, `sustain`, `release`), `room`, `delay`, `pan`, `shape`.
  Use samples (`samples(…)`) only from a source whose licence allows the owner's use, and record it in
  `assets/SOURCES.md`.

## 6. Check, then look at what you can't hear

```
node $M check --video-sec <animatic length> --fps <fps>
```

It reports the harmony lock, every hit's distance from its frame, parts that play past the end, roles that never
play, and **the intensity curve**: a sparkline per section, asked vs measured. Iterate until **0 problems**. Then
read the curve against the picture: does it rise where the video rises, does it hold back under the busiest
narration?

You can't hear the render. After `render`, look at it: `ffmpeg -i out/music/score.wav -lavfi
showspectrumpic=s=1600x400 music/spectrum.png` (each section's density and register should be visible where the
blueprint put them), and measure loudness (`ebur128`). Say in the note that these are measurements, not listening.

## 7. Mix it under the voice

The cue starts at `offset_sec`. Duck it under the speech and finish at the delivery loudness:

```
ffmpeg -i voice/voice.wav -i out/music/score.wav -filter_complex \
 "[0:a]asplit=2[v1][v2];[1:a]adelay=600|600,volume=-4dB[m];[m][v1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=450[duck];\
  [v2][duck]amix=inputs=2:normalize=0[mix];[mix]loudnorm=I=-14:TP=-1.5:LRA=11" -ar 48000 audio/mix.wav
```

(`adelay` is `offset_sec` in milliseconds.) Music sits about 18 dB under the voice while it speaks and comes up in
the gaps. Sound effects go on top, sparingly: when an effect already lands an impact, the music prepares or answers
it instead of doubling it.

## 8. Submit the music step

Items: **the animatic with the cue mixed in** (video: the owner judges the music against the picture), the score
alone (`out/music/score.wav`), and the cue sheet (`node $M midi` writes `out/music/midi/CUE-SHEET.md`; submit its
text even when no MIDI pack was asked for). The note: the dramatic reading, the hits and how each is played, and the
intensity sparklines from the check. At most one question, with a default.

Notes on the music come back as times in the video: the bar is `floor((t - offset_sec) / seconds_per_bar) + 1`.
Change the blueprint first when the note is about the story, then the score; run the check again.

## 9. The MIDI pack

When `$MFX_MUSIC` has `"midi": true`, the final delivery also carries `out/music/midi/` (every part on its channel,
the whole arrangement, tempo, meter, section and hit markers, `CUE-SHEET.md`) and the stems (`render --stems`), so
the owner can remake the music in their own DAW. Strudel's render is still the one in the video.
