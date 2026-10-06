# Security

Mortiflix is a studio for **one person**: you write the briefs, you review every stage, and the sessions work for
you, on your computer. There are no other users, accounts or roles. It does run an AI agent with a shell on your
machine, so here's what that means and what limits it.

## What a session can reach

**By default, a session runs as you.** With the `claude-code` backend it has whatever Claude Code's permission flags
allow (`config.claudeArgs`: by default it may edit files and run commands without asking, because nobody is there to
answer). With the `anthropic-api` backend its shell is a normal shell in the project folder. The editor tool is
confined to the project folder, but the shell is not. Treat a session like a capable assistant logged in as you.

**With `sandbox: true` (Linux, `claude-code` backend)**, each session runs inside
[bubblewrap](https://github.com/containers/bubblewrap). It sees:

- the system (`/usr`, `/etc`) read-only, and the GPU devices;
- its own project folder, read-write;
- the Mortiflix code, read-only, and its own `mfx` socket;
- Claude Code's install (read-only) and its login (`~/.claude`, `~/.claude.json`), which it needs to run;
- an npm cache inside the studio.

Your home folder, other projects, the studio's records (`state/`), `secrets.json` and `session.env` are simply not
there. The network is shared (Claude needs it). Check it with `mortiflix doctor`.

## What a session can't do, even unsandboxed

The gates are enforced by the studio process, not by the prompt:

- it can't approve a step you review: approval exists only in the web API and the CLI;
- it can't change what you already reviewed: submissions are copied into `state/`, outside the working folder;
- it can't submit files from outside its project folder (paths and symlinks are resolved and checked).

Unsandboxed, a determined session could still edit `state/` files directly with its shell. If that's in your threat
model, turn the sandbox on.

## Your words are direction; outside material is data

Your brief, notes and answers are your direction to the session: they decide what gets made and outrank the
pipeline's defaults (never the gate rules). The risk is everything else a session reads: the contents of files you
hand over, web pages it researches, things it downloads. The gate protocol tells it that this material is data and
never instructions, and to report anything in it that tries to give orders. That reduces prompt injection; it can't
rule it out. If you hand a session files or links from sources you don't trust, turn the sandbox on.

## Keys

Every key is yours: Mortiflix has no accounts of its own. You add them with `mortiflix keys` (asked at
`mortiflix init`, and before a project starts if it needs one) or Settings › Keys. Typing is never echoed, and each
key is checked with a free, read-only API call before it's saved.

- A new studio folder is created mode 700 (only you can open it).
- The Anthropic API key is stored in `secrets.json` (mode 600) and is never returned by the API or shown in the UI.
  Sessions don't get it.
- The ElevenLabs key is stored in `secrets.json` too, and given to a session only while ElevenLabs is the narration
  engine.
- Other keys go to `session.env` (mode 600) and are given to every session's environment. The UI shows their names,
  never their values. Only add keys that sessions need, and prefer keys with spending limits.
- The runner checks a project's keys before each session: if one is missing, the project pauses and tells you which,
  instead of starting a session that would fail.

## The web server

A web server on localhost can be reached by any page open in your browser, so:

- it binds to `127.0.0.1` unless you pass another `--host`; then every request needs an access token (printed once as
  a link; kept in an HttpOnly, SameSite=Strict cookie);
- on loopback, requests whose `Host` isn't `localhost`/`127.0.0.1`/`::1` are refused (DNS rebinding);
- every change needs the `X-Mortiflix: 1` header, which another site can't send without a CORS preflight that this
  server never allows (CSRF);
- media is served only from a project's `reviews/` folder, resolved and checked (no `../`, encoded or not), with
  `Content-Security-Policy: sandbox` and `nosniff`, so a submitted SVG or HTML file can't run script in the app;
- the app itself has a strict CSP (`default-src 'self'`), and all project text is inserted as text, never HTML.

Exposing it beyond your network? Put it behind HTTPS (a reverse proxy) as well as the token.

## Reporting a problem

Please open a private security advisory on the repository rather than a public issue.
