---
name: voiceover
description: Narration for a video: lines from the approved script, voice clips, word timings, and one voice track with a timing map the animation follows. Use for any narrated animatic or final.
---

# Voiceover

The approved script is spoken **word for word**. Narration is the clock the animation is timed to.

## 0. Is there a voice?

`node .claude/skills/voiceover/vo.mjs check`

- **ElevenLabs** (`ELEVENLABS_API_KEY`, optional `ELEVENLABS_VOICE_ID`, in the studio's `session.env`): the default path below.
- **No voice service:** don't invent one. If the brief asked for narration, ask at the next gate (or `mfx ask`)
  whether to go on-screen-text-only or wait for a key, with on-screen text as the default. Never ship a robotic
  system voice as the final narration.
- **The owner's own recording** in `input/`: use it, cut into lines, and skip `speak`.

## 1. Lines

Split the approved script into `voice/lines.json`, one line per sentence or breath:

```json
[{ "id": "b01-1", "text": "Every city has a heartbeat.", "gap_after": 0.5 }, { "id": "b01-2", "text": "Ours runs on bikes." }]
```

Ids follow the script's beats (`b01-1`). `gap_after` is the pause after a line (default 0.4 s; longer between beats).
Write numbers, units and names the way they should be *said* ("twenty twenty-six", "four point five percent").

## 2. Clips

```
node .claude/skills/voiceover/vo.mjs speak voice/lines.json --voice <voice id>
```

Listen to the first two clips before making the rest: pace, pronunciation, tone. One voice for the whole video:
never switch silently. Remake a single bad line with `--force` after editing just that line (or delete its clip).

## 3. Timing

```
node .claude/skills/voiceover/vo.mjs time voice/lines.json    # word timings from speech-to-text
node .claude/skills/voiceover/vo.mjs build voice/lines.json   # voice/voice.wav + voice/timing.json
```

- `time` warns when what it heard differs from the line: a skipped or misread word. Remake that line.
- `voice/timing.json` has every line's and word's start and end in the finished track. Turn the ones you animate
  to into frames (`Math.round(seconds * fps)`) in `video/src/timing.ts`.
- Copy `voice/voice.wav` into `video/public/` for the render.

## 4. Mix

Music about 18 dB under the voice while it speaks. The final mix: -14 LUFS, true peak ≤ -1 dBTP (final-pass skill).
