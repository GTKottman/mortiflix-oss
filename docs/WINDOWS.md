# Windows

> **Nearly there.** Installing works as described below, and sessions (the part where Claude makes the video) now
> run on Windows. Every push checks them on a real Windows machine in CI (`scripts/windows-smoke.mjs`), with a
> stand-in for Claude. What hasn't happened yet is a whole video made by real Claude on a Windows PC: see
> [What's left](#whats-left). The goal is a tested Windows version by October 20, 2026.

## Install

In **PowerShell** (not CMD; you don't need to run it as Administrator):

```powershell
irm https://raw.githubusercontent.com/GTKottman/mortiflix-oss/main/install.ps1 | iex
```

It checks for what Mortiflix needs and offers to install what's missing, asking first each time:

| Needs | Why | Installed with |
|---|---|---|
| Windows 10 1809 or newer | what Node 20, Claude Code and winget need | |
| Node.js 20+ | runs Mortiflix | `winget install OpenJS.NodeJS.LTS` |
| Git for Windows | downloads Mortiflix and the 3D toolkits; its Git Bash runs the sessions' shell commands | `winget install Git.Git` |
| ffmpeg | renders and checks every video | `winget install Gyan.FFmpeg` |
| Claude Code (optional) | does the work on your Claude plan; an Anthropic API key works instead | Anthropic's installer, `irm https://claude.ai/install.ps1 \| iex` |

Node and Git may show Windows' "allow this app to make changes" prompt. Then it clones Mortiflix into
`%USERPROFILE%\mortiflix-oss` (or updates the clone that's there), runs `npm install` and `npm link` (which puts
`mortiflix` in `%APPDATA%\npm`, already on your PATH), and starts `mortiflix init`.

Choices, as environment variables (set them before the line above):

```powershell
$env:MORTIFLIX_DIR = 'D:\mortiflix-oss'   # where the code goes
$env:MORTIFLIX_BRANCH = 'main'            # which branch to clone
$env:MORTIFLIX_YES = '1'                  # yes to every question
$env:MORTIFLIX_SKIP_INIT = '1'            # stop before mortiflix init
```

From a clone: `powershell -ExecutionPolicy Bypass -File install.ps1 -Dir D:\mortiflix-oss -Yes -SkipInit`.

Run it again any time to update. `mortiflix doctor` shows what's there, with the winget command for anything
missing.

## What `mortiflix setup` does on Windows

- **Music**: renders in your Chrome, or in **Microsoft Edge** if there's no Chrome (Edge is Chromium and comes with
  Windows), so nothing is downloaded.
- **Downloads** are unpacked with Windows' own `tar.exe` (`C:\Windows\System32`), never the GNU tar from Git for
  Windows, which reads `C:\…` as a network address.
- **npm and npx** (`.cmd` programs on Windows) are run through `cmd.exe` with each argument quoted, so a studio
  under a folder with spaces (`C:\Users\Ada Lovelace\Mortiflix`) works.
- **uv** and **browser-harness** install to `%USERPROFILE%\.local\bin`, as on Linux.
- **Blender**: yours is reused from `C:\Program Files\Blender Foundation`; otherwise the official Windows zip is
  unpacked into the studio. **Nova FX doesn't build on Windows yet** (the other toolkits install).
- **Local narration** (ComfyUI + Qwen3-TTS) installs the same way, with PyTorch for CUDA; its window stays hidden.

## Removing it

```powershell
npm uninstall -g mortiflix
Remove-Item -Recurse -Force "$env:USERPROFILE\mortiflix-oss", "$env:USERPROFILE\Mortiflix\tools"
```

`%USERPROFILE%\Mortiflix` is your studio (projects, keys): delete it only if you mean to. Node, Git, ffmpeg and
Claude Code are ordinary programs: remove them in Settings › Apps, or `winget uninstall <id>`.

## What's left

Found by reading the code for Linux-only assumptions. Checked items are done. "CI" means
`scripts/windows-smoke.mjs` proves it on GitHub's `windows-latest` for every push (`.github/workflows/test.yml`).

**Installing**
- [x] `install.ps1`: prerequisites with winget, Claude Code, clone/update, `npm link`, `mortiflix init`
- [x] `src/platform.mjs`: finding programs (PATHEXT), running `.cmd` programs, Windows' tar, Git Bash, opening files
- [x] `mortiflix setup`: the repository path (`file:///C:/…`), tar, npm/npx, Edge, hidden ComfyUI window
- [x] `mortiflix doctor`: Git Bash, git, and winget hints
- [ ] Run the installer and every setup part on a real Windows 10 and 11 machine

**Running sessions**
- [x] The bridge listens on a named pipe (`\\.\pipe\mfx-…`, `ipcPath`). CI.
- [x] A session's `PATH` gets `bin/` first, under the one key Windows already uses (`Path`), with `;` (`withPath`).
      Two keys differing only in case would leave the child to pick one. CI.
- [x] `mfx` works from Claude Code's Git Bash (the shebang script) and from cmd and PowerShell (`bin/mfx.cmd`). CI.
- [x] The prompt goes to `claude` on stdin, so `claude.cmd` (an npm install of Claude Code) gets it intact through
      cmd.exe. The session is told where Git Bash is (`CLAUDE_CODE_GIT_BASH_PATH`). CI, with a stand-in `claude.cmd`.
- [x] Renders of `.cmd` programs (`npx remotion …`) start through cmd.exe (`command()`). CI.
- [x] Stopping a session stops its whole process tree with `taskkill /T /F` (`killTree`): the claude-code backend,
      the API backend's shell and the render queue. CI checks that a render and its child are gone.
- [x] The API backend's shell is Git Bash. Its editor reads Git Bash paths: `/c/Users/…` directly, and Git Bash's
      own folders (`/tmp/…`) through its `cygpath`. CI.
- [x] The Remotion template links `node_modules` with a junction (no Developer Mode or admin), runs npm through a
      shell, and waits without `sleep`. CI installs it and renders 15 frames of the template.
- [x] `secrets.json` and `session.env` get an ACL for you alone (`icacls`; Windows always keeps SYSTEM and
      Administrators). CI.
- [ ] A whole video made by **real** Claude (the `claude-code` and `anthropic-api` backends) on a Windows PC
- [ ] The terminal recording booth (`mortiflix record`, ffmpeg's dshow input) with a real microphone
- [ ] Nova FX's C core: build with MSVC or MinGW (it uses OpenMP and Vulkan)
