# Mortiflix service protocol: every message (part 08)

The Mortiflix Studio app runs `node bin/mortiflix-service.mjs` and talks JSON lines over stdin/stdout (envelopes,
life cycle and error codes: `docs/mortiflix/protocol.md` in the app repo). This file lists every request the service
answers and every event it sends. Code: `src/service.mjs` (one handler per type) over `src/svc/*.mjs`.

- `project` in any params is optional: left out, the open project is used (`no_project` when none is open).
- Node ids: `b01` beats, `sf01` looks, `s01` shots, `t01` transitions, `b01-1` voice lines, `m01` music cues, `music`
  the mix; assets `a01`. Ids are forever (doc 12): a piece keeps its id, colour and versions for life.
- Paths in results are absolute (media the app imports or plays). Paths the app sends (assets, recordings, renders)
  are files the person picked; the service copies them into the project and never moves the original.
- The service runs the studio's runner itself (the AI works ahead while the app is open). `hello` says whether it
  could (`runner: false` + `runner_note` when another Mortiflix runner already owns the studio). `MFX_SERVICE_NO_RUNNER=1`
  turns it off.
- Nothing here calls a paid API. The AI is the user's own Claude Code (`claude -p`); the Anthropic API key is only a
  fallback (`setup.backend`). Tests run on the demo backend.

## Requests

### Projects and stages (docs 30, 31)

| Type | Params | Result |
|---|---|---|
| `hello` | `{client, version, protocol}` | `{service, version, protocol, studio, runner, runner_note, types[]}`, then a `status` event |
| `state.get` | `{}` | `{project, stage, stages, line, context}` |
| `project.list` | `{}` | `[{id, title, state, pipeline, created_at, updated_at, stage, delivered}]` |
| `files.reveal` | `{path}` | `{revealed, folder}`; shows the file in the file manager (Linux: its folder via xdg-open; Windows: Explorer with it selected; macOS: Finder). Only paths inside the studio; anything else, or a missing file, is a `bad_request` |
| `project.rename` | `{project, title}` | `{project, title, before}`; the name every view shows (project.json `title`, at most 120 characters); an empty name is a `user_error` |
| `project.duplicate` | `{project, upto?: step|all, title?}` | `{project, title, from, kept}`; a new project "<title> (copy)" with the brief and script, plus each later step up to `upto` while it is approved (their files, reviews, canvas nodes and OKs). No session, chat or log is copied and nothing is made: the copy starts `paused` (Resume makes the next step) |
| `project.delete` | `{project}` | `{deleted, title, trash}`; moves `state/<id>` and `projects/<id>` to `<studio>/trash/<stamp>-<id>/{state,work}`; refused while a session runs on it; closes it when open |
| `project.restore` | `{project}` | `{restored, title}`; the newest trashed copy comes back (the Undo of `project.delete`) |
| `project.new` | `{preset, title, idea, answers?, assets?: [{path, use, where, note}], music?: {theme}, start?: true, backend?: "demo"}` | `{project, assets_pending}`; the preset's defaults fill the answers, `idea` is its first long answer; assets copy in the background, then the project starts (`start: false` keeps it a draft) |
| `project.open` | `{id}` | `{project, stage}` (the last stage looked at) |
| `project.close` | `{}` | `{closed}` |
| `project.start` / `.pause` / `.resume` / `.cancel` | `{}` | |
| `review.respond` | `{project?, step, version?, verdict: "ok" \| "changes", notes?: string \| [{text, item?, x?, y?, time_sec?, paragraph?}], overall?, answers?: {id: value}}` | `{step, version, verdict: "approve" \| "changes", project_state}`: the owner's verdict on a step in review, the same `gates.respond` path as `POST /projects/:id/reviews/:step/:version`. `changes` sends the step back with the notes (a string is one note); the next version must answer each note in `pin_changes`. `version` defaults to the one waiting now; a stale version, a missing note on `changes`, or an unanswered question without a default is refused (`bad_request`). Style frames, stills and v3 scenes keep their own per-piece OKs (`frames.ok`, `stills.ok`, `motion.scene.approve`); `ok` on them is refused while pieces wait |
| `review.submission` | `{project?, step, version?}` | `{step, version, note, questions, submitted_at, items: [{label, kind, text, file}]}` or `null`: what Claude submitted for a step version, whole (the `SUBMITTED` event keeps only 300 characters of the note). `version` defaults to the newest submitted |
| `project.events` | `{limit?}` | the project's log rows |
| `tokens.runs` | `{limit?}` | `{runs: [{id, started, ended, running, backend, model, models: [{model, calls, input, cache_write, cache_read, output, total}], calls, cost_usd, why, input, cache_write, cache_read, output, total}]}`: every Claude run of the project, newest first, raw tokens (helper agents included). `model` names every model the run used ("Sonnet 5.5 + Opus 5.5"); `models` is the split per model, biggest first |
| `tokens.run` | `{run, bars?, pulled?}` | `{run, bars: [{key, calls, input, cache_write, cache_read, output, total, examples: [{label, times}], why, models: [name]}], pulled: [{label, group, from, tokens, calls_after, carried}]}`: the run's calls grouped by what they did (sorted by raw tokens; a helper agent is one bar), and what was pulled into the context (`carried` = its tokens × the calls that re-read it). Claude Code's per-call output is estimated from what each call wrote and scaled to the run's exact total; input and cache are exact. Labels never hold file contents; keys in commands are blanked |
| `stage.set` | `{stage: 0-5 \| key, from?, done?}` | `{stage, key, kept[], left[], handover?}`. `done: true` = the owner's Next on `from`: steps in review are approved as they are (pieces OK'd, questions take their defaults). From 3 to 4 (Edit the video) or 5 (Get the video), the session's build/final steps are skipped: the app builds and renders the edit |
| `stage.status` | `{}` | `[StageStatus × 8]`, or × 7 for a v3 project (see "v3 stages" below); also in every `status` event |
| `project.takeover` | `{project?}` | `{resumed, takeover}`: "Let the AI take over" (T1). A step whose quick path gave up (one small repair call first) pauses with the reason (`needs_you.cause`: `gave-up`, `gpu`, `login`, `billing`, `stopped`; `needs_you.takeover: true` = show this button next to Resume); this resumes it and lets one full session run. Also `config.sessionFallback: true` for always. |
| `models.status` | `{}` (always `{off: true}` since 2026-11-01: no local models) | `{wanted, why, models: [{id, label, state: loading\|ready\|working\|stopping, why, waiting, vram_gb, ram_gb, pid}], others: [{name, vram_gb, pid}], gpu: {name, vram_total_gb, vram_used_gb, util_pct, temp_c} \| null, off?}`: the keep-loaded model runners (src/svc/keeper.mjs) and the graphics card |
| `stage.remakes` | `{stage}` | `{remade: [{step, name, stage, pieces}]}`: what is made again if that stage changes (the "going back" pop-up) |
| `stage.reopen` | `{stage, text}` | reopens that stage's last approved step with the owner's words |
| `stage.handover` | `{how: edit \| get}` | `{how, skipped[]}` (what `stage.set` does from 3) |

`StageStatus` = `{kind: notStarted|making|ready|needsYou|done|stopped, done, total, need, text, key, present, steps[]}`.
`present: false` = the preset has no step in that stage (hide it). `need` counts pieces waiting for an OK, open
questions and failed remakes.

### Presets (doc 31)

| Type | Params | Result |
|---|---|---|
| `presets.list` | `{}` | `{built_in: [Preset], yours: [Preset]}`; Preset = `{slug, name, description, source, makes, based_on, length, aspect, voice, music, idea_field, stages[], steps: [{key, name, review, stage, off, waits, always}], error?}` |
| `voices.list` | `{}` | `{voices: [{id, name, category, labels, preview_url}], reason?}`; the ElevenLabs account's voices; `preview_url` is the free sample (no credits). No key: `{voices: [], reason: "no_key"}`; also `bad_key`, `unreachable` |
| `presets.get` | `{slug}` | Preset + `{intake, skills[], look, voice_preset, music_theme, editable}` |
| `presets.save` | `{from, name, description?, defaults?, steps?: {key: {on, waits}}, skills?: [names kept], skill_folders?: [paths], look?: {words, frames: 3-5, pictures: [paths]}, voice?: {name, delivery}, music_theme?, replace?}` | `{slug, name, preset}`. A built-in is never changed (saving makes your copy). Brief, Script and the final always run |
| `presets.delete` | `{slug}` | your own presets only |
| `voice.list` | `{}` | `{engine, engines, presets, elevenlabs_key, local}` (Settings › Narration) |

### Assets (doc 32)

| Type | Params | Result |
|---|---|---|
| `assets.list` | `{}` | `{yours: [Asset], found: [...], removed: [...]}`; Asset = `{id, name, kind, size, use: must\|fits\|reference, where: [beats]\|null, note, path, version, versions[], used_in: [{node, how}], heard?}`; `heard` (song files) = `{seconds, bpm, confidence, first_downbeat_sec, bar_sec, key, chords: [one per bar, "Am\|F" for a split bar], progression}` |
| `assets.add` | `{paths: [...]}` or `{assets: [{path, use, where, note}]}` | `{queued}`; then `assets.progress` / `assets.added` / `assets.failed` events. Works at any stage |
| `assets.update` | `{asset, use?, where?, note?}` | `{asset}` |
| `assets.replace` | `{asset, path}` | `{queued}`; new version, the old one kept |
| `assets.hear` | `{asset}` | `{asset}` with `heard`: the song's tempo, key and chords from its audio (src/music/listen.mjs, no AI). A song added with `use: reference` (Like this song) is heard by itself after it's copied in, then an `assets.added` event with `heard: true` and a chat row |
| `assets.remove` | `{asset}` | hidden, the file kept |
| `assets.use` | `{asset, node, how?, remove?, fix?: true}` | drag onto a piece: recorded as used there, and (unless `fix: false`) a Fix asks the AI to put it in |

### Music theme and cues (doc 33)

| Type | Params | Result |
|---|---|---|
| `music.theme.get` | `{}` | `{theme}` (`music/theme.json`, doc 33's shape) |
| `music.theme.set` | `{theme}` | the owner's theme (`picked_by: you`) |
| `music.theme.samples` | `{theme?, project?}` | `{samples: [{id, name, desc, strudel, wav, bpm, key}], made, using}`; demo: three quiet 15 s placeholders at once (no project needed, for New project › Choose…); a real backend asks the next session (`made: false`, they arrive as a chat card) |
| `music.theme.use` | `{sample}` | picks one of the samples |
| `music.theme.check` | `{theme}` | the theme cleaned as it would be saved |
| `music.cues` | `{}` | one cue per beat: the plan before the score, the sections after (`scored`) |
| `music.cue.set` | `{cue, feel?, energy?, tension?, text?, bars?, part?}` | before the score: `{plan}`; once scored: a Fix on that cue, `{edit}`. `tension` 0 smooth … 1 rough (tenths; `null` = the AI decides): the quick music plan must give a scene asked 0.3+ more tension rougher chords (Visual-Harmonics' roughness model), or it is sent back |

### Look (stage 2, doc 11 §9.3; the Look panel and the chat's looks card)

| Type | Params | Result |
|---|---|---|
| `look.get` | `{}` | `{project, using, frames: [{id, label, name, words, path, version, versions, state, owner, pending, making, beats, palette: [hex], fonts: [names]}], shots: [{id, label, title, beat, beat_no, colour, made, cut, look, changed, changed_from, remaking}], max, can_more}`. The looks are the frame nodes (`design/frames.json`); `path` = the picture of the version in use (absolute; PNG/JPEG/WebP or SVG); `using` = the owner's pick (`state/<id>/canvas/look.json`), else the first frame; `palette` / `fonts` = what the session wrote in `frames.json`, else what an SVG frame uses; `making` = asked for with `look.more`, not made yet; a shot's `look` = the look it was made in, `changed` = being remade because the look changed |
| `look.use` | `{frame, confirm?: true}` | without `confirm`, when shots were made in another look: `{needs_confirm: true, from, to, remake: [shot…]}` and nothing changes; otherwise (or confirmed) `{using, from, changed, remake, remaking: [{node, edit}]}`: the look is in use (mirrored as `using` in `design/frames.json` for the session) and each shot made in another look gets a Fix in this one (versions kept), plus one grey chat line ("Look: now Cold neon · remaking 4 shots in it") and a `look.changed` event. A look not made yet is refused |
| `look.more` | `{count?: 1-3 (2), text?}` | `{making: [{node, edit}]}`: new looks to pick from, asked of the session as new frame pieces (`sfNN`, edit op `more`, same path as a new shot); at most 8 looks in all |

Stage 2 Look (doc 11 §9.3, doc 37's looks card, `src/svc/look.mjs`). None of the existing messages picks the look in
use (`node.edit ok` on a frame is an approval, not a pick), so these three are new. Ask for changes on one look is the
chat in that frame's context (`chat.context` + `chat.send`: a Fix on it). The chat's `looks` card carries each frame's
`name` and its `using` is the owner's pick.

### Stills (v3, svc/stills.mjs)
One still per voice line (`voice/lines.json` ids like `b01-1`), drawn with Kinetograph in the look brief's palette. State in `design/stills/stills.json`, pictures `design/stills/<line>-v<N>.png`.

| Request | Answer |
|---|---|
| `stills.get` | `{project, lines: [{line, words, key_word, path, versions, state: todo|drawing|check|ok, error, check: {key_word_visible: bool|null}}]}`; the check reads the still's own text layer, not pixels |
| `stills.make` | draws every line with no still yet, in the background: `{making}`; `stills.changed` at the end |
| `stills.fix {line, text?, key_word?}` | redraws that one line (new words and/or key word): `{line, drawing}`; `stills.changed` when done |
| `stills.ok {line}` | signs the still off (refused with no picture) |

Event `stills.changed {project, line?, drawing?, error?}`.

### Script (stage 1, doc 11 §9.1; the Script panel and the chat's script card)

| Type | Params | Result |
|---|---|---|
| `script.get` | `{}` | `{project, rev, writing, version, beats: [{id, no, name, name_auto, name_from, colour, visual, target_sec, state, lines: [{id, words, changed, changed_at, read_only, remaking: {shots, lines}, feeds: [{node, kind: line\|shot, label, state, current, made, remaking}]}], deleted: [{id, words, after, changed_at}]}], draft, draft_at}`. Line ids are the voice line ids (`b01-1`), forever. `feeds` = the graph's `says` edges: the line's voice line and its beat's shots. `writing` = the AI is still writing the script; its newest line is `read_only` |
| `script.edit` | one edit, or `{edits: [edit…]}` (the app's Save sends every draft change at once). Edit = `{beat, beat_name}` \| `{beat, line, words}` \| `{beat, add_after: line id \| key \| null, words, key?}` \| `{beat, line, delete: true \| false}` | `{project, beats, changed[], added[], keys: {key: new id}, deleted[], restored[], renamed[], remaking: [{node, kind, edit}]}`, also sent as a `script.changed` event, plus one grey chat line ("Script: 1 line changed · remaking 1 shot and 1 voice line") |
| `script.draft` | `{draft: {…} \| null, project?}` | `{project, saved, cleared}`: the app's unsaved script changes (its own shape, at most 256 KB), kept per project in `state/<id>/canvas/script-draft.json` and handed back as `script.get`'s `draft`, so they survive a service restart, a project switch and a crash; null (or a saved `script.edit`) clears them |

`script.edit` writes the session's own files (`script/beats.json`: the beat's `lines` and `name`, its `words` = the lines
as one paragraph; `voice/lines.json` once the voice exists), so the canvas graph picks it up as usual (the beat gets a
new version). Then only the pieces that used the changed words and already exist are remade, each a Fix through the
canvas (`node.edit fix`; versions kept, the AI runs ahead as usual): new words remake the line's voice line and its
beat's shots; a new line records a new voice line; a deleted line is kept (hidden) and its voice line is cut;
`delete: false` brings both back: the same line in its place with its words and links, the same voice line (its OK
too, kept as `was` while deleted), nothing remade. `deleted` lists a beat's deleted lines (kept, ids are forever) with
the line shown before each (`after`, null = first), so the app can show "deleted · Undo" after a save. Pieces not made yet are made from the new words anyway. A line the AI is still
writing is refused.

### Voice & music stage (doc 34)

| Type | Params | Result |
|---|---|---|
| `voicemusic.view` | `{}` | `{shots, voice: [{node, words, path, start_sec, dur_sec, gain_db, voice, timing_locked, takes[]}], cues, music: {path}, bpm, beats_per_bar, length_sec}` |
| `voice.lines` | `{}` | just `voice` of the above |
| `audio.peaks` | `{path, buckets?}` | `{peaks: [0..1 x buckets], duration_s, cached}`; `path` (absolute or studio-relative) must be a file inside the studio, else `bad_request` ("audio must be a file inside the studio"). ffmpeg decodes to mono 8 kHz PCM; each bucket is its max abs sample. `buckets` default 400, capped at 4000. Cached in `<studio>/state/cache/peaks/*.json` by path + mtime + size + buckets. Read-only (answered on the fast lane). |

Each entry of a voice line's `takes[]` also carries `status`: `ready`, or `superseded` when it is not kept and another take of the line is. Booth takes only exist once recorded, so `queued`, `processing` and `failed` are not reported yet.
| `mix.set` | `{node, gain_db?, nudge_sec?, start_sec?: n\|null, voice?, duck_db?, len_bars?}` | `{node, mix, edit}`; a new voice or length is also a Fix |
| `voice.line.words` | `{line, text}` | Remake line with new words (a Fix) |
| `voice.line.take` | `{line, text?}` | New take (a Fix) |
| `step.cost` | `{project?, step}` | `{step, estimate_credits, free, characters?, lines?, voice:{id,name,model,from}?, confirmed, ok_now, ask_first, waiting}` (`ok_now`: the next version's cost is OK'd): what a paid step (`voice`, `music`, `sound`) would spend if it started now, and the voice that would read (`from: cast` once a narrator is picked, else `studio`). Free, read-only. |
| `step.confirm_cost` | `{project?, step}` | `{step, credits, version, resumed}`: the owner's OK on the cost of the step's next version. Cost first (`config.paid.ask_first`, default true, `src/svc/paidgate.mjs`): a step that spends ElevenLabs never starts by itself; the runner pauses the project with `needs_you {kind:'cost_ok', cause:'cost_ok', step, estimate_credits, voice?}` ("Waiting for your OK on the cost") until this call. The OK is also the voice's budget: a plan more than 10% over it records nothing and asks again. `voice.make {confirm:true}` books the same OK. With ask_first on, an OK'd scene no longer starts its voice. |
| `cast.get` | `{project?}` | `{cast:[{role,voice_id,name,model,v4,settings{stability,similarity_boost,style,speed,use_speaker_boost},gain_db}], set, fallback}`: the voice cast in `voice/cast.json` (fallback = the studio's one voice until a cast is saved). vo.mjs reads it: a line's `role` picks voice, model, settings and clip gain (v4 stores style/speed but never sends them) |
| `cast.set` | `{cast:[...]}` | Saves the cast (roles unique, values clamped) |
| `voice.line.set` | `{line, tags?, role?, gap_after?, stability?, dry?}` | Edits one line in `voice/lines.json` (`text` keeps its `[tags]` prefix, `script` stays plain). Returns `{line, changed{tags,role,gap,stability}, retake, credits, edit}`; `retake` (words/tags/role/stability changed) sends a Fix for that line only, `credits` = characters ElevenLabs bills; `dry:true` changes nothing and just answers |
| `voice.speed.get` | `{}` | The voice's Length against the length chosen on New project and its Speed: `{seconds, chosen_sec, over_sec, speed, speeds}` (`over_sec` > 0 = longer than asked) |
| `voice.speed.set` | `{speed}` | Free: the whole voice time-stretched (ffmpeg atempo, pitch kept), one of 0.9 to 1.15 in 0.05 steps, saved in `voice/speed.json`. The voice is joined again from its takes (no ElevenLabs) a moment later; `node.changed` says when. A pause change (`voice.line.set` gap only) joins it the same way |
| `voice.check` | `{project?}` | Verbatim check per line (`voice/timing.json` words vs script): `{lines:[{id,role,text,tags[],gap_after,stability,checked,ok,missing[],extra[],word_count,words:[{text,start,end,extra}]}], checked, bad[], total}` (`words[]` = what was heard, from timing.json, for word chips; `extra:true` marks a heard word not in the script; `word_count` = words in the script; `words` is `[]` until the line is timed) (also the way to read each line's role, tags and pause) |
| `voice.booth.status` | `{}` | the booth's lines and takes |
| `voice.booth.speakers` | `{}` | `{names, dir}`: who has recorded before (most recent first) and the folder their kept takes are collected in (`<dir>/<name>/<project>-<line>.wav` + `.txt`) |
| `voice.booth.import` | `{line, path, keep?: true, source?: booth, speaker?}` | the app's own recording or a picked file as a take (any format via ffmpeg), kept so it plays |
| `voice.booth.keep` | `{line, take}` | |

### Node area (doc 35)

| Type | Params | Result |
|---|---|---|
| `graph.get` | `{}` | `{rev, fps, order: {beats, shots, frames, lines, cues, transitions, film}, beats: [{id, no, title, name, colour}], nodes: [...], edges: [{from, to, kind: next\|says\|look\|uses\|under}], assets, open_edits, problems}`; each node: `id, kind, label, title, beat, beat_no, colour, state, owner, current, plays, versions[{v, path, from_sec, to_sec, still}], pending, failed, edits, pos, default_pos, mix, uses`. a beat node also has `name` + `name_from: script|ai|words` (its short title, see Beat names). `still` = a PNG of a shot version's first frame (made once with ffmpeg in the background; null until it exists; a picture version is its own still). `assets[]` carry `pos` (free placement; `node.move` takes asset ids) |
| `node.list` | `{}` | the foundation's flat list (kept) |
| `node.edit` | `{node, action: ok\|fix\|cut\|clear, text?, bars?, part?}` | OK / Fix / Cut it; every press is a grey line in the chat |
| `node.move` | `{positions: {id: [x, y] \| null}}` | `{moved}`: free placement, saved per project |
| `node.reorder` | `{order: [shot ids]}` | `{film}`: reorder = rewire the chain; nothing is remade |
| `node.pick` | `{node, v \| null}` | `{node, plays}`: play an older version (null = newest). Works on voice lines (`b01-1`, kind `line`): each re-made clip is a version, the take switcher; tested |
| `notes.transcribe` | `{note \| audio, force?}` | `{job, note}` at once; then event `notes.transcribed {job, project, note, audio, text, language?, cached?}` or `{..., error}`. Local faster-whisper (free, offline), run off the request chain; words kept in `<audio>.txt`. `note` = a saved note id with a recording; `audio` = a file inside the project. Python: `MFX_WHISPER_PYTHON`, else the studio's qwen-tts venv, else `python3`; model `MFX_WHISPER_MODEL` (default `base`). Not installed = an `error` event saying so |
| `node.duplicate` | `{node, text?}` | `{edit, node}`: a new shot like it, right after it |
| `node.insert` | `{after, text}` | `{edit, node}`: a new shot after `after` |
| `node.find` | `{query}` | matching nodes |

The AI stopped (`status` `state: paused` with `needs_you`, not `by_you`): the app shows what happened in the chat and at
the end of the stage bar's hint, with **Resume** (`project.resume`). `needs_you.cause: "login"` (the runner sets it
when the session failed on Claude Code's login: "OAuth session expired", 401, "/login"; the app also reads those words in
the text) says so plainly and offers **Link Claude Code** instead (`mortiflix.setup {step: 1}`: Setup on its Claude Code
step); the app then checks `setup.status` every 4 s and sends `project.resume` itself once `claude.logged_in`.

What the AI works on (`work.active`, `src/svc/work.mjs`): only real state. Nothing is animated unless a session runs
for the project (`running`). Then the owner's open Fixes come first (the runner does edit requests first): each such
piece is `remaking` (`v` = the version being made) or `making` (not made yet). Otherwise `step` is the step the runner
works on (the first ready / working / changes step) and its canvas pieces not made yet are `making` (a step sent back
with notes: its pieces not OK'd are `remaking`). `current` = the piece the newest activity line names, else the first
in film order. `doing` = the same in plain words with progress ("Animating shot 4 of 8", "Making the transitions between
shots: cut 3 of 7", "Recording the voice: line 2 of 8", "Remaking shot 3 (your Fix)", "· rendering 40%"); the `status`
line uses it while a session runs. `before_shots` / `shots_eta_min` = the steps still to come before the first shot and
about how long (minutes per step so far in this project), for stage 3 before any shot exists. The app animates exactly
`nodes` (node area, the preview's shot bar, the chat's "talking about" item) and the stage bar step `step.stage`
(spinner + words, never colour alone) and stops when they leave the list.

Board transitions on their cuts (`src/canvas.mjs` `cutEnds`): a transition node's `from`/`to` (the shots either
side of its cut) come from the board's shot ids (`from_scene`/`to_scene`, or `s03` in `from`/`to`), else the beat it
lands on (`lands_on: "… in B03"`, `to_beat`: the cut into that beat's first shot), else the style frames either side
(`from: "SF01 · …"`, `to: "SF02 · …"`: the cut into the first shot of the next frame's beats); `title` is its name
(`transition` as a string or `{new}`); its version's media is the board's file (`file`/`video`/`clip`/`preview`, else
`out/board/cut-NN.mp4|webm|png|jpg`). The app shows "! Pick one" only on a cut the AI never saw (the order changed or a
shot was added after the board); a cut the board left without a transition is a straight cut.

Beat names (`src/svc/beatnames.mjs`): every beat has a short title for the nodes, the ribbon, the Script panel, the
preview's beats lane and Mortiflix Studio's bins and chapter markers: the script's own `name` (sessions write it in
`script/beats.json`, the owner renames with `script.edit {beat_name}`), else one the user's own AI gave (one short call
for all unnamed beats, once per words, kept in `state/<id>/canvas/beat-names.json`; a `node.changed` with
`{kind: beat, named: true}` rows follows), else a title from the words ("Look up! On a sunny day, the sky is bright
blue." → "The sky is bright blue"), never the first words cut off.

### Loose preview (doc 36)

| Type | Params | Result |
|---|---|---|
| `preview.plan` | `{scope?: all\|from\|shot\|beat, node?}` | `{rev, range: [from, to], length_sec, fps, shots: [{node, start_sec, dur_sec, version, colour, beat_no, media: {kind: video\|still\|card, path, from_sec, to_sec}}], voice[], music, cues[]}`: best media per shot (its piece of the animatic, else its look's still, else a beat card), in film order |

### Into Edit (doc 38)

| Type | Params | Result |
|---|---|---|
| `handoff.plan` | `{}` | `{fcproj, sequence: {name, width, height, fps, length_sec}, tracks, bins, clips: [{node, kind, track, bin, name, label, version, start_sec, dur_sec, media}], markers: [{kind: chapter\|comment, time_sec, name, label, comment}], captions, your_assets, older_versions, cut_on_board, notes, previews}`; `fcproj` = where the app saves the Mortiflix Studio project (the one it saved before, else `<studio>/state/<id>/edit/<title>.fcproj`); transitions carry `native` + the Mortiflix Studio transition name |
| `handoff.done` | `{map: {clips: [{node, version, clip, item}], fcproj?, rev?}}` | saves what the app imported (done once) |
| `handoff.get` | `{}` | `{map}` |
| `handoff.swaps` | `{}` | `{imported, swaps: [{node, version, clip, item, path, from_sec, to_sec}]}`: newer versions to swap in (`clip.replaceFromBin`) |
| `handoff.swapped` | `{node, version, clip?, item?}` | |

#### Finish checks + ArtCraft file (v3, `src/svc/artcraft.mjs`)

| Type | Params | Result |
|---|---|---|
| `checks.run` | `{video?, mix?, fps?, jump_threshold?, jump_frames?, sync_frames?, keys?, boxes?}` (all read from the project when absent: `out/animatic.mp4`, `out/scenes.json`, `voice/timing.json`) | `[{key: jump\|sync\|overlap\|sound, ok, note?, items: [{shot, at_sec, text}]}]`. jump: ffmpeg scene score above the threshold (0.45) more than 3 frames from a planned cut; sync: a scene's `keys: [{word, at_frame}]` against that word's time in timing.json, within 6 frames; overlap: scene `boxes: [{text, x, y, w, h, from_frame?, to_frame?}]` that overlap while both are on screen (no boxes = nothing compared, said in `note`); sound: the mix (or the video's own audio) exists and its loudest point is above -50 dB. No GPU. Every check also carries `checked: bool`; `checked:false` + `reason` (screen-friendly) when nothing was compared (no animatic, no key words, no text boxes, no mix): the screen must not show a green OK for it. |
| `artcraft.write` | `{}` | `{file, clips, tracks, markers, captions, length_sec, sound, map}`: writes the `.mortiflix` project from `handoff.plan` with `mortiflix-studio-cli` (headless, no control port): V1 shots, A1 voice, A2 music, A3 sfx, C1 captions (SRT from timing.json), a marker per scene. Shots with a trim are re-encoded into `<edit>/media`. |
| `artcraft.open` | `{file?}` | `{opened, app}`: launches `mortiflix-studio <file>` detached (never starts the control port); error `make the ArtCraft file first` when the file is missing |

### Smart options (no chat, Redesign parts/95-smart-options.md, `src/svc/options.mjs`)
The app has no chat column: each screen shows up to `options.count` (default 4) Claude-made option buttons (`ui.options` in the app). Role
`options` = Haiku, low effort; cached per state token in `state/options.json`. The chat handlers below stay for the
project log the AI reads; the app no longer calls `chat.send` / `chat.history`.

| Type | Params | Result |
|---|---|---|
| `options.get` | `{stage: script\|voice\|look\|stills\|motion\|sound\|finish, target?: piece id}` | `{token, stage, target, source: cache\|defaults, pending, options: [{id, label, does, cost?: {what, amount, note?}}], questions: [{id, text, choices, default?}]}`. Never waits on Claude: a cache miss answers with the stage's defaults and `pending: true`, makes fresh options in the background (one call per stage+target), then sends `options.ready`. Same token = no call. Demo backend = defaults only |
| `options.run` | `{id, confirm?, confirm_cost?}` | `{done, does, edits: [ids]}`: a Fix with the option's text on each piece it names, or (no piece) an action line the AI reads before its next work. An OK'd piece answers `{asked, text}` first; send again with `confirm: true`. An option with `cost` is refused without `confirm_cost: true`. A stale id (the screen changed) is refused |

Event `options.ready` `{project, stage, target, token}`: fresh options are made, call `options.get` again.
Questions shown with the options are answered with `chat.answer`.

#### Review size settings (`src/svc/reviewsize.mjs`; owner 2026-11-01: "let them set how many options they would like to see", "how many they want each review")
User settings in `config.json` (no project-level override). Whole numbers only; anything else is refused with `UserError` "`<key>` is a whole number from A to B" and nothing changes. A hand-edited value out of range reads as the default.

| Key (config.json) | Range | Default | Effect |
|---|---|---|---|
| `options.count` | 1-8 | 4 | `options.get` returns at most this many options (defaults and Claude-made); Claude is asked for "up to N". Part of the state token: a new count makes the options again. |
| `review.framesPerRound` | 1-6 | 3 | Style frames written per round (`planFrames` `perRound`). Read when the frames are planned (first Look write); frames already planned keep their rounds. |
| `review.scenesPerGroup` | 1-6 | 1 | Scenes whose stills are written, drawn and checked together. `stills.get` `groups[]` hold N scenes each (`beat` = first, `beats` = all, `lines` = every line); the next group starts after the last OK of the group. No "all": 6 is the most. |

| Type | Params | Result |
|---|---|---|
| `settings.get` | `{}` | `{options: {count}, review: {framesPerRound, scenesPerGroup}}` (a FAST read) |
| `settings.set` | `{options?: {count}, review?: {framesPerRound?, scenesPerGroup?}}` | the same object after the change; a missing key stays as it is; event `settings.changed` with that object |

### Chat (doc 37)

| Type | Params | Result |
|---|---|---|
| `chat.send` | `{text, context?: Context, confirm?}` | `{queued, move?}`. In a node context the text is a Fix there (an OK'd piece asks first; send again with `confirm: true` for "Remake it"). In the whole video the user's Claude Code answers (`chat.typing`, then `chat.message`) and may make one move (a Fix or an answer) |
| `chat.history` | `{limit?, before?}` | rows `{id, at, role: user\|ai\|system\|action\|stage, text, context?, card?, refs?, edit?, question?, stage?}` |
| `chat.action` | `{text, context?, refs?}` | a grey action line |
| `chat.context` | `{context}` | the "talking about" target, echoed as a `chat.context` event |
| `chat.answer` | `{question, value}` | answers an open question |
| `questions.list` | `{}` | the project's questions |
| `activity.list` | `{limit?}` | the session's recent activity (Details) |
| `work.get` | `{}` | the `work.active` data now, plus `drain` (see `service.drain`, null when no drained restart is under way) |
| `service.drain` | `{}` | `{draining: false}`, or during a drained restart (`service.restart {drain: true}`) `{draining: true, waiting_for: [project ids], titles: {id: title}, started_at, wait_min}`; pushed as the `service.drain` event when it starts and when `waiting_for` changes. No new session starts while draining. |

`Context` = `"video"` (the whole video), a piece id (`s01`, `b02`, `sf01`, `b01-2`, `m01`, `music`, `a01`), a cut with no
transition yet (`cut:s02:s03`: the node area's cut pills; a typed message about it goes to the AI, or is a Fix on the
transition once the board has one) or a stage (`stage:look`). Case-insensitive; anything else is `bad_request`. The app
sends only these (`chat::model::context_param`; an odd selection is sent as `video`).

Cards: `script {beats}`, `looks {frames, using}`, `shots`/`transitions {nodes}`, `submission {items, questions}`,
`question {id, choices, default}`, `defaults {questions}`, `versions {edit, refs}`, `themes`, `confirm {node, text}`.

### Render queue and export (doc 39)

| Type | Params | Result |
|---|---|---|
| `render.list` | `{project?}` | every job in the one queue (session renders and app exports) |
| `render.add` | `{label, kind?: export, pid?}` (pid = the app process doing the render; if it dies the job fails, never stays running) | a job for the app's own Mortiflix Studio export; start it when its `render.job` event says `running` |
| `render.progress` | `{id, done, total, phase?}` | |
| `render.finish` | `{id, ok, file?, error?}` | |
| `render.cancel` | `{id}` | waiting: never starts; running: stopped (an app job gets `state: failed, cancelled: true`) |
| `final.status` | `{}` | the finished video's truth: `{state: none\|rendering\|done\|stale, file?, made_at?, length_sec?, size?, progress?: {done,total,phase}, job?, queued?, renders_ahead?, error?, stale_why?}`. `rendering` = a `Final video` job is waiting or running in the render queue (`progress` from the job; `queued` while it waits). `stale` = any input (animatic, final mix, a shot/voice/music file, voice timing) is newer than the file. `error` = the last try failed. |
| `final.make` | `{}` | queues one ffmpeg job (label `Final video`; free, local, no Chrome) and returns `final.status` plus `job`; already running -> `already: true`. Picture: `out/animatic.mp4` copied without re-encoding, else the shots' video clips joined and encoded (a shot with no video yet -> an error naming it: make the shots first). Sound: `out/sound/final-mix.wav`, else the animatic's own sound. Captions: the handoff plan's captions as a soft subtitle track when there are any. Written to `<studio>/projects/<id>/out/final/final.mp4` (via `final.part.mp4`, moved into place only on success), where the bridge `/file` route serves it. |
| `final.cancel` | `{}` | stops the waiting/running `Final video` job -> `{cancelled, job?}`; an earlier `final.mp4` is left untouched |
| `export.target` | `{ext?, name?, stems?, create?}` | `{dir, file, name, reveal}`: `<Videos>/Mortiflix/<Project>/`, never over an existing file |
| `export.done` | `{file, preset?, timeline_rev?}` | copies the render into the project's record and delivers the project |
| `publish.plan` | `{to, profile?, title?, description?, at?, timezone?}` | what would be posted |
| `publish.send` | same + `confirm: true` | posts (only with the owner's confirm; refused with `by: "ai"`) |

### Setup (part 09)

| Type | Params | Result |
|---|---|---|
| `setup.status` | `{}` | `{backend, backends, claude: {found, path, version, logged_in, auth_method, subscription, login_command, detail}, keys, voice, tools: {node, ffmpeg, ffprobe, installable, studio}, videoNotes: {enabled, ready}, first_run}` |
| `setup.backend` | `{backend?: claude-code\|anthropic-api\|demo, claudeBin?}` | `{backend, claudeBin}`. `claudeBin` = `claude` or an absolute path (the app finds it where a desktop app's PATH doesn't look) |
| `setup.done` | `{done?: true}` | first run finished |
| `setup.claude.test` | `{}` | `{ok, reply, seconds}`: one short `claude -p` with no tools |
| `keys.list` | `{}` | `[{id, name, for, get, set, source}]`, never the values |
| `keys.set` / `keys.remove` | `{id, value}` / `{id}` | `anthropic`, `elevenlabs`, `uploadpost`, `postiz` (secrets.json) and `gemini` (session.env) |
| `keys.check` | `{id}` | a free check of a saved key (network, only on request) |
| `components.status` | `{}` | `{components: [{id, name, for, what, where, size, default, needs, installed, detail, path}], installing: [id]\|null}`: the installer's components (blender, blender-addons, chrome, strudel, transitions, uv, qwen-tts, comfyui). The local voice (`qwen-tts`) needs no ComfyUI; ComfyUI is `installed` only when it is the studio's own (`tools/ComfyUI`): another server on its port is not counted |
| `components.install` | `{ids?: [id] \| "default" \| "all"}` | `{started: [id]}` at once; then `components.progress` events and one `components.done`. `busy` while one runs. A failed component never stops the others |
| `setup.download` | `{label?, files: [{url, dest, size, sha256}]}` | `{job}`: https only, `dest` absolute; each file streams to `<dest>.part`, size + SHA-256 checked, then renamed; files already there are skipped. Only after the user said yes (the app shows size, source, licence) |
| `setup.install` | `{tool}` | `{job}`: one of setup.mjs's components (`TOOLS`: chrome, strudel, transitions, blender, blender-addons, browser-harness, qwen-tts, comfyui, daw-engine, craft) with its own installer (`installTool`), after the user said yes |
| `setup.cancel` | `{job}` | `{cancelled}` |

`tools.engine` = `{ok, path}` (the sound engine). `MFX_FAKE_DOWNLOADS=1` (tests only): `fake:<bytes>` URLs and a pretend Chrome install.

## Events

| Event | Data |
|---|---|
| `status` | `{line, stage, project, stages: [StageStatus × 6], state, needs_you, title}`: sent when anything in it changes |
| `usage.changed` | `{at, project, provider, kind}`: new usage ledger rows (at most once a second); ask `usage.get` again |
| `project.changed` | `{id, state, needs_you, deliverables}` |
| `chat.message` | a chat row (see `chat.history`) |
| `chat.typing` | `{on}` while the AI writes a reply |
| `chat.context` | `{context}` |
| `script.changed` | `{project, beats, changed, added, keys, deleted, restored, renamed, remaking}`: the owner saved script edits (the `script.edit` result) |
| `look.changed` | `{project, using?, from?, remaking?, making?}`: the look in use changed (`look.use`) or more looks were asked for (`look.more`) |
| `node.changed` | `{project, rev, nodes: [{id, kind, current, state, owner, missing}]}` (`all: true` on the first look at a project) |
| `activity` | `{project, t, kind: text\|tool\|todo\|info\|error, text, todos?}` |
| `assets.progress` | `{project, asset, name, done, total}` |
| `assets.added` / `assets.failed` | `{project, asset, replaced?}` / `{project, path?, asset?, message}` |
| `setup.progress` | `{job, kind: download\|install, label, state: running\|done\|failed\|cancelled, line, done?, total?}` |
| `render.job` | a queue job `{id, label, state: waiting\|running\|done\|failed, project, external?, kind?, progress?, file?, error?, cancelled?}` |
| `work.active` | `{project, running, step: {key, name, stage, kind, state, version} \| null, nodes: [{id, kind, what: making\|remaking, v, edit?}], current, doing, progress: {done, total, noun} \| null, shots_eta_min, before_shots[]}`: what the AI is working on now (`src/svc/work.mjs`), sent when it changes and on `hello` |
| `components.progress` | `{id, phase: start\|line\|done\|failed\|skipped, name?, size?, line?, detail?, error?, seconds?}` |
| `components.done` | `{results: [{id, ok, detail?, error?, problems?, seconds}], error?}` |

## Usage ledger (the token counter, `src/svc/ledger.mjs`)

One append-only file, `<studio>/state/usage-ledger.jsonl`, one JSON row per spend. No dollars anywhere (owner, 2026-11-02): Claude is counted in tokens, ElevenLabs in credits.

Row: `{id?, at, project|null, stage|null, provider: 'claude'|'elevenlabs', kind, model|null, role?, ok}` plus, for Claude, `input_tokens` (fresh input only), `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `calls?`; for ElevenLabs, `credits`, `seconds?`. `kind`: Claude `session` or `quick call` (`role` = the studio role such as `chat`, `options`, or the backend for a session); ElevenLabs `tts`, `tts sample`, `music`, `sfx`. Rows with an `id` are booked once, however often they are offered.

What books rows:
- Claude Code and API sessions: at the end of every run (`runSession`), its transcript is read and one row per Claude process (quick calls, the session) and model is booked. Stopped or crashed runs count too (`ok: false`).
- Quick Claude calls: `askAI`, `askAnon`, `quickReply` (Claude Code `--output-format json` usage per model, or the API response's `usage`): Haiku options, `brief.improve`, chat, beat names, lessons.
- ElevenLabs: voice lines (`logVoiceUse`; credits from the `character-cost` header, else characters, halved for flash/turbo models), music cues (`music.cue.make`), sound effects (`sfx.make`), and "Try it" voice samples (web and CLI). Cache hits cost nothing and are not booked.
- Session-side scripts (`voiceover/vo.mjs` speech and speech-to-text check, `voiceover/sound.mjs` sfx and music) append their own rows through `src/voice/spend.mjs` (ledger file from `MFX_LEDGER`, project from `MFX_PROJECT`, else from the working folder; stage from the kind). Kinds `tts`, `scribe check`, `sfx`, `music`. Credits come from the response's `character-cost` header; with no header the row carries the estimate and `estimated: true` (music 33 credits a second, speech 1 per character, half for flash/turbo), and a speech-to-text check with no header has `credits: 0, credits_unknown: true`. The service notices rows other processes append within 5 s and sends `usage.changed`.
- Music cues and sound effects made by the studio read the header too; `estimated: true` marks a row whose credits are the estimate.
- Claude sessions are booked as they run (every 60 s) and once at the end, by delta: only tokens not already in the ledger for that run, process and model are added, so a crash loses at most the last minute and nothing is counted twice. The session's output tokens are a per-call estimate until the run's result line gives the exact total; the estimate already booked is kept.
- Backfill: the first time a studio's ledger is touched, what the studio already kept is booked once (session transcripts, each project's voice usage log, music and sound call logs). Ids make it safe to run twice; `usage-ledger.backfilled` marks it done.

| Request | Params | Answer |
|---|---|---|
| `usage.get` | `{range?: 'today'\|'week'\|'month'\|'all', project?}` | `{range, project, since, rows, totals, by_project, by_stage, by_model, series, records, elevenlabs_balance, elevenlabs_balance_why}`. `range` defaults to `all`; `week` = last 7 days and `month` = last 30 days, counting today (local days). Every group is `{claude: {calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, rows}, elevenlabs: {calls, credits, rows}}`; `by_project` adds `project` (null = no project), `by_stage` adds `stage`, `by_model` adds `provider, kind, model`; all sorted biggest first. `series` is the last 30 days, oldest first, every day present (zeroes included), same group shape plus `date`; it follows `project` but not `range`. `records` (all time, `project` applies): `biggest_day {claude\|elevenlabs: {date, ...group}\|null}`, `biggest_project` (same with `project`), `biggest_call {claude: row, elevenlabs: row}` (most tokens / most credits), `longest_streak {days, from, to, current}` (consecutive days with any spend; `current` = the run ending today or yesterday). `elevenlabs_balance`: `{remaining, limit, used, tier, resets_at, checked_at, stale?}` read from `/v1/user/subscription` at most every 10 minutes, or `null` with the reason in `elevenlabs_balance_why` (no key saved, ElevenLabs unreachable...); a failed refresh keeps the last balance marked `stale: true`. Read-only (fast lane). |

Event `usage.changed {at, project, provider, kind}`: after new ledger rows, at most once a second; ask `usage.get` again.

## Engine changes behind it

- `pipelines.mjs`: a step can be `off` (skipped at start) and name its `stage`; presets carry `look`, `voice`,
  `music_theme`, `based_on`.
- `canvas.mjs` `requestNewPiece`: an edit request for a new shot (duplicate / insert).
- `renderq.mjs`: app jobs (`addExternal`, `report`, `finish`), `cancel`, `list`.
- `torch.mjs`: the session's brief gets the owner's assets, the music theme, the preset's look and voice, and the
  chat since the last session (`svc/brief.mjs`).
- `backends/demo.mjs`: voice lines with clips and a quiet score (so every lane has something), new shots, line remakes.
- Policies in the service: a questions step waits for the owner's answers in the chat (its card has `waiting: true`;
  once every question is answered the step is approved with those answers; `config.mfxQuestionsBlock: false` goes on
  with the defaults at once instead), and a stage the owner moved on from keeps what arrives.

## Music cues (ElevenLabs music, `src/svc/elmusic.mjs`)

Files in the project's work folder: `music/cues.json`, `music/calls.jsonl` (every ElevenLabs call), `music/<cue>.mp3`, `out/voice/mix.wav`.
A cue: `{id: "mc01", from_sec, to_sec, mood, prompt, energy 0-1, crossfade_sec, duck_db, state: planned|made|ok|stale, length_sec, credits, path?}`.
All answers carry `{enabled (Eleven Music on in Settings), key, mix, total_sec, source: ai|beats, credits_per_sec, cues}`.

| Type | Params | Answer / notes |
|---|---|---|
| `music.plan.get` | `{project?}` | the stored plan (empty `cues` before one is made) |
| `music.plan.make` | `{project?}` | one quick AI call over the script beats + `voice/timing.json`; cues cut at scene starts, none under 3 s; falls back to `source: "beats"` when the AI gives nothing; error `no_voice` before the voice exists |
| `music.cue.set` | `{cue, mood?, prompt?, from_sec?, to_sec?, energy?, duck_db?, crossfade_sec?}` | `{cue}`; new words or length marks made music `stale`. Same type as the score's `music.cue.set`: cue ids `mc01...` come here, `m01...` go to the score's handler |
| `music.cue.make` | `{cue, confirm?}` | without `confirm:true`: `{needs_confirm, seconds, credits_estimate}` and no call. With it: POST /v1/music (music_v2_5, instrumental, length = cue + crossfade tail), logged; 401/402/429 stop at once (`billing`), other failures retry once; `music_off`, `no_key` |
| `music.make` | `{project?, confirm?}` | every cue not made yet (or stale), one after another, the library first; without `confirm:true`: `{needs_confirm, cues, credits_estimate}` and no call. v3: `step.confirm_cost {step:'music'}` starts it (the voice step makes the music; the OK is booked on the voice step) |
| `music.cue.ok` | `{cue}` | approves a made cue (`not_made` before) |
| `music.mix` | `{}` | ffmpeg: narration + made cues, crossfaded, music ducked by `duck_db` while words are spoken (timing.json), loudnorm -14 LUFS → `{path}`; `no_music`, `no_voice` |

Event `music.changed {project}`. `makeMusicPlan({root, id}, {ask?})` is exported for the v3 runner.
### Lessons, notes and scene by scene (v3, src/svc/lessons.mjs)
Lessons live in `<studio>/lessons.json` (scope "all") and `state/<id>/lessons.json` (scope "project"): `{id, text, section, on, source:{project,node,note,frame,at}, approved, used}`. Approved + on lessons go into every stills / animatic prompt and the session brief (`lessonsBlock`).
- `lessons.list {scope?: all|project|both, project?}` -> `{lessons:[...+scope], counts:{total,on,off,waiting,sections}}` (waiting ones first). A lesson made from a note has `source.image`: the path of that note's marked frame (read side only)
- `lessons.propose {note, node?, frame?}` -> `{lesson, how: ai|words}` (one quick AI call; the owner's own words if none). Proposed = not approved, project scope.
- `lessons.approve {id, scope?: all|project}` ("Approve" = all projects, "Only in <project>" = project: the project the note came from, `source.project_title` in `lessons.list`) · `lessons.edit {id, text?, section?, scope?: all|project}` (scope moves it; a project lesson lives in the project its note came from) · `lessons.toggle {id, on?}` · `lessons.delete {id}` (kept in `<studio>/lessons-trash.json`) · `lessons.restore {id}` (Undo of a delete) · `lessons.import {path}` (a What Have We Learned .md: approved, on, scope all; one time, no doubles). Event `lessons.changed`.
- `notes.save {node, time, frame?, text, image_png_base64, audio_base64?, audio_ext?}` -> `{note, lesson, edit}`: stores under `state/<id>/notes/`, sends a `node.edit` fix with the words + picture path, proposes a lesson. `notes.list {node?}`.
- `motion.scene.get` -> `{current, total, mode: "one"|"all", animatic: <abs path or null>, scenes: [{beat, name, state: ok|making|review|waiting, clip: {file (abs path), from, to} or null}], lessons_waiting}`. State is `mfx.motion_scenes = {current, done[], built[], mode}` (old `motion_first` migrates).
- `motion.scene.approve {beat}` -> the state + `{approved, next, rest}`: marks the scene done and builds the NEXT scene only (animatic restarted, with every approved lesson). With no scene left the animatic can be approved.
- `motion.scene.all {confirm?}`: without `confirm: true` -> `{needs_confirm: true, warning, rest}` and nothing is built; with it, mode `all` and every remaining scene is built in one go. Never batch otherwise.
- `motion.first.get` / `motion.first.approve {approved?}`: aliases (approve = `motion.scene.approve` on scene 1).
- `notes.save {..., send: false}` keeps a note pending; `notes.send {node}` -> `{sent, notes, edit}` sends every pending note of that scene as ONE fix; `notes.delete {note}`.

### Video Notes (the owner's tablet), opt-in

The owner can review each Motion scene in the Video Notes tablet app. Off by default: `config.videoNotes = {enabled: false, folder: null}` (folder null = the Video Notes folder in Morti Drive, `VIDEO_NOTES_DIR` or `~/MortiDrive/files/Video Notes`, the one the video-notes MCP uses). It is a first-run setup step (`setup.status.videoNotes = {enabled, ready}`) and a Settings page. No port is opened: the tablet reads Morti Drive over Tailscale (`https://<name>:8443`) or the home door on the LAN (`http://<ip>:8443`). The files are exactly the MCP's (`queue.json`, `<id>/video.mp4 poster.jpg audio.wav transcript.json status.json notes.json snaps/`), so the app needs no change.

- `videonotes.status` -> `{enabled, folder, addresses: [{kind: "tailscale"|"local", url, reachable}], tablet_seen: ISO time the tablet last touched a queued video (progress/status/notes file) or null, problems: [plain words]}`. Addresses come from `tailscale status --json` and the LAN interfaces; each is pinged at `/lan-ping`. Anything missing (Tailscale not installed or off, no LAN address, door not answering, folder not writable or outside Morti Drive) is a plain sentence in `problems`.
- `videonotes.setup {enabled, folder?}` -> the same as `videonotes.status`. Saves the config; a folder that cannot be made or written is refused.
- When enabled and a scene becomes `review`, the studio queues it: title `<project short title> \u00b7 Scene N`, project = the project title, one plain `look_for` line (scene N of M, count of lessons it was made with), the scene's narration as `transcript.json` (frames relative to the clip), an H.264 MP4 with sound (the clip is copied when it already is one, else converted once, 15 min limit). The id is kept on the scene: `mfx.motion_scenes.tablet[beat] = {id, status, notes, imported[], handled, prev[]}`. A fixed version queues a new item (older ids in `prev`).
- `motion.scene.get` -> each `scenes[]` also has `tablet: {id, status: "to review"|"reviewing"|"done", notes, handled} | null`, so the app can say "On your tablet: reviewing". Notes on a `reviewing` item can still change: nothing is imported yet.
- On the service tick (two stats per waiting scene, nothing when unchanged) a queued scene whose status becomes `done`: each tablet note is saved as a pending note on that scene (`notes.save`-equivalent, `send: false`: text, frame and time, the marked snapshot as the note image `.jpg`, `tablet: "<id>/<note id>"`; a lesson is proposed as for app notes), never the same note twice. With notes -> ONE fix (all notes in one `notes.send`-style fix) that remakes the CURRENT scene: it shows `making`, then comes back to `review` and is queued to the tablet again as a new version. With none -> `motion.scene.approve`, which makes the NEXT scene. If the scene was already settled in the app, the notes are only kept.
- Approve or fix in the app first (`motion.scene.approve`, `notes.send`): the tablet item's `status.json` is set to `done` (the file the app itself writes) so it stops showing as to-review, and the scene is no longer watched. Notes still only on the tablet at that moment are not imported.
- `videonotes.resend {project, scene}` -> `{scene, tablet: {id, status, notes, handled}}`. Queues the scene's CURRENT clip on the tablet again (same item and `ok_words` as the first send) and replaces that scene's previous open item (not done, not handled) in the tablet queue, so it is never listed twice. A done or handled item stays in the queue and goes to `prev`. Refused (`UserError`, plain words) when Video Notes is off, the scene is unknown, or it has no clip. Emits `videonotes.changed`.
- `motion.scene.get` -> a scene whose `state` is `making` also has `eta_s`: seconds left, the median of this project's past scene make times (kept in `mfx.motion_scenes.make = {since{beat: ms}, secs[]}`, last 20) less the time already spent, floored at 0; `null` when no scene of the project has been timed yet. Other scenes have no `eta_s`.
- Event `videonotes.changed {project}` when a scene is queued or its tablet status or note count changes (and `{}` after `videonotes.setup`).
## v3 stages (`pipelines/v3`, `stage_set: "v3"`)

A project's stages come from its pipeline. The explainer and every other pipeline keep the eight stages (`script, voice, styleFrames, transitions, animatic, music, edit, render`, indexes 0-7). A pipeline with `"stage_set": "v3"` has seven. `stage.status`, `stage.set`, `stage.remakes`, `stage.reopen`, `status` events and `mfx.stage` / `mfx.stages_done` use them for that project.

| index | key | name | steps | what its count shows |
|---|---|---|---|---|
| 0 | `script` | Script | brief, script | scenes (`beat` nodes) |
| 1 | `voiceMusic` | Voice & music | voice (narration + music plan) | voice lines + music cues |
| 2 | `look` | Look | style-frames | style frames |
| 3 | `stills` | Stills | stills (one per spoken line) | steps (stills are not canvas nodes) |
| 4 | `motion` | Motion | animatic (one scene at a time) | shots |
| 5 | `sound` | Sound | sound | steps |
| 6 | `artcraft` | Artcraft | artcraft (delivering) | steps |

The app's stage bar shows indexes 0-5 (Script ... Sound); index 6 is the delivering step (Artcraft final) and belongs in "N of M OK" only if the app wants the final counted. `stage.status` returns an array of 7 `StageStatus` for a v3 project (8 for the others), each with the old fields plus `index`, `name` and `set` (`"v3"` or `"explainer"`), so the chrome can read names and counts from it instead of hard-coding them. `stage.set` and `stage.reopen` accept the index or the key; `stage.set` returns `{stage, key, ...}`. Unknown index: error `stage must be 0-6 or a stage key`. No edit/render handover exists for v3 (`stage.handover` skips nothing).

Gates: Motion is held while scenes are left to approve one by one. The animatic builds only the current scene (its clip is out/scenes/<beat>.mp4, joined with the approved clips into out/animatic.mp4; approved scenes are never re-rendered, and motion data is probed only for the new scene's frames). Until every scene is OK, `respond approve` on the animatic is refused and Next on Motion leaves it in review. Lessons are given to the prompts as mistakes never to repeat; approved scenes only as continuity, never as motion to copy.

The studio does these v3 steps itself (no session, nothing paid): `stills` (stills.make with Kinetograph), `sound` (sfx.plan.make + a mix of library sounds; new sounds stay `planned` until `sfx.make` with `confirm: true`), `artcraft` (checks.run + artcraft.write, never launches ArtCraft; needs `mortiflix-studio-cli` on PATH or `MFX_STUDIO_BIN`). After the voice step is in review, the music cue plan is written (`music.plan.make`, plan only, whatever `config.voice.elevenlabs.music` says: the v3 voice step makes the music). Making the cues needs the owner's cost OK (`step.confirm_cost {step:'music'}` or `confirm` on a cue). The voice step is not approved (Approve or every line OK) while no music is planned; the `sound` step waits (needs_you) until every cue is made and OK'd (`svc/musicneed.mjs`); `music.plan.get` says `expected` and `making`. The app asks for no look or motion pick in v3: once a v3 step waits only for that pick (after an approve, or on `project.open`), "the AI decides" is saved for it (`svc/v3briefs.mjs`) and the step starts; a pick the owner made is kept.

## Sound (v3 stage 6, `src/svc/sfx.mjs`)

Sound effects are made after the motion, on each action's frame and as long as the motion. Files: `sound/sfx-plan.json`,
`sound/sfx/<id>.mp3`, `sound/calls.jsonl` (every paid call), `out/sound/final-mix.wav`. Action times come from
`video/src/actions.json` (`[{shot, at_sec|at_frame, dur_sec?, what, sound?}]`, written by the motion step) or, failing that, the
`cues` block of `video/src/timing.ts` over the narration's word timings. Library: `~/MortiDrive/files/Sound Effects/ElevenLabs/index.json`
(`MFX_SFX_LIBRARY` overrides).

| Type | Params | Result |
|---|---|---|
| `sfx.plan` | `{}` | saved plan `{shots, cues, summary}` or `{cues: [], ready, can_plan, why?}` (`can_plan` = the motion has timed moments; `why` = what is missing when it has not) |
| `sfx.plan.make` | `{library?}` | builds the cue list; `not_ready` without motion. Cue: `{id, shot, at_sec, dur_sec, what, prompt, source: library\|generate, library_file?, gain_db, status: planned\|ready\|ok\|cut, file?}`. Re-plan keeps edited/made cues |
| `sfx.make` | `{cue \| all, confirm?}` | without `confirm`: `{confirm_needed, calls, credits}` (20 credits per second), no network. With: makes the new ones; 401/402/429 stop at once (`stopped.billing`), other errors retry once then stop; each call logged |
| `sfx.set` | `{cue, prompt?, at_sec?, dur_sec?, gain_db?, source?}` | edit; a new prompt/length drops the made file |
| `sfx.ok` / `sfx.cut` | `{cue}` / `{cue, cut?: false}` | keep / drop a cue (cut false = restore) |
| `sfx.mix` | `{}` | ffmpeg: `out/mix.wav` (voice+music) else narration + every kept sound at its time -> `out/sound/final-mix.wav` |

Pipeline step for the orchestrator: `{"key":"sound","name":"Sound","stage":"sound","review":"audio","work":["audio"],"after":["animatic"],"describe":"..."}` (stage list needs a 'sound' entry after motion; stages.mjs not touched).

## Style frames and stills, v3 (branch v3/styleframes; plan: Design Docs/Mortiflix Redesign/parts/90-style-frames.md)

### Packs (spec 2)
- `packs.list {kind?}` -> every pack: the old fields plus `style` (style packs: `{palette: [{hex, job, rule}], type: {heading, body}, shapes, mood, words}` or null; this used to be dropped), `spec`, `share`, `counts` (files by kind), `brings` (the card line, "2 fonts · 6 colours · 14 icons"). The file list is not in `packs.list`.
- `packs.files {kind, id}` -> `{kind, id, files: [{rel, kind, ext, size}], counts, brings}`. A pack may hold ANY file. A file's kind is `font | texture | icon | picture | model | document | audio | video | layout | other`: its folder first (`fonts/`, `textures/`, `icons/`, `images/`, `models/`, `docs/`, `layouts/`), its extension second.
- New pack kind `assets` (`packs/assets/<id>/`, same folders, no `style` object). A project picks one style pack and any number of `assets` packs: `packs: {style: "id", assets: ["a", "b"]}` in `project.create` / `setProjectPacks`; saved as `mfx.packs.assets = [{id, name}]`.
- The principles the frame and inspection prompts read are `pipelines/v3/design/{PRINCIPLES,STILLS,INSPECTION}.md`, copied word for word from the owner's board by `node tools/board-extract.mjs` (prints a diff when the board changed; `--check` writes nothing).

### Asset pool (svc/pool.mjs)
- Built from the project's style pack, its `assets` packs and the default texture pack (13 CSS/grain textures: halftones, gradients, grid, scanlines, grain; shipped in code, `pooldefaults.mjs`). Writes `design/pool.json` (one row per asset with a stable id), copies the drawable files to `video/src/public/pool/` (Kinetograph's `staticFile` reads the public folder beside the entry file: checked by a real render) and writes `video/src/pool.ts` (`asset(id)`, `tex(id, opts)`, `font(id)`, `color(id)`, `<Icon id>`, `POOL`). Claude refers to assets by id only; `checkAssetRefs` makes "no missing assets" a lookup.
- Row kinds: `color:<job>` (hex, job, rule) · `font:heading|body|<family>-<weight>` (file, or `source: "google-fonts"` when the pack ships none) · `icon:<name>` (svg paths as data, recoloured by code; svg icons with `<text>` are refused) · `tex:<name>` · `img:<name>` · `layout:<name>` (regions) · `model:<name>` (a Blender still; `note` when it could not be drawn) · `doc:<name>` (text; pictures inside a PDF/DOCX/ODT/PPTX become `img:` rows). Files not drawn in a still (audio, video, unknown types) are listed in `skipped` with the reason. A font file that is not a real font is skipped (it would stop the whole render).
- `pool.get {project?}` -> `{project, packs, assets (no text/shapes), skipped, lines}` (builds first when empty; `lines` = the short lines the AI is offered, capped at 150 by scene words). `pool.build {force?}` -> `{rebuilt, assets, skipped}`. `project.packs.assets {assets: [ids]}` changes the asset packs after the start and rebuilds. Event `pool.changed {project}`. The pool is rebuilt only when pack files change (hash).

### Measured checks (svc/inspect.mjs; used by the style frames and stills)
Run on every rendered frame, exact, a hard gate (the AI cannot pass a frame that fails): `text-safe-area` (text boxes from `kinetograph inspect` at least 5% inside each edge), `no-collisions` (texts overlapping, a text out of its panel/picture, something painted over a text), `text-contrast` (from the RENDERED PIXELS: the text colour found in the box against the ring of background around it, 4.5:1, 3:1 from 36 px), `no-missing-assets` (ids in the code against the pool and its files), `no-layout-errors` (Kinetograph's "not drawn" warnings from the render output), `key-words` (stills). The inspect result is saved as `out/frames/sf<NN>.inspect.json`. Note: the installed Kinetograph's `inspect` gives every text box but an EMPTY `text.text`, no colour and no font size, so words come from the frame's code (`texts.basis: "code"`) and colour from the pixels; a build that fills `text.text` is used as it is (`basis: "inspect"`).

### Style frames, rounds of 3 (svc/frames.mjs, src/quickframes.mjs)
The Look is made in rounds of 3 frames. The studio plans the frames from the script's parts (`planFrames`: one frame per part, consecutive parts shorter than 5 s share one, at most 12; `hold_s` = how long that part of the video is, so a long part holds its frame longer: there is no set length per frame). One Claude call writes a round (static block A = role + Kinetograph contract + the owner's `PRINCIPLES.md`, byte-identical, passed as `--append-system-prompt-file` so it is cached; the message = project block B: look, the pack's colour jobs/rules, pool lines, the plan; and round block C: lessons, the owner's notes on the frames before, the OK'd frames, the targets). The studio renders each frame (`out/frames/sf<NN>-v<N>.png`, old versions kept), measures it (inspect.mjs; failures go to a small fix call, at most 3), then submits the step so the owner can check each frame. Usage per round (input, output, cache read) is in `frames.get.usage`, the project JOURNAL and the activity line.
- State: `design/frames-state.json` (every frame: `id, composition, label, beats, hold_s, round, state: todo|writing|review|ok|fix|skipped, current, versions[{v, file, notes, measured}], why, note, fix_notes`). `design/frames.json` is the canvas's and later steps' view (only frames that have a picture, `file` = the current version). `src/scenes/frames.tsx` is written by the studio as the index of the per-frame files `src/scenes/sfNN.tsx` (`export const SFNN`), so the transitions and the animatic still read `frames`.
- `frames.get` -> `{project, planned, enough, total, ok, round, rounds, waiting_for: "you"|"studio"|"done", ok_words: {notes, none}, frames: [{id, label, beats, hold_s, round, state, version, versions: [{v, path, notes, ok, problems, inspection}], path, why, note, pool_assets, pending_notes, notes_total}], usage, lessons_waiting}`. `ok_words` are the words the OK button shows with and without notes.
- `frames.ok {frame}` -> the view + `{approved, next: "round"|"wait"|"done"}`. Only a frame in `review`. When every frame so far is OK and more are planned the step is restarted and the next round is written (`next: "round"`).
- `frames.fix {frame, text?}`: the pending notes on that frame (`notes.save {node: "sf01", send: false}` as for scenes; `text` is saved as one more) go as ONE fix; the frame is remade as a new version, alone. Each note becomes a waiting lesson on the Lessons page as before. Returns `{fixing, notes}`.
- `frames.enough`: stop making frames; the rest are `skipped`; the Look can then be approved. Without it, approving the style-frames step (`gates.respond` approve) is refused while any frame is open.
- Events: `frames.changed {project, frame?}`, `lessons.changed`.

### AI inspection of each frame (quickframes.mjs, plan 90 §1.5 layer 2)
After the studio's measured checks pass, a FRESH Claude call inspects each frame: the static part is the owner's `INSPECTION.md` (copied from the board, cached via `--append-system-prompt-file`), the message names the frame, the one full-size picture (opened with Read), the measured results and only the code that changed. It answers per board section (`visual_design`, `typography`, `technical_quality`, `narrative_quality`, and `transition_compatibility` only when an OK'd frame before it exists) with pass/fail and a specific correction; on a fail it returns the fixed files whole and the studio draws the frame again (same version, measured again). At most 3 rounds. Still failing: the frame is `held` (state `held`, `held: [plain-words items]`, picture shown) and the owner decides: `frames.send_anyway {frame}` (it becomes `review`, `inspection.sent_anyway: true`) or `frames.retry {frame}` (the items go back to the writer as corrections, a new version). A frame that fails the measured checks is never held or shown: after 3 fix calls the step pauses (give). The inspection is in `frames.get` per version: `inspection: {rounds, sections: {name: {pass, note, correction?}}, unresolved[], held?, sent_anyway?}`.

### Video Notes image items (svc/videonotes.mjs; plan 90 §2)
- `queue.json` items may now carry (all optional, old readers ignore them): `kind: "image"` (missing = video), `image` (the full-size PNG, at most 2560 on the long side), `w`, `h`, `group`, `group_index`, `group_count` ("Frame 1 of 5" on the card), and `ok_words: {notes, none}` (the words OK shows with and without notes). `ok_words` is now written on EVERY item the studio queues: Motion scenes `OK · Remake scene N` / `OK · Next scene` (`OK · Done` on the last scene), style frames `OK · Remake this frame` / `OK · Next frame` (`OK · Done` on the last, `OK · Next group` for a group), stills `OK · Remake this still` / `OK · Next still`; other videos (the MCP's `add_video`) `OK · Send my notes` / `OK`. An image item also has `video` (a 1-second H.264 clip of the picture, even sizes), `audio` (silence) and `poster`, so an older tablet app can still open and mark it. `notes.json`, `status.json`, `snaps/`, `progress.json` are unchanged; the `f` and `t` of a note on an image item are ignored (stored as 0).
- `queueImage(root, id, {kind: "frame"|"still", ref, file, title, look_for, group?, group_index?, group_count?, ok_words?})` and `queueFrames(root, id, [sf01..])` (called by the style frames step when frames reach `review`, only when Video Notes is on; the Video Notes folder is the owner's setting: tests use a temp one).
- The tablet map is generalized: one entry per thing under review keyed `scene:b03` (kept in `mfx.motion_scenes.tablet`, as before), `frame:sf01` or `still:b01-2` (kept in `mfx.tablet`). `pollTablet` still costs two file stats per waiting item. `status: "done"`: with notes -> each note is saved once on the thing (`notes.save` equivalent, node = its ref, frame/time 0 for a picture) and THAT thing is remade (`motion.scene` send / `frames.fix`); with none -> OK (`motion.scene.approve` / `frames.ok`, which starts the next round). If the owner already settled it in the app, the notes are only kept (the app wins: `closeOnApp` writes `status: "done"` to the item, and is called by `frames.ok`, `frames.fix`, `notes.send` and `motion.scene.approve`).
- MCP (`~/Documents/programs/video-notes/mcp/video_notes_mcp.py`, outside this repo): new tool `add_image {path, title, project, look_for, group?, group_index?, group_count?, ok_words?}` writes the same item and the 1-second compatibility video; `add_video` takes an optional `ok_words` (default `OK · Send my notes` / `OK`); `get_notes` prints "Still image" for an image item (no frame number or time); `queue` rows carry `kind`. The `video-notes` skill has the one line "for a single picture, use add_image". Tested over stdio with a temp `VIDEO_NOTES_DIR` (`test/sf-mcp-image.test.mjs`).

### Stills drawn by Claude, a scene (group) at a time (src/quickstills.mjs, svc/stills.mjs)
With a Claude backend the stills step no longer uses the fixed template (the template stays as the demo/test path: no `run`, or a test's `renderStill`). A GROUP is one scene's stills. Claude writes `src/scenes/st_<beat>.tsx` (`export const stills: Record<lineId, FC>`, one still per spoken line, each a STATE of the scene: first line = initial state, last = final state), in the approved look (`design/LOOK.md`, the style pack's rules, the OK'd style frames), from the asset pool by id. The static block is the style frames' block A plus the owner's `STILLS.md` (cached file `run/quick/_static/style-stills-writer.md`). The studio writes `src/scenes/stills.tsx` and `src/stills-root.tsx` (one composition per line, id = line id), renders each still (`design/stills/<line>-v<N>.png`, `kinetograph still`, through the render queue), measures it (inspect.mjs, with the line's key word), has it inspected (same loop as the frames: 3 rounds, then held) and submits the step. The next scene is written only when every still before it is OK; the owner's notes on earlier frames AND stills go into it, and the previous scene's last still is shown to the writer.
- `stills.get` -> as before plus `mode: "lines"|"groups"`, `groups: [{beat, name, index, count, lines[], state: ok|review|fixing|making|waiting}]`, and per line `beat, version, inspection, held, why` and state `todo|drawing|check|fix|held|ok`.
- `stills.ok {line}` (group flow): -> `{line, state, next: "group"|"wait"|"done"}`; `group` = the scene is OK and the step was restarted to draw the next scene. A `held` still cannot be OK'd.
- `stills.fix {line, text?}` (group flow): the pending notes on the still (`notes.save {node: "b01-2", send: false}`; `text` is one more) go as ONE fix, that still alone is drawn again as a new version (old versions kept) -> `{line, fixing, notes}`. Each note becomes a waiting lesson. (Demo/template path: the old instant redraw.)
- `stills.send_anyway {line}` / `stills.retry {line}`: as for frames, for a still held after 3 inspection rounds.
- Approving the stills step is refused while any still is open (`mode: "groups"`). Tablet: every drawn still is an image item "Scene 2 · still 3 of 4" (`ok_words` Remake this still / Next still, Next group on the last still of a scene, Done on the very last); OK with notes -> `stills.fix`, OK with none -> `stills.ok`.

### Add pack… (svc/packadd.mjs)
- `packs.add {path, kind?, name?}`: `path` is a folder or a `.zip` on this PC. Copies it to `<studio>/packs/<kind>/<id>/` (kind: the pack.json's own, else `kind`, else `assets`; the id is made from the name, `-2` when taken). ANY file is kept (hidden files and `__MACOSX` are dropped; a zip path that leaves its folder is refused; at most 1.5 GB). With no `pack.json` the studio writes one: `spec: 2`, `license: "Own projects only, never share"`, `share: false` (such a pack never leaves this PC and is never offered to mortiflix.com), the font family names read from the font files, and for a style pack `palette: []`, `suggested_palette` measured from the poster by code (PNG only), `confirmed: false`. A pack that brings its own pack.json is kept (a missing licence becomes the private default). Returns the card (`packs.list` fields incl. `brings`, `counts`, `confirmed`) plus `suggested_palette` and `needs_confirm`. Event `packs.changed {kind, id}`.
- `packs.confirm {kind?: "style", id, palette: [hex | {hex, job, rule}], name?}`: the owner's palette (a plain hex gets the job `c1`, `c2`, ...; `palette` omitted = the suggestion as it is). Writes `palette` and `style.palette`, `confirmed: true`. A style pack with `confirmed: false` cannot be picked for a project (`cleanPacks` refuses it until confirmed).

## Fix it (branch v3/sync; plan: Design Docs/Mortiflix Redesign/parts/30-sync.md, owner decisions 2026-11-01)

A fixed short list, never "make it work". Free and local: no Claude call, no paid API, no `project.takeover`, nothing deleted. Cases 5 to 8 (GPU, tabs, renders, Kinetograph) were dropped. Case 1 (lost service) lives in the bridge (`POST /api/service/restart`) and the page, which reconnects by itself and shows Fix it only after 30 s.

| Request | Params | Result |
|---|---|---|
| `sync.check` | `{project?}` | FAST, read-only (cached values and files only). `[{case, text, fix: {type: 'sync.fix', params} \| null, since, project?}]`, worst first. Empty when all is well: the app shows nothing. |
| `sync.fix` | `{case, project?}` | `{done, text}`. `case` is one of `paused`, `tablet`, `tools`; anything else is `bad_request`. `project` defaults to the open one (not needed for `tools`). Writes one `SYNC_FIX` project event and one grey chat row "Fix it: <text>". |
| `videonotes.reconcile` | `{project}` | `{closed, scenes}`: scenes the app has settled (state not `review`) whose tablet item is still open are closed with `closeOnApp`. The app wins; notes on the tablet are kept. Emits `videonotes.changed`. |
| `project.recheck` | `{project}` | `{resumed, clear, cause?, why}`: re-tests `needs_you.cause` and resumes if clear. `stopped` is always clear; `rate-limit` once 5 min have passed since `needs_you.at`; `login` by a forced free `claude auth status` (never the paid `setup.claude.test`). Never `billing`, `gave-up`, `needs-ai`, `gpu`, or a pause the owner made (`by_you`). |

Cases: `paused` (4, only listed when the cause already looks clear), `tablet` (3), `tools` (2: listed only when a tool check fails, `claude` not installed or signed out, or `ffmpeg` missing; `fix` is null while the cached answer is under 5 min old, because the error is then real).

## New project brief (plan 52, `src/svc/brief*.mjs`)

Full contract with every setting: `mortiflix-app/review/plans/new-project-brief-contract.md` (the field tables come from `brief.schema`). The service side:

- `brief.schema {}`: the versioned brief schema (31 settings in 5 sections, defaults, allowed values, decide-later, checkpoints and their v3 gates, `stored_only`). `brief.draft.get/list/save/delete`: autosave and recovery in `<studio>/drafts/<id>/` (`draft.json`, `sources.json`, `sources/`, `text/`); a save keeps the valid parts and returns `errors`. Event `brief.draft.saved`.
- `sources.add {draft?, url | path}` / `sources.list` / `sources.remove`: the source tray. URLs are fetched in the background (HTML, PDF via `pdftotext`, text); files come from the bridge route `POST /api/draft-upload?draft=&name=` (loopback only) and are read as txt/md, PDF, DOCX (`unzip`); images, video and audio are stored as they are. Statuses `fetching`, `ready`, `stored`, `failed`; event `sources.changed`. An invalid URL is refused with a plain error.
- `brief.summary {brief, draft?}`: rule-based, no AI. Sentences labelled specified, suggested or default, missing details, conflicts with resolutions (long text vs a short target, vertical destination without 9:16, strict checking with quick research, must-include vs excluded...), customized counts, estimate.
- `brief.improve {brief, draft?}`: one Haiku call (role `options`, `askAnon` in `svc/chat.mjs`). Suggestions are validated against the schema, never replace a setting the owner set, never touch the idea; the demo backend returns none. Included in the Claude plan, no credits.
- `presets.save {name, brief}` saves a brief preset (`<studio>/brief-presets/`; the idea, sources and title are not kept); `presets.list` adds `briefs`; `presets.delete {slug, kind: "brief"}`.
- `project.new {brief, draft?, ...}`: the brief is validated (an invalid one refuses the project), mapped into the intake (idea to topic, audience, manual duration to length, first aspect to shape, first URL to source_url; flat fields still win), saved in `state/<id>/brief.json` and `projects/<id>/design/brief.json`, and the draft's sources move to `design/sources/`. The Brief and Script prompts and every session get a "production brief" block (`svc/brief.mjs`, only what was specified, decide-later left out); frames and stills prompts get the visual part.
- Stored only for now: captions, safe zones, voice/music/sound-design/pause preferences, resolution/fps/quality, extra aspect ratios, approval checkpoints (all v3 gates stay on; unchecking is recorded, auto-pass is a next step). The optional `outline` checkpoint (generate and review an outline before the script) is stored and listed as a next step.
