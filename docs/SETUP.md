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
| **Narration** | a voice reads the script; the animation is timed to its words | an ElevenLabs key (the default and only generated voice), **or** your own voice, **or** nothing | |
| **Music** | an original score, written to the approved animatic | Strudel (`@strudel/web` from npm) and a headless Chrome (yours is reused) | ~20 MB (+~100 MB without Chrome) |
| **Assets** | stock assets from sites you already use, in your own Chrome | browser-harness (browser-use, via uv) and the list of your sites | ~60 MB |
| **3D** | 3D scenes rendered in Blender | Blender (yours is reused) and the 3D toolkits, in the studio's own Blender profile | ~350 MB + ~15 MB |
| **Craft apps** | sessions work in real design apps (After Effects, Photoshop, Illustrator… remakes) through their MCP servers | the official builds of the apps you pick, into `tools/craft` | 15–80 MB each, ~900 MB for all 12 |

## Claude

Claude Code, logged in, is used if it's installed (your plan pays). Otherwise an Anthropic API key (you pay per
token); the key is checked with a free call and kept in `secrets.json` (mode 600). See `mortiflix keys`.

## Narration

1. **ElevenLabs**: paste a key, pick a voice and model (see [VOICE.md](VOICE.md)).
2. **Your own voice**: you record the lines in the booth.
3. **None**: on-screen text, music and sound.

There is no local voice or image generation (removed 2026-11-01: local generation is bloat).

## Music

Strudel 1.3 (AGPL-3.0) is installed from npm into `tools/strudel`; scores are rendered by Strudel's own offline
renderer in a headless Chrome. Your Chrome or Chromium is used if it's there; otherwise Chrome for Testing's headless
shell is downloaded into `tools/browsers`. You also choose:

- **Original score or no music.** With no music, the music step is skipped in every video and the song pipeline
  won't start.
- **A MIDI pack**: every part as MIDI on its own channel, the stems, and a cue sheet (tempo, sections, hit points),
  delivered with every final so you can remake the music in your own DAW.
- **Your DAW** (`mortiflix setup daw <name>`): Ableton Live, FL Studio, Logic Pro, REAPER, Bitwig Studio, Cubase,
  Studio One, GarageBand or Pro Tools. Every MIDI pack's cue sheet then has the steps to bring it into that DAW;
  without one, the steps are general. Nothing to install.

Each brief also says who finishes its music. For videos the recommended answer is you: the studio writes and checks
the score, and you take its MIDI into your own DAW and import your master (the project's Music panel, or
`mortiflix music <project> --import <file>`).

How the music engine works: [MUSIC.md](MUSIC.md).

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

## Craft apps

The Craft apps are open-source, clean-room remakes of the Adobe apps (and a few more) written in Rust by the team
behind ArtCraft ([github.com/storytold](https://github.com/storytold)). Each one is **MIT OR Apache-2.0**, ships
official builds for Linux, macOS and Windows, and has a command line whose `mcp` subcommand is an MCP server: every
menu item is a command Claude can run, headless.

| App | Remakes | In a motion design studio |
|---|---|---|
| EffectCraft | After Effects | compositions, keyframes, shape and text layers, puppet pins, 3D layers; renders MP4/WebM |
| PhotoCraft | Photoshop | layered images and PSD files, adjustment layers, masks, brushes |
| VectorCraft | Illustrator | vector artwork, logos, paths, Pathfinder; SVG/PDF/PNG |
| LightCraft | Lightroom | developing photos and raw files |
| DesignCraft | InDesign | page layout and typography |
| SoundCraft | Audition | audio editing and cleanup |
| PdfCraft | Acrobat | PDFs |
| DeckCraft, WordCraft, GridCraft | PowerPoint, Word, Excel | slides, documents, spreadsheets |
| CadCraft | CAD | technical drawing |

```
mortiflix craft install all                 # or: mortiflix craft install effectcraft photocraft vectorcraft
mortiflix craft                             # what's installed
mortiflix craft open photocraft out/key.psd # open a file a session made
mortiflix craft register                    # also give your own Claude Code their MCP servers (user scope)
mortiflix craft remove <app>
```

**How they're pulled.** Mortiflix doesn't copy their code. For each app it asks GitHub for the latest release,
downloads the build for your system (Linux/FreeBSD `.tar.gz`, Windows portable `.zip`, macOS the CLI `.zip` and the
app's `.dmg`), and checks its SHA-256 against the release's own `SHA256SUMS.txt`. A file that doesn't match, or isn't
listed, isn't installed. Then it starts the app's MCP server once to check that it runs on your computer, and keeps the
app in `tools/craft/<app>/` with a `craft.json` that records the version and checksums.

**What sessions get** (claude-code backend): each installed app's MCP server, through `--mcp-config` (the file is
`.mortiflix/craft-mcp.json` in the project folder), with its tools allowed (`mcp__<app>`). They also get the
`craft-apps` skill and a line in their CLAUDE.md. The servers run with the project folder as their working folder, so
files land in the project; PhotoCraft is started with that folder as its only read and write root. VectorCraft is
started `--headless`. With the sandbox on, `tools/craft` is visible read-only. The command lines are also in
`$MFX_CRAFT` for long renders through `mfx render` (and for the anthropic-api backend, which has no MCP).

**Be aware.** They are young: most of them came out in October 2026 and change every day. `mortiflix craft
install` again updates them. The **ArtCraft** name and logo are the ArtCraft team's trademarks and are not open source.
Mortiflix only names the apps. ArtCraft's own AI app (`storytold/artcraft`) is "fair source", not open source, and
isn't offered here.

## Platforms

**Mortiflix has mostly been tested on Linux so far.** A Windows version is coming in the next two weeks (by
October 20, 2026): the installer and setup are ready, sessions are next. See [WINDOWS.md](WINDOWS.md). macOS should work for most of setup (the code has its Blender build, Chrome location and uv
installer) but hasn't been tested, and Nova FX doesn't build there. 
If an install fails, the walkthrough shows the command and its last lines of output; fixes and reports are welcome.

## Removing things

Delete `~/Mortiflix/tools/` (Strudel, Chrome, Blender, the profile, the Craft apps, and any ComfyUI or qwen-tts folder an older version installed). If you ran
`mortiflix craft register`, also `claude mcp remove --scope user <app>` for each one. browser-harness and uv are your own
tools: `uv tool uninstall browser-harness`, and see uv's docs to remove uv.
