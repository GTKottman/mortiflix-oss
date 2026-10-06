---
name: voiceover
description: Narration, sound effects and music beds in the voice the studio set up (ElevenLabs, Qwen3-TTS on this machine's GPU, or the owner's own voice from the recording booth): lines from the approved script, checked takes, one voice track and a word-timing map the animation follows. Use for any narrated animatic or final, a re-take, or sound design.
---

# Voiceover

The approved script is spoken **word for word**, and the narration is the clock the animation is timed to.

```
VO=.claude/skills/voiceover/vo.mjs
node $VO check                                   # which engine, voice and model; credits; the rules for this engine
node $VO speak voice/lines.json                  # every line, checked, retaken if words go missing
node $VO speak voice/lines.json --only b03-1     # just the lines you fixed
node $VO build voice/lines.json                  # voice/voice.wav + voice/timing.json
```

## 0. Which voice?

`node $VO check` says what the owner set up in Settings (you don't choose the engine or the voice):

- **`elevenlabs`**: the voice, model and settings are chosen; the key is in your environment (never print it).
  `check` shows the plan and credits. On the **free plan** the audio is non-commercial and must credit ElevenLabs:
  say so in your submission note.
- **`qwen`**: Qwen3-TTS on this machine's GPU through ComfyUI (free, local). If `check` says ComfyUI or the suite
  isn't ready, that's a `mfx needs-you`.
- **`none`**: no narration. If the brief asked for one, ask at the next gate whether to go on-screen-text-only
  (the default) or wait while the owner sets a voice up. Never use a robotic system voice.
- **`own`**: the owner narrates in their own voice. Write `voice/lines.json` exactly as below (short lines; put
  delivery notes as a `[tag]` at the start, which the owner sees as direction; skip IPA and v4 tricks, a person reads
  `script`). `node $VO speak voice/lines.json` then lists the lines still to record and prints the `mfx needs-you`
  text that sends the owner to the recording booth (the web studio, `mortiflix record`, or importing files). Send it
  and stop. When they resume, `speak` passes and `build` makes the track, timed per line. If you change a line after
  it was recorded, `speak` asks for that line again.
- **The owner's own recording** in `input/` (one long file, any engine): use it instead (cut it into lines as clips, then `build`).

Don't change the voice or the model yourself: they're the owner's choice. Suggest a change in the handoff if one
would clearly be better.

## 1. Write `voice/lines.json`

One entry per sentence or breath group (under ~600 characters; short lines are cheap to retake):

```json
[
  { "id": "b01-1", "text": "[warm, unhurried] Every city has a heartbeat.", "script": "Every city has a heartbeat.", "gap_after": 0.5 },
  { "id": "b01-2", "text": "Ours runs on \"/ˈbaɪsɪkəlz/\".", "script": "Ours runs on bicycles." }
]
```

- `text` is what the voice reads; `script` is the same words spelled normally (needed whenever `text` has tags or IPA:
  the check compares against it). `gap_after` is the pause after the line (default 0.4 s; longer between beats).
- Ids follow the script's beats (`b01-1`), letters, digits and dashes.
- **Write numbers, dates and money the way they're said** ("twenty twenty-six", "four point five percent").

### Directing ElevenLabs Eleven v4 (`eleven_v4`, the default)

- **Audio tags** in square brackets steer delivery: `[warm]`, `[measured, curious]`, `[whispers]`, `[sighs]`,
  `[excited]`, `[quick, light pace]`. One at the start of a line; another only where the mood really turns.
- **Describe the voice, not a sound.** v4 also makes sound effects, so `[rain]` or `[applause]` can come out as a
  noise. Write `[soft, hushed voice]`, not `[quiet room]`. The check flags any non-speech sound in a take.
- **Punctuation and capitals:** ellipses add pauses and weight, CAPITALS add emphasis. **No SSML**: v4 ignores
  `<break>` and `<phoneme>` (they can be read aloud).
- **Pronunciation:** IPA between slashes inside quotes, `"/ˈkoʊmæl/"`, with the normal spelling in `script`.
- v4 has **only stability and similarity** (set in Settings); there's no style or speed: direct pace with tags and
  punctuation.
- Each line is sent with its neighbours' text, so the delivery flows across lines.

Other ElevenLabs models (if the owner chose one): `eleven_multilingual_v2` has style and speed settings and takes
`<break time="1.0s" />` pauses (up to 3 s); `eleven_flash_v2` takes `<phoneme>` tags. Don't use tags v4-style on them.

### Directing Qwen3-TTS (local)

- Delivery comes from the **instruction** the owner set (1.7B model); the line is read as plain words. Tags and IPA
  are dropped before speaking (`script` is read when present), so **spell hard names the way they sound** in `script`.
- 10 languages (English, Chinese, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian).

## 2. Speak and check

`speak` makes each line, listens to it with speech to text (ElevenLabs Scribe v2, or Qwen3-ASR locally), and keeps
it when at least 92% of the words match the script with no 3-word run missing or added, and no stray sounds. A line
that fails is retaken with a new seed (up to `--max-takes`, default 3); the best take is kept either way. ElevenLabs
lines run several at once (the plan's limit minus one); local lines run speak-all, then listen-all, because the two
models take turns on the GPU.

- Results: `voice/clips/<id>.(mp3|wav)` + `<id>.json` (engine, take, seed, the transcript, word timings),
  every take in `voice/takes/`, and `voice/speak-report.json`.
- **A line that keeps failing: fix the input, don't re-roll.** Split a long sentence, spell out a number, add IPA
  (ElevenLabs) or a sounds-like spelling (local), then `speak --only` it.
- **Listen** to the first two lines before making the rest: pace, pronunciation, tone. The check catches missing
  words, not taste.

## 3. Build

`build` joins the clips with their gaps into `voice/voice.wav` (48 kHz mono) and writes `voice/timing.json`: every
line's start and end, and every word's start and end when the check measured them (`"timing": "words"`), otherwise
the line only. Turn the times you animate to into frames (`Math.round(seconds * fps)`) in `video/src/timing.ts`,
and copy `voice.wav` into `video/public/`. Never cut inside a word: cut in the silences.

## 4. Sound effects and music (ElevenLabs, when switched on)

```
node .claude/skills/voiceover/sound.mjs sfx "soft glassy whoosh, left to right" --seconds 1.2 --out sfx/whoosh.mp3
node .claude/skills/voiceover/sound.mjs sfx "low city ambience, distant traffic" --seconds 20 --loop --out sfx/city.mp3
node .claude/skills/voiceover/sound.mjs music "warm minimal synth bed, 90 bpm, hopeful" --seconds 45 --out music/bed.mp3
```

Sound effects: 0.5–30 s, `--loop` for seamless ambience, `--influence` 0–1 (how literally it follows the prompt).
Music: instrumental unless `--vocals`, 3 s to 10 min. Note every prompt in `assets/SOURCES.md`.

## 5. Mix

Music about 18 dB under the voice while it speaks; it can come up in the gaps. The final mix: -14 LUFS, true peak
≤ -1 dBTP (final-pass skill).

## 6. Record

Write `voice/VOICE.md`: engine, voice, model, settings, tags used, pronunciation fixes, rejected takes and why.
