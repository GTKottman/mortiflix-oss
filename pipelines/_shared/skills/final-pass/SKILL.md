---
name: final-pass
description: Check a rendered video before anyone else sees it: format, black or frozen frames, loudness, true peak, and a frame sheet to look at. Use before submitting any animatic or final, and before `mfx step done` on a build.
---

# Final pass

Two halves, both required: the script checks what a machine can, and you look at what it can't.

## 1. Run the checks

```
node .claude/skills/final-pass/qc.mjs out/final.mp4 --size 1920x1080 --fps 30 --duration 60
```

- `--size`, `--fps`, `--duration` come from the brief (shape, length). Duration passes within 5%.
- Loudness: `--lufs -14` (web default) and `--true-peak -1`. Change them only if the brief names a platform with
  other targets.
- `--end-hold` when the video is meant to end on a still hold (a logo that settles): that stretch then passes and
  its length is reported. A frozen stretch anywhere else still fails.
- `--allow-black` only when black mid-video is designed (a dip to black between chapters). Say so in the check note.
- It writes `checks/qc-<name>.json` and `checks/<name>-sheet.png`, and exits 1 on any FAIL.

Fix every FAIL and run it again. A frozen stretch can be a designed hold: then it's a pass, and the check's note says
which hold it is.

## 2. Look

1. **The frame sheet.** View `checks/<name>-sheet.png` (about a frame a second). Every frame must make visual sense:
   nothing half-loaded, no placeholder text, no element stuck at a wrong position, nothing cut off at an edge.
2. **Three full-size frames** at the busiest moments: `ffmpeg -ss 12.5 -i out/final.mp4 -frames:v 1 checks/f-12.5.png`.
   Read every word on them.
3. **Listen** through once on the waveform's loudest and quietest parts: no clicks, pops, distortion, or words
   swallowed by the music.

## 3. Report

Map the results onto the step's error checks (`mfx checks <step>`): `frame-sheet` and `format` from the script plus
your look, `loudness` from the audio lines. Keep the JSON and the sheet in `checks/`. Submit the frame sheet as a
second item with every final: the owner can scan it in a second.

## Fixing loudness

Two-pass loudnorm on the mix, never on a file you've already normalized:

```
ffmpeg -i mix.wav -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null -       # read the measured values
ffmpeg -i mix.wav -af loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true mix-14.wav
```
