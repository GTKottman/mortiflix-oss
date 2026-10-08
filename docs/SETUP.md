# Setup

`mortiflix setup` (or **Settings › Setup** in the web studio) walks through everything Mortiflix can use, says why
each part is needed and what it would install, and asks before installing anything. Every part is optional except
Claude. `mortiflix setup <part>` does one part again; `mortiflix setup status` shows where things stand.

Everything installs **into the studio folder** (`~/Mortiflix/tools/`), or as your own user tool (uv, browser-harness),
never system-wide and never as root. Deleting `tools/` removes it all.

| Part | Why | What it installs | Size |
|---|---|---|---|
| **Claude** | Claude does the work: writing, design, animation, checks | nothing (your Claude Code login), or your Anthropic API key in `secrets.json` | |
| **Transitions** | every cut is designed on the transition board, from a library of 50 | the remotion-transitions library, into `tools/remotion-transitions` | ~5 MB |
| **Narration** | a voice reads the script; the animation is timed to its words | an ElevenLabs key, **or** ComfyUI + the TTS Audio Suite (Qwen3-TTS) on your NVIDIA card, **or** nothing | ComfyUI ~10 GB with models |
| **Music** | an original score, written to the approved animatic | Strudel (`@strudel/web` from npm) and a headless Chrome (yours is reused) | ~20 MB (+~100 MB without Chrome) |
| **Assets** | stock assets from sites you already use, in your own Chrome | browser-harness (browser-use, via uv) and the list of your sites | ~60 MB |
| **3D** | 3D scenes rendered in Blender | Blender (yours is reused) and the 3D toolkits, in the studio's own Blender profile | ~350 MB + ~15 MB |

## Claude

Claude Code, logged in, is used if it's installed (your plan pays). Otherwise an Anthropic API key (you pay per
token); the key is checked with a free call and kept in `secrets.json` (mode 600). See `mortiflix keys`.

## Narration

1. **ElevenLabs**: paste a key, pick a voice and model (see [VOICE.md](VOICE.md)).
2. **This computer**: offered only when your NVIDIA card can run it (4 GB for the 0.6B voice, 8 GB for 1.7B).
   If ComfyUI with the TTS Audio Suite already answers at its address (default `127.0.0.1:8188`), it's used as is.
   Otherwise setup installs the studio's own: ComfyUI and the TTS Audio Suite cloned from GitHub into
   `tools/ComfyUI`, a Python 3.12 environment with PyTorch for CUDA (via uv), the suite's own installer, then starts
   it. The Qwen3-TTS models download on first use. Needs git; NVIDIA only.
3. **None**: on-screen text, music and sound.

## Music

Strudel 1.3 (AGPL-3.0) is installed from npm into `tools/strudel`; scores are rendered by Strudel's own offline
renderer in a headless Chrome. Your Chrome or Chromium is used if it's there; otherwise Chrome for Testing's headless
shell is downloaded into `tools/browsers`. You also choose:

- **Original score or no music.** With no music, the music step is skipped in every project.
- **A MIDI pack**: every part as MIDI on its own channel, the stems, and a cue sheet (tempo, sections, hit points),
  delivered with each video so you can remake the music in your own DAW. Strudel's render is still the one used in
  the video.

How the music step writes: [MUSIC.md](MUSIC.md).

## Assets

> If you have a website you use for assets, list it here. Without one, you won't get stock assets: sessions make
> every visual themselves.

Sessions work in **your own Chrome**, where you're signed in, through [browser-harness](https://github.com/browser-use/browser-harness)
(installed with `uv tool install browser-harness`; uv is installed for your user first if it's missing). They only
use the sites you list, download into the project, record every asset's page and licence in `assets/SOURCES.md`, and
never sign up, start trials, accept terms or pay: anything like that stops the project and asks you.

- Chrome may ask, once, to allow remote debugging: `chrome://inspect/#remote-debugging`.
- browser-harness can keep local recordings (screenshots and action traces) of what sessions did; setup asks, and
  the default is off.

## 3D

Blender is reused if you have it (4.2 or newer); otherwise the newest official build for your system is downloaded
from download.blender.org into `tools/blender`. The toolkits are installed into **the studio's own Blender profile**
(`tools/blender-profile`, set through `BLENDER_USER_RESOURCES`), started from factory settings: your personal Blender
setup is never read or changed.

| Toolkit | From | For |
|---|---|---|
| MoBlend | github.com/GTKottman/moblend | MoGraph: cloners, effectors, fields, MoText, fracture |
| Nova FX | this repository (`vendor/nova-fx`) | particles, fire, sparks, fireworks; its C core compiles for your CPU on install |
| Camera | github.com/GTKottman/Blender-Cam | framing, shot presets, camera moves, shake, cuts, contact sheets |
| Animate | github.com/GTKottman/Blender-Animate | easing, springs, paths, motion analysis |
| Math | github.com/GTKottman/Blender-Math | LaTeX and exact math in 3D |
| Circuits | github.com/GTKottman/Blender-Circuits | circuit design, simulation, electron-flow animation |
| Camera Flight | github.com/GTKottman/boender-camera-flight | for you: fly the camera like a game and record takes |

Each is built with its repository's own build script (run by Blender's Python), installed with
`blender --command extension install-file`, then loaded once headless to prove it registers. Sessions call them
directly inside Blender (the `blender-3d` skill), with no MCP servers. `mortiflix blender` opens this Blender for
you (Camera Flight: 3D Viewport › N › Flight).

**Nova FX**, Mortiflix's own particle engine, **builds on Linux only for now** (gcc with OpenMP, usually already
installed). On other systems the other toolkits still install; Nova is reported as not built.

## Platforms

**Mortiflix has mostly been tested on Linux so far.** A Windows version is coming in the next two weeks (by
October 20, 2026): the installer and setup are ready, sessions are next. See [WINDOWS.md](WINDOWS.md). macOS should work for most of setup (the code has its Blender build, Chrome location and uv
installer) but hasn't been tested, and Nova FX doesn't build there. ComfyUI's install assumes an NVIDIA card with CUDA.
If an install fails, the walkthrough shows the command and its last lines of output; fixes and reports are welcome.

## Removing things

Delete `~/Mortiflix/tools/` (Strudel, Chrome, Blender, the profile, ComfyUI). browser-harness and uv are your own
tools: `uv tool uninstall browser-harness`, and see uv's docs to remove uv.
