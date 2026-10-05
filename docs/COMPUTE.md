# Where the compute goes

Measured on a real project (a 5-second logo sting, `claude-code` backend, Claude Opus 5.5, Linux, Oct 2026), so
contributors know what costs what and why the design looks the way it does.

## The model is the cost; everything else is noise

| | Measured |
|---|---|
| First gate (three directions as stills + motion sketches) | 47 turns, 6.9 min, 34.6k output tokens (12.4k of it thinking), 1.89M cache-read and 92k cache-write input tokens: **$1.81** at API list price |
| Final (build, sound design, render, QC, fixes, submit) | 47 turns, 5.6 min, 23.7k output tokens, 2.39M cache-read and 95k cache-write input tokens: **$1.71** |
| The whole sting, brief to approved final | two sessions, 12.5 min of work, **$3.52** at list price (on a Claude plan it uses your allowance instead) |
| Mortiflix's own text a session starts with | ~6.8k tokens: the gate protocol 2.2k, the session brief 1.5k, the pipeline + checklist 0.8k, three skills 2.3k |
| The studio process, per web refresh | ~1 ms per project (reading `project.json`, the step graph) |
| Backend availability check (`claude --version`) | 7 ms |
| Runner while idle | one directory listing every 1.5 s (0.3 ms) |
| `qc.mjs` on a 60 s 1080p video | 2.2 s (three ffmpeg passes) |

What that means:

- **Waiting is free.** Sessions end at every gate and the next one starts only when you respond, so a project that
  waits a week for you costs nothing. A session that stayed alive to wait for your reply would pay for its whole
  context again on every check.
- **The prompt cache does the heavy lifting.** 95% of the input tokens were cache reads (billed at a tenth of the
  input price). The session brief, the protocol and the skills form a stable prefix; keep them stable. Don't put
  timestamps or per-session noise at the top of `CLAUDE.md`.
- **Mortiflix's own text is small** next to a session's working context (~40k tokens per turn on average). Trimming
  it further isn't worth the clarity it would cost.
- **The bill splits into rough thirds:** writing the cache ($0.74 for 92k tokens, kept for an hour), output ($0.69
  for 34.6k tokens) and cache reads ($0.38 for 1.89M tokens). What lowers all three is fewer, shorter sessions:
  specific briefs, a default on every question (fewer round trips), and error checks that catch mistakes before a
  revision round.

## Fixed: one Remotion install per studio, not per project

Every project used to `npm install` the Remotion template: **748 MB per project** (220 MB of it a private Chrome) and
about half a minute of downloading. Ten videos, 7.5 GB of identical files.

Now the `remotion-motion` skill's `setup.mjs` installs the template's exact dependencies once per studio
(`run/shared/remotion-<hash of the template's package.json>`) and links each project's `video/node_modules` to it.
A new project's video folder is ~100 KB and ready in a second. Changing the template's dependencies makes a new
shared install; old projects keep theirs. A project that needs an extra package replaces the link with its own
install.

## Renders: one at a time, by design

Remotion renders drive Chrome, and memory is what kills long renders. `mfx render` queues every heavy job studio-wide,
and `renderPrefix` lets a machine-wide queue wrap it (this machine's `render-queue`, shared with other tools). Measured
on a GPU machine: `--gl=angle` rendered 1080p about 1.7× faster than the software renderer; use one `--gl` mode per
video so cuts don't shimmer.

## Things that look wasteful but aren't

- **The session re-reads the pipeline and skills every time.** After an hour the cache has expired anyway, and a
  session that skips the rules makes mistakes that cost a revision round (far more tokens).
- **`qc.mjs` decodes the video three times.** On a 60 s 1080p video the whole check takes 2.2 s; merging the passes
  would save under a second at the price of more fragile code.
- **The runner polls.** It also wakes immediately on any change made through the same process; the poll only exists
  for changes made from a second terminal, and it costs a directory listing.

## If you're paying per token (`anthropic-api`)

- Effort is the main dial: `high` (default) suits most steps. `medium` is worth trying for small pipelines.
- Viewing a rendered frame costs image tokens. The editor refuses images over 5 MB (and says how to make a smaller
  copy), and the final-pass skill has sessions read one frame sheet (a frame a second, small) before a few full-size
  frames.
- Compaction keeps long sessions inside the context window instead of failing them.
