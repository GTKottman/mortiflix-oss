---
name: music
description: The music engine, for a song or a video's score. Strudel writes the notes, every part on its own MIDI channel; the engine checks them (harmony lock, the story's intensity curve, hits on the picture), captures them as MIDI, then an instrument is chosen for every channel from its real notes and auditioned, and the piece is rendered and mastered, or finished by the owner in their own DAW from the MIDI pack. Use for any music step, a song, or a change to music.
---

# Music

One engine makes all of Mortiflix's music, a song or a video's score. It works in stages; each stage writes a file,
the engine checks it, and nothing moves on until the check passes. **The notes and the sounds are separate**: the
score is only music (notes on channels), its MIDI is captured, and only then is an instrument chosen for every channel.
So the same MIDI can be played by Strudel or taken into any DAW.

```
genre ─▶ blueprint ─▶ score ─▶ MIDI ─▶ instruments ─▶ audition ─▶ master
(songs)    the plan    notes    every     a sound per     each sound     Strudel's render, mastered
                       only     channel   channel, from   across its     ─ or ─
                                          its real notes  range          the owner's own, from the MIDI pack
```

| Stage | You write | The engine (`node $M <command>`) | It writes |
|---|---|---|---|
| Genre (songs) | `music/genre.json` | `genre`: every field, 5+ sources, hook and beat elements | `music/GENRE.md` |
| Blueprint | `music/blueprint.json` | `plan`: sections, chart, roles/channels, genre signature, length | `music/BLUEPRINT.md` |
| Score | `music/score.strudel.js` | `check`: harmony lock, intensity curve, hits, nothing past the end | `music/check.json` |
| MIDI | (nothing: it's captured) | `check`, once it passes | `music/notes.json`, `out/music/midi/` |
| Instruments | `music/instruments.json` | `instruments`: every channel, register clashes, palette rules | `music/instruments-check.json` |
| Audition | (nothing) | `audition`: lowest, middle, highest note of every part | `out/music/audition/*.wav` |
| Master | (nothing) | `master` (songs) or `render` (a video's stand-in) | `out/music/master.wav`, `.mp3`, `stems/` |
| Owner's master | (the owner imports it) | `own-master`: is it there, does it fit | `music/own-master/` |

After every command the engine rewrites **`music/MUSIC-SHEET.md`**: every channel with its range, instrument, level,
audition result and why, the story measured against the plan, the master's numbers. It's how the owner (and the next
session) sees exactly how the music was made. `node $M sheet` rewrites it on demand.

```
M=.claude/skills/music/strudel.mjs
```

Read `craft/genre-research.md` before a genre, `craft/picture-scoring.md` before a video's first blueprint,
`craft/melody-craft.md` before writing the motif, `craft/harmony-lock.md` before the score, and
`craft/rich-voicing.md` once the lock passes.

## 0. What the owner set up

`$MFX_MUSIC` is `{"engine": "strudel" | "none", "midi": true | false}`. Strudel is at `$MFX_STRUDEL`, and renders in
the Chrome at `$MFX_CHROME`. If either is missing: `mfx needs-you "Music isn't set up: run mortiflix setup music,
then resume."` Never improvise music any other way, and never use another engine.

**Who finishes the music** comes from the brief (the `music` or `finish` answer):
- **"…I'll finish it from the MIDI"** (recommended for videos): the studio writes and checks the score, chooses
  stand-in instruments so it can be reviewed against the picture, and hands over the MIDI pack; the owner makes the
  final sound in their own DAW and imports the master (section 9).
- **"…rendered by Strudel"**: the studio finishes it: instruments, audition, render, mix.

## 1. The genre (songs)

Research the genre into `music/genre.json` (the format and the method: `craft/genre-research.md`), then
`node $M genre` until it passes. A song is written **from** its genre: its tempo range, lineup, beat grids, harmony,
hook traits and, above all, its unforgettable elements.

## 2. Read the drama

Write in `music/SPOTTING.md` (videos) or at the top of the blueprint (songs):

- **The dramatic reading** in one sentence, as a transformation: `confusion -> recognition -> confidence`. For a song,
  it's the topic translated into audible behaviour: what the listener feels change from the first bar to the last.
- **What the music must not do**: compete with the voice, hit every cut, explain what the picture already says
  (videos); copy a reference, pile up unrelated ideas, stay at one level (songs).

## 3. Spot the picture (videos)

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

### Map the tempo

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
  "style": "songs: one dense line of descriptors, under 1000 characters: genre, instruments and their roles, groove, mood",
  "genre_signature": [ { "id": "dusty-breakbeat", "carries": "beat", "how": "half-time break, ghosted snares", "where": "from bar 9" } ],
  "motif": { "rhythm": "...", "contour": "...", "length_bars": 2, "role": "Glass hook", "returns": ["bar 17, an octave up", "bar 41, augmented"] },
  "sections": [
    { "name": "The quote that comes back", "start_bar": 1, "end_bar": 8, "function": "establish: pad and sub only, the motif withheld", "intensity": 2, "picture": "the $5,400 price counts up" }
  ],
  "hits": [ { "t_sec": 31.2, "bar": 13, "beat": 1, "kind": "direct", "what": "logo resolves" } ],
  "chart": [ { "bars": [1, 8], "chords": ["Dm9", "Cmaj7", ["Gm7", "A7sus4"], "Dm9"] } ],
  "roles": [ { "channel": 1, "harmony": "bass", "name": "Sub", "job": "roots, the floor", "instrument_idea": "sine, low-passed" } ],
  "ending": "how it ends and why (a held chord under the end card, or a question left unresolved)"
}
```

Videos use `offset_sec`, `hits` and `picture`; songs use `style` and `genre_signature` (and leave the others out).

Decide in this order: the motif and hook (melody craft) → tempo, meter and scale → the chart → the roles → the story.

- **Sections** cover bars 1..bars, contiguous. Names are specific and story-bearing, never "Intro/Verse/Chorus/A/B"
  (a returning idea is "Return of …"). Each `function` says what happens: establish, develop, destabilise,
  withhold, release, reinterpret, resolve, and what rises or is held back.
- **`intensity` (0-10) is the energy curve**, section by section (a video's follows the picture): the check measures
  each section (parts playing, notes per beat, velocity, range) and fails if the order disagrees. Builds really build;
  breakdowns really thin out. Don't raise everything at once: contrast makes intensity legible.
- **Under speech**, keep the speech-critical register (roughly 300 Hz–3 kHz) clear: simpler lines, sustained
  material, rests. The music opens up in the gaps between lines and after the last word.
- **The chart** is built from the scale's own chords; borrowed colours where they serve the story. Vary the harmony
  across sections, and slow the harmonic rhythm to suspend time, speed it up to drive.
- **Roles**: 3 to 10, each on **its own MIDI channel** 1–16 (drums on 10), with a vivid name, a job in the story, and
  an `instrument_idea` (the instruments stage chooses the real sound).
- **Songs**: the `genre_signature` names which of the genre's unforgettable elements carry the hook and the beat; the
  length comes from the genre's `length` unless the brief fixed it (then `"length_fixed": true`).

`node $M plan` checks it and writes `music/BLUEPRINT.md`, the readable version (it's what the owner reviews for a song).

## 5. The score: `music/score.strudel.js`, notes only

```js
setcpm(96 / 4)                                      // BPM / beats per bar: one cycle is one bar
const BARS = 48
const cue = (p) => p.filterWhen((t) => t < BARS)    // every part ends with the piece (Strudel loops otherwise)
const lift = "<0!12 1!20 0!4 1!12>"                  // a section mask, one value per bar: off 1-12, on 13-32, off 33-36, on 37-48

sub:   cue(note("<d2 c2 [g1 a1] d2>").velocity(.8)).midichan(1)
pad:   cue(note("<[d3,f3,a3,c4,e4] ...>").velocity(.6)).midichan(2)
hook:  cue(note("<[a4 ~ c5 d5] ...>").velocity("<.7 .85>").mask(lift)).midichan(3)
drums: cue(note("[36 ~ ~ 36 38 ~ 36 ~], [42*8]").velocity("<.8 .95>").mask(lift)).midichan(10)
```

- **Every part** is a labelled block, wrapped in `cue(…)`, with `.midichan(n)` = its role's channel.
- **Only music goes in the score**: pitches, rhythm, `.velocity()` (the playing dynamic: it goes into the MIDI),
  structure (masks, `<…>` sequences, `arrange()`). No `.s()`, filters, effects or `.gain()`: those belong to the
  instruments, and the engine warns when the score sets them.
- **Drums** on channel 10 are General MIDI numbers (36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash, 39 clap,
  45 tom): the instruments stage gives each number a sound, and the MIDI pack maps them straight into any drum rack.
- **Sections** are masks or `<…>` sequences with one value per bar, aligned to the blueprint's bars. Name each mask
  after its section.

## 6. Check it, and capture the MIDI

```
node $M check [--video-sec <animatic length> --fps <fps>]
```

It reports the harmony lock, every hit's distance from its frame, parts that play past the end, roles that never
play, and **the intensity curve**: a sparkline per section, asked vs measured. Iterate until **0 problems**. Then read
the curve against the story: does it rise where it should, does it hold back under the busiest narration?

When it passes, the score's notes become **the MIDI**: `music/notes.json` (every channel's notes in beats, with
velocity) and `out/music/midi/` (one `.mid` per channel, the whole arrangement in one file, tempo, meter, section names
and hit points as markers, and `CUE-SHEET.md`). From here on the MIDI is the music: the instruments are chosen from it,
and the owner can take it into any DAW. The check also prints where each channel plays (lowest, middle, highest note).

## 7. Instruments: a sound for every channel

`node $M instruments` lists each channel's range from the MIDI and the built-in sounds. Write `music/instruments.json`:

```json
{
  "concept": "the sound of the whole piece in two sentences",
  "parts": [
    { "channel": 1, "role": "Sub", "sound": "sine", "set": ".lpf(300).release(.3)", "gain": 0.8, "pan": 0, "character": "dark", "why": "a pure floor under everything" },
    { "channel": 3, "role": "Glass hook", "sound": "sine", "set": ".fm(3).fmh(3.5).decay(.4).sustain(.2).delay(.25)", "gain": 0.3, "pan": 0.35, "character": "bright", "why": "glass, for the lamp" },
    { "channel": 10, "role": "Drums", "gain": 0.9, "why": "dry and close",
      "kit": { "36": { "sound": "sine", "set": ".penv(24).decay(.2).sustain(0)" },
               "38": { "sound": "pink", "set": ".decay(.12).sustain(0)", "gain": 0.5 },
               "42": { "sound": "white", "set": ".hpf(7000).decay(.03).sustain(0)", "gain": 0.25 } } }
  ]
}
```

- `sound`: Strudel's built-in synths need no downloads and carry no licence questions: `sine`, `triangle`, `square`,
  `sawtooth`, `supersaw`, `pulse`, and `white`/`pink`/`brown`/`crackle` noise. A sample or soundfont needs `"source"`
  (where it comes from and its licence, also in `assets/SOURCES.md`), and only when the licence allows the owner's use.
- `set`: the sound's shaping, as Strudel methods: filters (`.lpf .hpf .lpq .lpenv`), envelopes (`.attack .decay
  .sustain .release`), FM (`.fm .fmh`), `.vib`, `.penv` (pitch envelope, for drums), `.shape .distort`, `.crush
  .coarse` (lo-fi), `.room .size`, `.delay .delaytime .delayfeedback`. It can't change notes, timing or the channel.
- `gain` is the part's level in the mix (velocity from the score still shapes every note); `pan` runs -1 to 1; each
  channel gets its own effects bus, so one part's reverb never smears another's.
- `character`: `dark`, `warm`, `neutral`, `bright` or `lofi`; `why`: what the sound does for the part.

Choose for **this** genre and **this** piece, as a palette that sounds good **together**, not just good alone. The
check enforces what it can:
- parts that share a register must have clearly different timbres (different families: sine, saw, FM, noise…);
- at most one deliberately degraded (`lofi`) sound;
- the low end and the top both covered; never three bright parts playing at once;
- every channel that plays has an instrument, and every drum number the score uses has a kit sound.

And what it can't: every song should sound different from the last (read `TASTE.md` and earlier projects' palettes);
don't reach for the same sound everywhere; a held pad wants a slow attack, a pluck a fast decay.

Then **`node $M audition`**: every instrument plays its part's lowest, middle and highest note (every kit piece for
drums), one per bar, into `out/music/audition/`. A silent or clipping sound fails here in seconds, not in the final
mix. Fix and audition again until it passes.

## 8. Render and master

- **A song**: `node $M master` renders the score with its instruments (`out/music/mix.wav`), renders every channel's
  stem (`out/music/stems/`), checks no part is silent or clipping alone, measures the mix's balance (low end, mud,
  width), and masters to -14 LUFS with the true peak at or below -1 dBTP: `out/music/master.wav` and `.mp3`. Act on
  its balance notes (they come from measurements: a muddy mix, a thin low end, a narrow image) by changing
  `instruments.json` (levels, pans, filters), then master again.
- **A video's stand-in**: `node $M render [--stems]` writes `out/music/score.wav` with the instruments, for the
  review against the picture.

You can't hear the render. Look at it: `ffmpeg -i out/music/master.wav -lavfi showspectrumpic=s=1600x400
music/spectrum.png` (each section's density and register should be visible where the blueprint put them). Say in the
note that these are measurements, not listening.

### Mixing a video's music under the voice

The music starts at `offset_sec`. Duck it under the speech and finish at the delivery loudness:

```
ffmpeg -i voice/voice.wav -i <the music> -filter_complex \
 "[0:a]asplit=2[v1][v2];[1:a]adelay=600|600,volume=-4dB[m];[m][v1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=450[duck];\
  [v2][duck]amix=inputs=2:normalize=0[mix];[mix]loudnorm=I=-14:TP=-1.5:LRA=11" -ar 48000 audio/mix.wav
```

(`adelay` is `offset_sec` in milliseconds; `<the music>` is the owner's master when there is one, otherwise
`out/music/score.wav`.) Music sits about 18 dB under the voice while it speaks and comes up in the gaps. Sound effects
go on top, sparingly: when an effect already lands an impact, the music prepares or answers it instead of doubling it.

## 9. The owner's own master (recommended for videos)

When the brief says the owner finishes the music from the MIDI:

1. The music step goes to review as usual, with the stand-in render (sections 7–8), so the owner judges the notes and
   the timing against the picture.
2. Once it's approved, `node $M own-master`. If there is no master yet: `mfx needs-you "The score is approved. On the
   project page, Music › Download MIDI: give each channel its sound in your DAW, mix, export from bar 1 to the end,
   then Import your master (or: mortiflix music <project> --import <file>)."` Importing resumes the project.
3. When it's there, `own-master` reports how it fits: its length against the score, and whether its first sound
   arrives with the MIDI's first note (a master that starts late puts every hit late). Pass its warnings on in the next
   note. Use `music/own-master/master.wav` as the music from then on; never re-render over it.

## 10. Submitting

- **A video's music step**: the animatic with the music mixed in (video: the owner judges the music against the
  picture), the music alone, and `music/MUSIC-SHEET.md`. The note: the dramatic reading, the hits and how each is
  played, the intensity sparklines from the check, and (when the owner finishes it) that the MIDI pack is ready on the
  project page.
- **A song**: the steps are in the song pipeline's `PIPELINE.md`.

At most one question, with a default. Notes on music come back as times: the bar is
`floor((t - offset_sec) / seconds_per_bar) + 1`. Change the blueprint first when the note is about the story, then
the score; run the check again (it recaptures the MIDI), then the instruments.

## 11. The MIDI pack

The MIDI is always written (section 6). When `$MFX_MUSIC` has `"midi": true`, or the owner finishes the music
themselves, the final delivery also carries `out/music/midi/` and the stems (`render --stems`) so the owner can remake
or extend the music in their own DAW. The owner downloads it from the project page (Music › Download MIDI) or with
`mortiflix music <project> --midi pack.zip`.
