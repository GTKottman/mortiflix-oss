# /mortiflix reference

## Commands

| Read (JSON) | |
|---|---|
| `mortiflix list --json` | `{ studio, backend, runner: {pid, web} \| null, projects: [{ id, title, pipeline, state, label, status, needs_you, working, in_review: [step], unanswered }] }` |
| `mortiflix status <id> --json` | `{ id, title, pipeline, state, status, needs_you, working, steps: [{ key, name, review, state, version }], deliverables: [{ label, kind, path }], usage, cost, log: [{ t, event, step, version, details }] }` |
| `mortiflix review [<id>] --json` | an array, one per project waiting on the owner (below) |
| `mortiflix pipelines --json` | `[{ slug, name, description, steps: [{ key, name, review, after }], intake: [{ id, label, type, required, choices, default, help }] }]` |
| `mortiflix setup status --json` | `{ backend, backends, narration, tools, parts, tool_info }` |
| `mortiflix keys --json` | which keys are set and where they come from (never their values) |

| Act | |
|---|---|
| `mortiflix init --yes [--backend …]` | create the studio |
| `mortiflix new <slug> --title "…" --set id=value … --file id=path … --yes` | create and queue a project |
| `mortiflix run` | run sessions until everything waits on the owner (run it in the background) |
| `mortiflix respond <id> <step> --approve \| --changes [--note "…"]… [--overall "…"] [--answer qid=value]…` | decide a step in review (`--version N` to name the version; default is the one in review) |
| `mortiflix answer <id> <qid> ["answer"]` | answer a project question (no answer takes the default) |
| `mortiflix reopen <id> <step> "what to change"` | send an approved step back |
| `mortiflix pause \| resume \| cancel <id>` | |
| `mortiflix checks` · `checks approve \| reject <check-id>` | checks that sessions proposed |
| `mortiflix setup install <tool>…` | transitions, strudel, chrome, browser-harness, blender, blender-addons, comfyui |
| `mortiflix setup music strudel [--midi \| --no-midi]` · `setup music none` | |
| `mortiflix setup assets <url>…` · `setup assets --clear` | |
| `mortiflix voice none \| own` | narration choices that need no terminal |
| `mortiflix music <id>` | where its music stands: length and tempo, the MIDI pack, the owner's master |
| `mortiflix music <id> --midi <file>.zip` | save the MIDI pack (every channel, the arrangement, the cue sheet) |
| `mortiflix music <id> --import <file>` | the owner's own master (wav, aiff, flac, mp3, m4a, ogg): checked against the score, then the project resumes |
| `mortiflix pipelines export <slug> [--out <file>.zip]` · `pipelines add <file \| https://…> [--replace]` | share a pipeline, or add someone else's (it brings scripts: read them first) |
| `mortiflix config [key [value]]` | e.g. `config backend claude-code`, `config sandbox true` |
| `mortiflix serve` | the web studio on http://127.0.0.1:4646 (also runs sessions by itself) |
| `mortiflix doctor` | what's installed |

The owner runs these in their own terminal, not you, because they type keys or pick voices:
`mortiflix keys`, `mortiflix voice elevenlabs`, `mortiflix voice local`, `mortiflix record <id>` (the terminal
recording booth, with their microphone).

A project id can be any unique part of it (`mortiflix status smoke`). If only one project is live, it can be left
out.

## What `review --json` returns

```json
{
  "id": "261008-bike-share-c7b0", "title": "Bike share", "pipeline": "explainer",
  "state": "waiting",               // or "paused": then needs_you says why
  "needs_you": null,
  "questions": [ { "id": "q1", "step": "brief", "text": "…", "choices": ["…"], "default": "…" } ],
  "reviews": [ {
    "step": "style-frames", "name": "Style frames", "review": "frames", "version": 2,
    "note": "what the session says it sent and what to look at",
    "pin_changes": [ { "note": 1, "change": "what it changed", "status": "done|partly|not_done" } ],
    "questions": [ { "id": "palette", "text": "…", "choices": ["…"], "default": "…" } ],
    "items": [
      { "index": 0, "label": "Script", "kind": "text", "paragraphs": ["¶0 text", "¶1 text"] },
      { "index": 1, "label": "SF01 · Open", "kind": "image", "path": "/…/state/<id>/reviews/style-frames/v2/files/01-sf01.png" }
    ],
    "web": "#/p/<id>/review/style-frames"
  } ]
}
```

Item kinds: `text`, `image`, `video`, `audio`, `pdf`, `file`. Paths point into the studio's record (`state/`).
Those files never change after they're submitted. Open them, but don't edit them.

## Notes

Each `--note` is one note. A prefix points it at something:

| Note | Points at |
|---|---|
| `"too busy overall"` | the whole version |
| `"2: too dark"` | item 2 |
| `"2@0.5,0.3: make this bigger"` | a spot on item 2: x and y are fractions of the width and height, from the top-left |
| `"1@12.5s: cut here"` | 12.5 seconds into item 1 (video or audio) |
| `"0¶3: reword this"` | paragraph 3 of text item 0 |

Turn the owner's words into these. "The logo in the top right of the second frame" on a frames step becomes
`"1@0.85,0.15: …"`. Estimate the spot from the image you read, and say that it's an estimate when you read the notes
back. For exact pins, use the web review room. `--overall "…"` is one comment on the whole version. A changes
response needs at least one note or an overall comment.

Quoting: put each note in single quotes. Write an apostrophe inside one as `'\''`.

## When a project is paused (`needs_you`)

| It says | What to do |
|---|---|
| "This project needs your … key" | The owner adds it in their terminal (`mortiflix keys`) or Settings › Keys. Then `mortiflix resume <id>`. |
| asks for narration to be recorded (voice `own`) | The owner records in the web booth (`http://127.0.0.1:4646/#/p/<id>/booth`), in their terminal (`mortiflix record <id>`), or imports files named after the lines (`mortiflix record <id> --import <folder>`). Then resume. |
| "The last two sessions stopped without moving the project forward (…)" | Show the error and the last `log` events. Fix what it names if the owner agrees (a missing tool: `mortiflix doctor`), then resume. |
| "8 sessions in a row ended without submitting…" | The work is stuck in a loop. Show the log. A note through `reopen`, or a resume after a fix, usually gets it moving. |
| "Paused by you" | `mortiflix resume <id>` when they want it back. |
| "The score is approved. On the project page, Music › Download MIDI…" | The owner finishes the music in their DAW. Save the pack (`mortiflix music <id> --midi <file>.zip`), then import their master (`mortiflix music <id> --import <file>`). Importing resumes the project, so no `resume` is needed. |
| anything else | A session asked for something only the owner can do. Read it out, and resume once it's handled. |

## Errors and what they mean

- `another Mortiflix runner (pid N) is already running this studio`: `serve` or another `run` is already running
  sessions. Leave it alone, because sessions start by themselves.
- `only the owner does that: …`: the command ran inside a studio session (`MFX_TOKEN` is set). It never applies
  in the owner's own Claude Code.
- `X vN isn't waiting for review`: someone already answered it, maybe in the web studio. Read `review --json` again.
- `"…" needs an answer`: a submission question without a default. Ask the owner.
- `pin_changes …`, `error_checks …`: these refuse a session's submission. You won't see them, because they go to the
  session.
