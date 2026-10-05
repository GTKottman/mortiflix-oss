# Narration, sound effects and music

Mortiflix can narrate your videos three ways. Pick one in **Settings › Narration** (web) or with `mortiflix voice`.

| | ElevenLabs | This computer (Qwen3-TTS) | No narration |
|---|---|---|---|
| Sound | the most natural voices; 90+ languages on Eleven v4 | very good; 10 languages | on-screen text and music carry it |
| Cost | per character, on your ElevenLabs plan | free (your electricity) | free |
| Privacy | text goes to ElevenLabs | nothing leaves your machine | nothing to send |
| Needs | an API key from elevenlabs.io | an NVIDIA GPU with 4 GB+ (8 GB+ for the 1.7B voice), ComfyUI, the TTS Audio Suite | nothing |
| Voices | thousands (yours, the defaults, the Voice Library, your own clones) | 9 built into the model | |
| Also | sound effects and music beds | | |

Whichever you choose, every line is checked by speech to text after it's made: a take with missing or extra words
is made again, and the timings of every word go to the animation.

## ElevenLabs

1. Get an API key: elevenlabs.io › Developers › API keys.
2. Settings › Narration › ElevenLabs, paste it, **Connect**. You'll see your plan, credits left, when they reset,
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

## This computer: Qwen3-TTS through ComfyUI

[Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) is an open model (Apache-2.0). Mortiflix
runs it through [ComfyUI](https://www.comfy.org/) and the [TTS Audio Suite](https://github.com/diodiogod/TTS-Audio-Suite)
custom nodes, on your graphics card. Settings checks your GPU and only recommends it when it fits:

| Your GPU memory | What you get |
|---|---|
| 8 GB or more | **CustomVoice 1.7B**: preset voices plus a delivery instruction ("a calm, warm narrator, unhurried") |
| 4–8 GB | **CustomVoice 0.6B**: preset voices, no instruction |
| less | not offered |

Measured on an RTX 3080 (10 GB): the 1.7B voice needs about 6.5 GB free while it speaks, and the listening check
(Qwen3-ASR 1.7B) about 6 GB. They take turns: Mortiflix speaks every line, frees the GPU, then listens to every
line. It only asks ComfyUI to free memory when nothing else is queued there, so your other ComfyUI work is never
interrupted.

### Setting it up

1. Install ComfyUI ([comfy.org/download](https://www.comfy.org/download)) and start it (`http://127.0.0.1:8188`).
2. In ComfyUI Manager, install **TTS Audio Suite** (or clone it into `custom_nodes/` and run its `install.py`).
3. Restart ComfyUI, then **Settings › Narration › This computer › Check** (or `mortiflix voice local`).
   The models download from Hugging Face on first use (about 4 GB for 1.7B).

### The options

- **Voice:** Ryan, Aiden (English); Vivian, Serena, Uncle_Fu, Dylan, Eric (Chinese, two with regional dialects);
  Ono_Anna (Japanese); Sohee (Korean). Each can speak all 10 languages; that's its native one. They're built into the
  model, so there's no cloning and no consent question.
- **Language:** English, Chinese, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian.
- **Delivery** (1.7B only): the instruction, in plain words. Inline tags aren't read.
- **Runtime:** the suite's own setting. Try Main Environment first; if ComfyUI reports a transformers version
  error, its Shared Runtime isolates the model.
- **Checks:** listen back to every line with Qwen3-ASR (retakes and word timings).

The options shown come from the nodes you have installed, so a newer suite with other models or voices still works.

## No narration

Videos are made with on-screen text, music and sound. If a brief asks for a voice anyway, the session asks you at
the next review whether to continue without one.
