# Rich voicing

A cue where every line is one note at a time, at one velocity, repeating unchanged, sounds flat even when it's in
tune. This thickens and animates the parts **after** the harmony lock passes, and every addition must still pass
`strudel.mjs check`.

## Double notes: the default, not the exception

Use at least three of these per cue; hooks and leads always get one.

1. **Octave doubling** on hook statements and peaks: `stack(note(HOOK), note(HOOK).add(12))`.
2. **Diatonic 3rds or 6ths** under a melody (in scale degrees with `n()` and `.scale()`: `.add(-2)`, `.add(-5)`),
   checked as chord tones or tensions on beats.
3. **Chord stabs with the melody on top**: block chords whose top note *is* the melody note.
4. **Two-note bass**: an octave or fifth above on accents, an octave jump on a phrase's last 8th.
5. **Rolled chords**: stagger the notes by 32nds, or `.arp('up')` on a copy with a short span.
6. **Grace notes**: a 16th step into a chord-tone target on hook entries and turnarounds.
7. **Pedal with a moving inner voice**: hold top and bottom, move one inner voice by step.
8. **Counter-melody in the gaps**: a second line answers in the first one's rests, in its own register.
9. **Broken-chord layer**: under a held pad, a quiet arpeggio of the same chord an octave away.

## Motion: every repeat is different

- **Velocity shape** (`.velocity()`, the playing dynamic): accent downbeats and backbeats, ghost the 16ths, peak at
  phrase peaks. Each melodic part should span at least 0.25 of velocity (the check lists every part's range).
- **Turnaround bar**: the last bar of a 4- or 8-bar loop changes (a fill, a pickup, a held note, a drop-out):
  `.lastOf(4, …)`.
- **Variation per pass**: the second time a section comes round, change one element (a third above, an octave up,
  a busier rhythm, a counter-line entering).
- **Fills**: drums get a pickup every 8 bars and a bigger one every 16, unless the picture asks for stillness.
- **Register journey**: the hook climbs across the cue (first statement low, the peak an octave up and doubled),
  then comes down for the ending.
- **Swells** into section changes: a velocity or `gain` ramp across the last two bars.

Thin sections on purpose (breakdowns, held breaths before a reveal) are contrast, not flatness: the intensity curve
in the blueprint says where they go.
