setcpm(110 / 4)
const BARS = 9
const cue = (p) => p.filterWhen((t) => t < BARS)
// a pad whose chords ring across the section ends (2-bar notes, the last one longer still)
pad: cue(note("<[d3,f3,a3] [c3,e3,g3] [a2,c3,e3]>").slow(2).legato("<1 1 1 1.6>")).velocity(.6).midichan(4)
// a 17-tuplet run: off the 960 grid, rounded
run: cue(note("<~ ~ [c5 d5 e5 f5 g5 a5 b5 c6 b5 a5 g5 f5 e5 d5 c5 b4 a4] ~>")).velocity("<.5 .9>").midichan(5)
