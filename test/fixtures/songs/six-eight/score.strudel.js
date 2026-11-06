setcpm(72 / 3)
const BARS = 6
const cue = (p) => p.filterWhen((t) => t < BARS)
lead: cue(note("<[d4 f4 a4 g4 f4 e4] [c4 e4 g4 f4 e4 d4] [d4 ~ a4 ~ f4 ~]>")).velocity(.75).midichan(1)
bass: cue(note("<d2 c2 [d2 a1]>").legato(.9)).midichan(2)
