# Music

After you approve the animatic, the studio scores it: original music written in [Strudel](https://strudel.cc)
(AGPL-3.0), to the video's own timing. You review it against the picture, like every other step. Turn it on or off,
and ask for a MIDI pack, in `mortiflix setup music`; a project's brief can also say "No music".

The writing method comes from Mortiflix's song system (Mini Music): a story first, then the notes, and a machine that
checks the result before you hear it.

## How a cue is written

1. **The dramatic reading.** One sentence, as a change: `confusion -> recognition -> confidence`.
2. **The spotting map**, from the approved animatic's real timing (every word of the narration, every cut): what
   happens when, and for each moment that changes meaning whether the music hits it directly, anticipates it,
   reacts after it, or deliberately lets it pass.
3. **The tempo map.** A tempo and a start point chosen so the structural hits land on bar lines, not forced.
4. **The blueprint** (`music/blueprint.json`): the motif, the chord chart, the parts (each with a role in the
   story), and the sections, each with a function (establish, develop, withhold, release, resolve…) and an
   **intensity** from 0 to 10 that follows the picture's energy: where it should get complex, where it should thin
   out under busy narration, where it builds faster or slower.
5. **The score** (`music/score.strudel.js`), one labelled part per role, written from the melody craft, the harmony
   lock and the rich-voicing guides in the skill.
6. **The check** (`strudel.mjs check`), which must end with 0 problems:
   - **harmony lock**: every note against the chord of the moment, by its part's role (bass, chords, melody, pedal);
   - **hit points**: each one within a frame of its moment in the video;
   - **the intensity curve**: each section measured (parts playing, notes per beat, velocity, range) and compared with
     what the blueprint asked, so builds really build and breakdowns really thin out;
   - nothing playing past the end, every part playing, the tempo as planned.
7. **The render**, by Strudel itself in a headless Chrome (its offline renderer, the same as the REPL's Export), then
   the mix: about 18 dB under the voice while it speaks, ducked by the narration, to the delivery loudness.

You review the animatic with the cue mixed in, the score alone, and the cue sheet.

## Sounds

Scores use Strudel's built-in synths (sine, triangle, square, sawtooth, supersaw, noise, FM, with filters, envelopes,
reverb and delay): nothing to download and no licence questions. Samples are used only from a source whose licence
allows your use, and recorded in the project's `assets/SOURCES.md`.

## The MIDI pack

With the MIDI pack on, each video also delivers `out/music/midi/`: every part on its own channel (drums on 10 with
General MIDI numbers), the whole arrangement in one file, tempo, meter, section names and hit points as markers, the
stems as audio, and `CUE-SHEET.md`. Drop it into any DAW to remake or extend the music.

## Writing a score by hand

The tool works on any folder with a `music/blueprint.json` and `music/score.strudel.js`:

```sh
export MFX_STRUDEL=~/Mortiflix/tools/strudel MFX_CHROME=$(command -v google-chrome-stable)
node pipelines/_shared/skills/music/strudel.mjs check --video-sec 60
node pipelines/_shared/skills/music/strudel.mjs render --stems
node pipelines/_shared/skills/music/strudel.mjs midi
```

The format and the method are in `pipelines/_shared/skills/music/SKILL.md` and its `craft/` guides.
