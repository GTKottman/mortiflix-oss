# The harmony lock

A cue with eight pitched parts sounds out of tune when each part is written "in the key" but not in **the chord of the
moment**. The key doesn't make parts agree; the chord does. This locks every part to one chord chart, and
`strudel.mjs check` proves it: a cue goes to the owner only with **0 harmony problems**.

## One chart, everything derived from it

1. **Write the chart before any notes** (`blueprint.json` › `chart`): one chord per bar, cycling inside each row's bar
   range; `["Gm7", "C7sus4"]` inside the list splits a bar in halves. Spell the whole chord, extensions included
   (`Fm9`, not `Fm`): the chart is the list of allowed notes.
2. **Give every part a role** (`roles[].harmony`, on its own `.midichan(n)`):
   - `bass`: owns the low end. On every chord change it plays the root (or the slash bass); between changes,
     chord tones, or a short passing note (a beat or less) that steps into the next note, never on the downbeat.
   - `chords`: pads, keys, stabs, strings beds. Chord tones of the symbol only.
   - `melody`: leads, hooks, ostinatos, arps, counter-lines, bells. Chord tones or available tensions (9; 11 over
     minor or sus; 13/6 over major and dominant) on beats; anything else short (½ beat or less), off the beat
     (or a ¼-beat grace) and resolving by step.
   - `pedal`: a held tonic or dominant; in the key.
   - `noise`, `drums`: not judged.
3. **Derive the parts in this order:**
   1. **Bass** from the roots. Want a pedal under moving chords? Write it into the chart as slash chords
      (`Dbmaj7/F`), so every chord contains it.
   2. **Chords** voiced from each symbol, voice-led from the previous one (each voice the shortest way). Adjacent
      voices at least a whole step apart; the 9th on top only where no melody lives in that register.
   3. **Melodies**: chord tones on beats; passing and neighbour notes short, off the beat, resolving by step.
   4. **Repeating figures** (ostinatos, arps, bells, hooks) are **re-spelled for each chord**: one figure per chord
      in a `<figA figB figC figD>` aligned with the chart, or built only from notes every chord in the loop shares.
      A fixed figure over a changing progression is the most common cause of "out of tune".

## Chord tokens keep parts in line

Write chord-following parts from a table, so they can't disagree with the chart:

```js
const V = { Am7: '[a3,c4,e4,g4]', Fmaj7: '[a3,c4,e4,f4]', C: '[g3,c4,e4]', G: '[g3,b3,d4]' }   // no semitone inside a voicing
pad: cue(note(`<${['Am7', 'Fmaj7', 'C', 'G'].map((c) => V[c]).join(' ')}>`).s('triangle')).midichan(2)
```

- **No semitone inside a voicing.** It rubs against anything that doubles either note.
- **Stabs use a subset of the pad's notes, in the same octave.** They double, never rub.
- **A lead sharing the pad's register avoids the pad's top note ± 1.**
- **Pedals under dominant chords step to the dominant** for that bar.

## Registers and pitch

- Give each part its own band (pad C3–G4, lead A4–E5, bells C6 up). Two parts in one band: one of them plays chord
  tones only.
- Everything at concert pitch and on the grid: no `.detune()`, no pitch envelopes (`penv`), no `.speed()` on tonal
  parts, no fractional note values, no tonal pattern stretched off the bar.
- Modulations are chart events: every part moves with them in the same bar.
- Loop lengths divide the chart cycle (a 4-chord chart: 1-, 2-, 4- or 8-bar figures), unless the figure is common-tone.

## Reading the check

| `strudel.mjs check` says | Fix |
|---|---|
| out of key and not in the chord | re-spell the note, or put the chromatic chord in the chart |
| bass misses the root on a chord change | move the bass to the root at each change; slash chords for pedals |
| chords part plays a note that is not in the chord | re-voice, or spell the extension in the chart |
| melody non-chord tone that is not a short passing/neighbour note | chord tone, shorter, or resolve by step |
| note held into a chord it does not fit | end it at the change, or choose a common tone |
| two parts clash / rub a semitone apart | re-voice one, or spread them an octave and more apart |

Fix the notes, not the chart, unless the chart itself is wrong for the story.
