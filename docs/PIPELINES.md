# Writing a pipeline

A pipeline is how one kind of video gets made: the steps, which ones you review and how, what a session must check
before it shows you anything, and the craft. It's a folder:

```
my-pipeline/
  pipeline.json      the machine-readable part (below)
  PIPELINE.md        the craft: what each step does and the rules that don't bend (every session reads it)
  checklist.md       optional: a production checklist the session copies and ticks off (how it resumes)
  skills/<name>/     optional: skills only this pipeline uses (SKILL.md + scripts)
```

Built-in pipelines are in `pipelines/`; skills several pipelines share are in `pipelines/_shared/skills/`. Your own go
in your studio's `pipelines/` folder (a pipeline with the same slug as a built-in one replaces it there).

## pipeline.json

```json
{
  "slug": "product-film",
  "name": "Product film",
  "description": "One line people see when they pick what to make.",
  "makes": "video",
  "shared_skills": ["motion-design", "remotion-motion", "final-pass"],
  "intake": [
    { "id": "product", "label": "What's the product?", "type": "long", "required": true, "help": "Shown under the field." },
    { "id": "length", "label": "Length", "type": "choice", "choices": ["30 s", "60 s"], "default": "30 s" },
    { "id": "photos", "label": "Product photos", "type": "files" }
  ],
  "steps": [
    { "key": "brief", "name": "Brief", "review": "questions" },
    { "key": "script", "name": "Script", "review": "document", "work": ["script"], "after": ["brief"] },
    { "key": "style-frames", "name": "Style frames", "review": "frames", "work": ["stills"], "after": ["brief"] },
    { "key": "build", "name": "Build", "review": "internal", "work": ["motion", "audio"], "after": ["script", "style-frames"] },
    { "key": "final", "name": "Final", "review": "video", "work": ["motion", "audio"], "after": ["build"], "delivers": true }
  ],
  "status_lines": { "brief": "Reading your brief", "frames": "Designing the look", "build": "Animating" },
  "checks": [
    { "id": "text-safe-area", "title": "Text sits inside the title-safe area", "applies_to": ["stills", "motion"],
      "how": "Every text box sits at least 5% inside each frame edge in stills and sampled frames." }
  ]
}
```

### Intake

What you're asked when you start a project. `type`: `text`, `long`, `choice` (needs `choices`, may have `default`),
`files` (uploads land in the project's `input/<id>/`). `required: true` blocks the start until it's answered. Ask only
what the studio can't decide well on its own; the `brief` step can ask the rest, with defaults.

### Steps

| Field | Meaning |
|---|---|
| `key` | lowercase id; sessions use it with `mfx` |
| `name` | what you see |
| `review` | how you review it: `questions` (a note + questions), `document` (text, commented by paragraph), `frames` (images, pinned), `video` (pinned at a moment and a spot), `audio` (noted at a moment), or `internal` (no review: the session finishes it with its checks) |
| `after` | the steps it waits for. Leave it out and a step waits for the one before it; give `[]` for none. Steps with no path between them run side by side |
| `work` | what the step makes: `script`, `stills`, `motion`, `audio`. Decides which checks it runs |
| `delivers` | the step whose approved files are the deliverables (defaults to the last reviewed step) |
| `describe` | optional one-liner shown on the Pipelines page |

### Checks: the error checklist

Each check is a mistake you should never have to point out. `applies_to` lists the kinds of work it covers (leave it
empty for all); a step runs every check that matches its `work`. Sessions must report each one (`pass`, `fixed` with
a note, or `n/a` with a reason) or the submission is refused.

Write checks about **errors** (objectively wrong: text off the frame, a misspelled name, a black frame, clipping),
never about taste (colours, pace, wording). Make `how` concrete: what to look at and what counts as wrong. The best
checks have a tool behind them (`qc.mjs` measures loudness; you can't eyeball LUFS).

### Status lines

The only sentences you see while a session works (`mfx status <key>`). Keep them short and plain.

## PIPELINE.md

This is the craft, and it's what makes a pipeline good. Every session reads it first. A strong one has:

1. **What it makes and for whom**, in two lines.
2. **Core rules** that don't bend (five or so). "The approved script is spoken word for word." "The logo is never
   redrawn." Rules come from mistakes; add one every time something goes wrong twice.
3. **A table of steps**: for each, what happens and exactly what gets submitted.
4. **Which skill to read** before which step.
5. **Status line keys.**

Keep studio-mechanics out of it: `.mortiflix/GATES.md` (the gate protocol) is given to every session already.

## Skills

A skill is a folder with a `SKILL.md` (front matter `name` and `description`, then instructions) and any scripts it
needs. Claude Code loads skills from `.claude/skills/` in the project folder, which is where Mortiflix puts them; the
API backend reads them with its editor. Good skills hold the *how*: commands that work, numbers that were measured,
the order to do things in, and the checks that prove it's right. Put tools in the skill folder and call them by path
(`node .claude/skills/final-pass/qc.mjs …`).

Shared skills (`_shared/skills/`, listed in `shared_skills`) are copied into each project's pinned snapshot, so a
project keeps the version it started with.

## Try it without spending anything

```sh
mortiflix pipelines                                   # validates every pipeline, shows errors
mortiflix new my-pipeline --backend demo              # the demo backend walks every gate with placeholder work
mortiflix run && mortiflix review
```

The demo checks the plumbing (steps, dependencies, review modes, checks, notes), not the craft. For the craft, run a
real session on a small brief and read its transcript (`state/<id>/sessions/*.jsonl`) and journal.

## Sending one upstream

A pull request with the folder in `pipelines/` (and any new shared skill in `pipelines/_shared/skills/`). Include a
line in the README table, and say in the PR what you made with it. Assets in examples must be yours or clearly
licensed.
