# Narration, sound effects and music

Mortiflix can narrate your videos three ways. Pick one in **Settings › Narration** (web) or with `mortiflix voice`.
ElevenLabs is the default and the only voice the studio generates: there is no local voice (Qwen3-TTS and ComfyUI were
removed on 2026-11-01). Without an ElevenLabs key, Settings and the Voice stage say so plainly; nothing falls back to a
local model.

| | ElevenLabs | Your own voice | No narration |
|---|---|---|---|
| Sound | the most natural voices; 90+ languages on Eleven v4 | you | on-screen text and music carry it |
| Cost | per character, on your ElevenLabs plan | free (your time) | free |
| Privacy | text goes to ElevenLabs | nothing leaves your machine | nothing to send |
| Needs | an API key from elevenlabs.io | a microphone (and ffmpeg for the terminal booth) | nothing |
| Voices | thousands (yours, the defaults, the Voice Library, your own clones) | yours | |
| Also | sound effects and music beds | | |

Generated lines are checked by speech to text after they're made: a take with missing or extra words is made again,
and the timings of every word go to the animation. Your own recordings are timed line by line.

## Your own voice: the recording booth

Choose **Your own voice** in Settings › Narration (or `mortiflix voice own`). When a video reaches its narration, the
studio writes the script as short lines and pauses the project with a note asking you to record. Then any of:

- **In the web studio**: open the project and choose **Record narration**. Check your microphone and the room, then
  read each line: hold **Space** (or the big button) while you speak, let go to stop. It plays the take back and flags
  a take that clipped, is very quiet, or seems too short or long. Record as many takes as you like, **Enter** keeps
  the selected one and moves on, ← → move between lines. Takes save as you go, so you can stop and come back. When
  every line has a kept take, **Done** hands it to the studio. (Browsers allow the microphone on the computer the
  studio runs on, or over HTTPS.)
- **In a terminal**: `mortiflix record <project>`. **Enter** starts and stops a take, **p** plays it, **k** keeps it,
  **n**/**b** move between lines, **q** stops for now. It records with ffmpeg from the default microphone; pick another
  with `--device` (`mortiflix record --list-devices`).
- **From files you recorded elsewhere** (a DAW, a phone): name each file after its line (`b01-1.wav`, `b01-2.m4a`, …;
  the booth and `voice/lines.json` show the ids) and run `mortiflix record <project> --import <folder>`.

If the studio rewrites a line after you recorded it, that line asks for a new take.

## ElevenLabs

1. Get an API key: elevenlabs.io › Developers › API keys.
2. `mortiflix keys` (or Settings › Narration › ElevenLabs), paste it, **Connect**. You'll see your plan, credits left, when they reset,
   and whether you may use the audio commercially.
3. **Choose a voice**: your voices and the default voices, or **Browse the Voice Library** (thousands of community
   voices; "Add & use" copies one into your account). ▶ plays each voice's own preview, free.
4. Pick the model and settings, then **Try it** with a line of your own.

Everything is read from your account: the models list comes from the API, so new models appear by themselves.

### The options, and what they do

| Option | What it does |
|---|---|
| **Model** | `eleven_v4` (default and recommended: highest quality, best cloning, 90+ languages), `eleven_v4_turbo` (fast), `eleven_v3`, `eleven_multilingual_v2` (29 languages, has style and speed settings), `eleven_flash_v2_5` / `eleven_flash_v2` (fastest) |
| **Stability** | lower is more expressive and varied, higher is steadier (all models) |
| **Similarity** | how closely it sticks to the original voice (all models) |
| **Style, speed, speaker boost** | only on models that have them; Eleven v4 doesn't (it's directed with audio tags instead) |
| **Language** | an ISO 639-1 code to force the language and how numbers are read; blank detects it |
| **Text normalization** | auto, on (spell out numbers, dates, abbreviations), off (read as written) |
| **Pronunciation dictionaries** | up to 3 of your dictionaries, applied in order. Phoneme rules work on v4, v3 and Flash v2; other models use alias rules only |
| **Audio format** | MP3 128 kbps (default) up to WAV 48 kHz. 192 kbps MP3 needs the Creator plan or above, 44.1 kHz WAV/PCM needs Pro |
| **Server** | for accounts on a data-residency server (US, EU, India, Singapore) |
| **Checks** | Scribe v2 speech to text on every take (recommended), or off |
| **Sound effects** | lets sessions make effects with `eleven_text_to_sound_v2`: 0.5–30 s, loopable |
| **Music beds** | lets sessions compose with Eleven Music (`music_v2_5`): instrumental, 3 s to 10 min. Usage terms depend on your plan: [elevenlabs.io/music-terms](https://elevenlabs.io/music-terms) |

How lines are made: each one is sent with the text before and after it (so the delivery flows), a seed (so a good
take can be reproduced), and only the settings the chosen model accepts. Lines run in parallel up to your plan's limit
minus one (Free 2, Starter 3, Creator 5, Pro 10, Scale and Business 15).

### Directing Eleven v4

Sessions write delivery into the script itself: audio tags like `[warm]`, `[whispers]`, `[excited]`; CAPITALS for
emphasis; ellipses for pauses; and IPA between slashes for names (`"/ˈkoʊmæl/"`). Eleven v4 doesn't support SSML.

### Good to know

- **Free plan:** audio may be used **non-commercially only, with attribution** to ElevenLabs. Paid plans include
  commercial rights. Settings shows which you're on, and sessions say so in their notes.
- **Zero-retention mode** (no logs kept at ElevenLabs) is for Enterprise accounts only.
- **Voice clones:** only of your own voice, or with the speaker's clear consent.
- Your key stays in the studio folder (`secrets.json`, readable only by you). Sessions get it only while ElevenLabs
  is the narration engine.

## No narration

Videos are made with on-screen text, music and sound. If a brief asks for a voice anyway, the session asks you at
the next review whether to continue without one.
