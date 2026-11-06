setcpm(96 / 4)
const BARS = 8
const cue = (p) => p.filterWhen((t) => t < BARS)
bass: cue(note("<[d2 ~ d2 f2] [c2 ~ c2 e2] [g1 ~ g1 a1] [d2 d2 f2 a2]>")).velocity("[.8 .6]*2").midichan(2)
keys: cue(chord("<Dm7 Am7 Gm7 Dm7>").voicing().struct("~ x ~ x")).velocity(.7).midichan(3)
drums: cue(stack(s("bd*4"), s("~ sd ~ sd"), note("[42 42 42 46]*2").velocity(.5))).midichan(10)
