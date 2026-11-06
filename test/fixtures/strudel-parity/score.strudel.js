// Node ⇄ Chrome parity fixture (doc 28 M1): every feature the evaluator must read the way the Strudel REPL does.
setcpm(96 / 4)
const BARS = 4
const cue = (p) => p.filterWhen((t) => t < BARS)
const bars = (list) => '<' + list.join(' ') + '>'          // a JS string, read as mini-notation
const riff = 'd2 ~ d2 f2'

// bass: labelled block, single-quoted strings, a helper-built string, velocity pattern
bass: cue(note(bars(['[' + riff + ']', '[c2 ~ c2 e2]', '[g1 ~ g1 a1]', '[d2 d2 f2 a2]']))).velocity("[.8 .6]*2").midichan(2)
// keys: scale steps, chord voicing arpeggio, legato
$: cue(n("0 2 4 <6 7>").scale("D3:dorian").legato(0.5)).midichan(3)
$: cue(chord("<Dm7 Am7>").voicing().arp("0 1 2 1")).velocity(.7).midichan(4)
// drums: sample names mapped to General MIDI, and GM numbers
drums: cue(stack(s("bd ~ bd ~"), s("~ sd"), note("[42 42 42 46]*2"))).midichan(10)
// muted block: plays nothing
_$: note("c5*8").midichan(5)
// drawing calls do nothing outside the browser
$: cue(note("<a3 c4>").slow(2)).midichan(6).pianoroll()
