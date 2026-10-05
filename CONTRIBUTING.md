# Contributing

Thanks for looking. The most valuable contributions are **pipelines and skills**: how a good studio makes a kind of
video, written so a session can follow it (see [docs/PIPELINES.md](docs/PIPELINES.md)). Code is welcome too.

## Setup

```sh
npm install
npm test                       # ~1 s; no network, no API key, no Claude
node bin/mortiflix --studio /tmp/mfx-dev demo
node bin/mortiflix --studio /tmp/mfx-dev serve
```

There's no build step: Node ES modules on the server, plain ES modules in `web/`.

## Rules of the codebase

- **Gates are code.** If a rule matters ("every note gets answered"), enforce it in `src/gates.mjs` and test it.
  Don't rely on the prompt alone.
- **Tests are fast and offline.** Use the demo backend, a fake `fetch` for the API backend
  (`test/api-backend.test.mjs` shows how), and Unix sockets instead of TCP ports. A test that takes seconds is too slow.
- **Run only what you touched** while working (`node --test test/gates.test.mjs`), everything before a PR.
- **Write like the code around it.** Small modules, comments that say *why*, plain words in anything a person reads.
- **Errors are sentences a session can act on.** "pin_changes: note 2 from directions v1 has no answer", not "invalid
  submission".

## The web UI

It follows a few rules, so the screen answers "what needs me?" in a second:

- one shared column edge; text left, values (counts, dates, states) right;
- sections separated by a hairline, never boxes inside boxes;
- quiet defaults, and the accent colour on one thing only: what's waiting for you;
- links are blue and underlined; categories are chips;
- no explanatory paragraphs where an icon or a chip will do;
- every project string is inserted as text (`h()` in `web/app.js`), never as HTML.

## Adding a backend

A module in `src/backends/` exporting `available(config, root)` and `run({...})` (see
[ARCHITECTURE.md](docs/ARCHITECTURE.md#backends-srcbackends)), registered in `BACKENDS` in `src/runner.mjs`. It must
put `bin/` on the session's `PATH` and pass the bridge's environment through, so `mfx` works.

## Pull requests

- One topic per PR; tests for behaviour changes.
- Pipelines: include what you made with it, and only assets that are yours or clearly licensed.
- By contributing you agree your work is licensed under the AGPL-3.0, like the rest of the project.
