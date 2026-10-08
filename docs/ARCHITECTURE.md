# Architecture

Everything runs on one machine, in one Node process (`mortiflix serve` or `mortiflix run`), around one folder: the
studio.

```
 you ── web studio / CLI ──▶  gates.mjs  ◀── bridge (Unix socket) ◀── mfx ◀── the session (Claude)
                                  │                                            ▲
                                  ▼                                            │
                           state/<id>/ (the record)          runner.mjs ── backend: claude-code │ anthropic-api │ demo
                                                                  │
                                                     projects/<id>/ (the working folder, session cwd)
```

## The studio folder

```
~/Mortiflix/                       ($MORTIFLIX_STUDIO or --studio to move it)
  config.json        settings, no secrets
  secrets.json       Anthropic and ElevenLabs keys, web token (mode 600; `mortiflix keys`)
  session.env        other KEY=value lines handed to sessions, e.g. GEMINI_API_KEY (mode 600; `mortiflix keys`)
  checks.json        the studio's error checklist: proposed by sessions, approved by you
  TASTE.md           what you like, learned across projects (sessions add with `mfx taste`)
  pipelines/         your own pipelines (same slug overrides a built-in one)
  projects/<id>/     the working folder: the session runs here
  state/<id>/        the record: project.json, events.jsonl, the pinned pipeline, submissions, feedback, transcripts
  run/               the runner lock, render logs, an npm cache for sandboxed sessions
```

The split matters: **sessions write to `projects/<id>/`; only Mortiflix writes to `state/<id>/`.** A submission's
files are copied into the record when submitted, so what you reviewed can't change afterwards.

## A project's life

1. **Created** (`createProject`): the pipeline is snapshotted into `state/<id>/pipeline/` (with its shared skills).
   The project is pinned to that snapshot forever; editing the pipeline later only affects new projects.
2. **Started**: required intake answers are checked; the state becomes `queued`.
3. **The runner** (`runner.mjs`) takes the oldest `queued` project, one session at a time:
   - `prepareWorkdir` copies the pinned pipeline to `pipeline/`, its skills to `.claude/skills/`, the gate protocol
     to `.mortiflix/GATES.md`, and the checklist on the first session;
   - `writeTorch` writes `CLAUDE.md`: where things stand, the steps table, what you said, the error checks, the
     brief (fenced as data), your taste, the journal;
   - `openBridge` starts a private Unix socket with a per-session token;
   - the backend runs the session with `MFX_SOCKET`/`MFX_TOKEN` in its environment and `bin/` on its `PATH`.
4. **The session** works, talks to the studio only through `mfx`, submits at a gate, writes a handoff, and ends.
5. **After it ends**, renders it left are stopped, usage is recorded, and the project's state is recomputed
   (`settle`): `waiting` (your turn), `queued` (more to do), or `delivered`.
6. **You respond** (web or CLI): approve, or ask for changes with notes; answer questions. The feedback lands in
   `projects/<id>/feedback/` and the next `CLAUDE.md`, and the project is `queued` again.

### Guards

- Two sessions in a row that move nothing forward (no submission, step, question or handoff) pause the project
  with the error, instead of burning tokens in a loop.
- Eight sessions in a row without submitting or finishing a step also pause it.
- A session past `maxSessionMinutes` is stopped; the next one picks up from the handoff.
- One runner per studio (`run/runner.pid`), so `serve` and `run` never start sessions side by side.

## The gates (`src/gates.mjs`)

| Rule | Where |
|---|---|
| Only you approve a reviewed step | `respond()` is only reachable from the web API and the CLI, never from `mfx` |
| Internal steps finish only with their checks | `stepDone()` |
| Every check for the step's kind of work is reported, `fixed`/`n/a` with a note | `validateChecks()` |
| Every note on the last version gets an entry in `pin_changes` | `submit()` |
| Submitted files exist, are inside the working folder (symlinks resolved), and are copied | `submit()` |
| A step can't start before the steps it runs after are finished | `stepView()` + `submit()`/`stepStart()` |
| The review mode decides what must be submitted (frames need images, video needs a video, …) | `submit()` |
| Status lines come from the pipeline's whitelist | `status()` |

Steps have stored states (`working`, `in_review`, `changes`, `approved`, `done`) and derived ones (`ready` when
everything it runs after is finished, otherwise `blocked`). Steps without a dependency between them can run side by
side: the explainer's script and style frames do.

## The bridge and `mfx`

`bridge.mjs` is an HTTP server on a Unix socket in the OS temp dir, alive only during a session. `mfx` (`src/mfx.mjs`)
posts JSON to it with the session's token. Commands map one to one onto `gates.mjs` (plus `render`, `render-wait`,
`taste`, `feedback`, `files`). A refusal comes back as a plain sentence the session can act on ("pin_changes: note 2
from directions v1 has no answer").

## Renders (`renderq.mjs`)

Heavy work (Remotion, anything that starts Chrome or the GPU) goes through `mfx render`, which queues it studio-wide
and returns an id at once; `mfx render-wait <id>` waits up to a timeout. No tool call blocks for longer than a
backend allows, and two renders never fight for memory. While a render waits or runs, you see "Waiting to render"
or "Rendering: <label>".

## Backends (`src/backends/`)

A backend exports `run({ root, projectId, workdir, prompt, env, transcript, onActivity, signal, config })` and
returns `{ ok, error?, usage?, cost_usd? }`; `available(config, root)` says whether it's set up.

- **claude-code**: spawns `claude -p … --output-format stream-json` in the working folder with the configured
  permission flags; parses the stream for the activity log; optional bubblewrap sandbox (`sandboxArgs`).
- **anthropic-api**: a streaming agent loop on `client.beta.messages.stream` with the `bash_20250124` and
  `text_editor_20250728` tools (executed locally: a persistent bash shell, an editor confined to the working folder
  that returns images as image blocks), optional web search and fetch, adaptive thinking with a configurable effort,
  automatic prompt caching, server-side compaction, and refusal fallbacks (`fallbacks: "default"`; blocks of a
  declined attempt are dropped before they're sent back). Default model: `claude-opus-5-5`.
- **demo**: no model; walks the gates with placeholder work through the real bridge.

Adding a backend is adding a module with those two functions to `BACKENDS` in `runner.mjs`.

## Setup (`src/setup.mjs`)

The parts of setup (Claude, narration, music, assets, 3D), each tool's detection and installer (`strudel`, `chrome`,
`browser-harness`, `blender`, `blender-addons`, `comfyui`), and the owner's choices in `config.json` (`music`,
`assets.sites`, `tools.*` paths). `setupStatus` (async: it asks ComfyUI) feeds the walkthrough and the page;
`setupStatusSync` feeds the session brief's "This studio" section. `sessionToolsEnv` gives sessions `MFX_STRUDEL`,
`MFX_CHROME`, `MFX_BLENDER` (+ `BLENDER_USER_RESOURCES`, `MFX3D`), `MFX_MUSIC` and `MFX_ASSETS`. Studio skills that
depend on setup (`harness/skills/blender-3d`, `harness/skills/assets`, the toolkits' own skills, browser-harness's)
are installed into each project by `torch.mjs`. A pipeline step with `"when": "music"` is marked `skipped` at start
when the studio or the brief has no music; a skipped step counts as finished only once its own predecessors are.

## Platforms (`src/platform.mjs`)

What differs between Linux, macOS and Windows: finding a program on the `PATH` (with `PATHEXT` on Windows),
running `.cmd` programs like npm through `cmd.exe` with quoted arguments, Windows' own `tar.exe`, Git Bash, the
`PATH` separator and opening a file. For sessions:
- where the bridge listens (`ipcPath`: a named pipe on Windows);
- a session's `PATH` under the one key Windows already uses (`withPath`: `Path` and `PATH` side by side would leave
  the child to pick);
- stopping a process and everything it started (`killTree`: a process group, or `taskkill /T`);
- Git Bash paths in the API backend's editor (`fromShellPath`);
- secrets only you can read (`restrictToOwner`: mode 600, or an ACL).

Each function takes `platform`, `env` and `exists` as options, so `test/platform.test.mjs` checks the Windows
behaviour on any machine. `scripts/windows-smoke.mjs` runs the session half for real, with a stand-in for `claude`
and no cost. CI runs it on Windows and Linux for every push. The Windows installer is `install.ps1`; the port's
status is in [WINDOWS.md](WINDOWS.md).

## Keys (`src/keys.mjs`)

One registry of the keys a studio can hold (Anthropic, ElevenLabs), what each is for, and when a project needs it:
`anthropic` when it runs on the `anthropic-api` backend, `elevenlabs` when the studio narrates with ElevenLabs and the
work makes sound. `verifyKey` proves a key with a free, read-only call (`GET /v1/models`, ElevenLabs'
`/v1/user/subscription`) and tells a refused key (`ok: false`) apart from an unreachable API (`ok: null`). The CLI
(`mortiflix keys`, `init`, `new`), the web server (`/api/keys`, and `409 needs_keys` from `/start`) and the runner (a
project that lacks a key for its next steps pauses with `NEEDS_YOU` instead of starting a session) all ask it. Other
keys for sessions go to `session.env` through `setSessionKey`; only their names are ever shown.

## Narration (`src/voice/`)

`voice/index.mjs` holds the studio's choice (`config.json` › `voice`: `none`, `elevenlabs`, `qwen` or `own`) and hands a
session `MFX_VOICE` (the settings) plus `ELEVENLABS_API_KEY` only when ElevenLabs is the engine.
`voice/elevenlabs.mjs` talks to ElevenLabs for setup (account, models, voices, Voice Library, dictionaries, a test
line) and builds every text-to-speech request so it carries only what the chosen model takes (Eleven v4: stability and
similarity only). `voice/qwen.mjs` detects the GPU, reads the installed ComfyUI nodes (models, voices, runtime modes)
and builds the speak and listen graphs. Sessions narrate with the voiceover skill's `vo.mjs`, which imports these
modules (`MFX_HOME`), and make effects and music beds with `sound.mjs`. See [VOICE.md](VOICE.md).

**The recording booth** (`src/booth.mjs`) is the `own` engine: the owner reads the session's `voice/lines.json`. Every
take is kept under `voice/takes/` with its measurements; the kept take of a line is copied to `voice/clips/<line>.wav`
with the same report shape `vo.mjs` writes, plus the `script` it was recorded for, so `vo.mjs speak` knows which lines
are done (and which changed since) and `build` works unchanged. Three front ends share it: the web booth
(`web/app.js` `boothView`, an AudioWorklet in `web/booth-worklet.js`, takes uploaded as WAV to
`/api/projects/<id>/booth/…`), the terminal booth (`src/record.mjs`, ffmpeg from the system microphone) and
`mortiflix record --import` for files recorded elsewhere.

## Music (`pipelines/_shared/skills/music/`, `src/music.mjs`)

The music engine is a skill: `strudel.mjs` runs one stage per command (genre, plan, check, instruments, audition,
render, master, own-master, sheet) over the project's `music/` folder, on top of `lib/` (the score read as MIDI
channels and the intensity curve, the harmony lock, MIDI files, the genre profile, instruments as a Strudel layer per
channel, WAV measurement, ffmpeg mastering, zips) and a headless Chrome running Strudel (`lib/headless.mjs`, a fresh
page per render). See [MUSIC.md](MUSIC.md).

`src/music.mjs` is the owner's side of it: the MIDI pack as a zip, and importing a master made in the owner's own DAW
(converted to 48 kHz, measured, checked against the score's length and its first note, written to
`music/own-master/`). The web studio (the project's Music panel, `/api/projects/<id>/music…`) and
`mortiflix music` both use it; an import that fits resumes a project that was waiting for it. Whether a brief
finishes its own music (`finishesOwnMaster`) goes into the session's `CLAUDE.md`.

## Sharing pipelines (`src/pipelines.mjs`, `src/zip.mjs`)

`exportPipeline` snapshots a pipeline with its shared skills (the same self-contained shape a project pins) into one
zip; `addPipeline` unpacks one into the studio's `pipelines/` after refusing unsafe paths and validating it.

## The web studio (`src/web/server.mjs`, `web/`)

A plain `node:http` server and a no-build vanilla JS app. JSON API under `/api`, live updates over server-sent events
(`/api/events`: `change` and `activity`), submitted media under `/files/<id>/reviews/…` with Range support. See
[SECURITY.md](SECURITY.md) for its guards.

## Claude Code (`plugin/`)

The repository is also a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). It has one plugin,
`plugin/`, with one skill: `/mortiflix`. The skill drives the same CLI the owner would type, using commands that
need no terminal:

- **Reading.** `--json` on `pipelines`, `list` (the studio, whether a runner holds it, every project), `status`,
  `review` (questions, and every step in review with its note, `pin_changes`, items with absolute paths and numbered
  paragraphs), `keys` (sources only) and `setup status`.
- **Deciding.** `respond <project> <step> --approve|--changes --note … --overall … --answer qid=value` and
  `answer <project> <qid> [answer]`. Notes use the terminal review's syntax (`parseNote`).
- **Setup.** `setup install <tool>…`, `setup music strudel|none [--midi]`, `setup assets <url>…|--clear`. Choosing a
  voice and typing keys stay with the owner, in their terminal or the web studio.

Two guards keep the guide and the studio apart:
- The skill has `disable-model-invocation: true`. Studio sessions are Claude Code too, and they may load the
  owner's plugins, so they must never pick the skill up by themselves.
- The owner's commands (`respond`, `answer`, `review`, `reopen`, `pause`, `resume`, `cancel`,
  `checks approve|reject`) refuse to run when `MFX_TOKEN` is set, which means inside a session.

The `claude-code` backend also drops the variables a Claude Code conversation sets for its own tools
(`PARENT_SESSION_VARS`). A `mortiflix run` started from `/mortiflix` therefore gives each session its own Claude Code,
as if it had been started from a terminal.

