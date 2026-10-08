# Mortiflix for Windows: one command in PowerShell gets you from nothing to `mortiflix init`.
#
#   irm https://raw.githubusercontent.com/GTKottman/mortiflix-oss/main/install.ps1 | iex
#
# or, from a checkout:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Dir <folder>] [-Yes] [-SkipInit]
#
# It checks for Node 20+, Git for Windows and ffmpeg, and offers to install what's missing with winget (Windows'
# own package manager; Node and Git may show a Windows "allow changes" prompt). It offers Claude Code too, with
# Anthropic's own installer. Then it clones Mortiflix (or updates your clone), installs its one npm dependency, puts
# `mortiflix` on your PATH with `npm link`, and runs `mortiflix init`. Nothing is installed without asking.
#
# Run through `iex` it can't take parameters, so the same choices are environment variables:
#   MORTIFLIX_DIR       where the code goes (default: %USERPROFILE%\mortiflix-oss)
#   MORTIFLIX_BRANCH    the branch to clone (default: main)
#   MORTIFLIX_YES=1     answer yes to every question
#   MORTIFLIX_SKIP_INIT=1  stop before `mortiflix init`
param(
  [string]$Dir = $env:MORTIFLIX_DIR,
  [string]$Branch = $env:MORTIFLIX_BRANCH,
  [switch]$Yes = ($env:MORTIFLIX_YES -eq '1'),
  [switch]$SkipInit = ($env:MORTIFLIX_SKIP_INIT -eq '1')
)

function Install-Mortiflix {
  param([string]$Dir, [string]$Branch, [bool]$Yes, [bool]$SkipInit)
  $ErrorActionPreference = 'Stop'
  $Repo = 'https://github.com/GTKottman/mortiflix-oss.git'
  if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE 'mortiflix-oss' }
  if (-not $Branch) { $Branch = 'main' }

  function Say([string]$Text) { Write-Host $Text }
  function Ok([string]$Text) { Write-Host "  [ok] $Text" -ForegroundColor Green }
  function Missing([string]$Text) { Write-Host "  [--] $Text" -ForegroundColor Yellow }
  function Fail([string]$Text) { throw "Mortiflix install stopped: $Text" }

  function Ask([string]$Question, [bool]$Default = $true) {
    if ($Yes) { return $true }
    $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
    $a = (Read-Host "$Question $hint").Trim().ToLower()
    if (-not $a) { return $Default }
    return $a.StartsWith('y')
  }

  # Programs installed a moment ago aren't on this window's PATH yet: read it again from the registry, and keep the
  # folders that per-user installers use (Claude Code, uv, npm's global folder).
  function Update-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $extra = @((Join-Path $env:USERPROFILE '.local\bin'), (Join-Path $env:APPDATA 'npm'))
    $env:Path = (@($machine, $user) + $extra | Where-Object { $_ }) -join ';'
  }

  # Anthropic's installer puts claude.exe in %USERPROFILE%\.local\bin without always adding that folder to your PATH;
  # then new windows (and Mortiflix's sessions) can't find it. Add it to your own PATH, once.
  function Add-UserPath([string]$Dir) {
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (@($user -split ';' | ForEach-Object { $_.TrimEnd('\') }) -contains $Dir.TrimEnd('\')) { return }
    [Environment]::SetEnvironmentVariable('Path', ((@($user, $Dir) | Where-Object { $_ }) -join ';'), 'User')
    Say "  Added $Dir to your PATH"
  }

  function Find([string]$Name) {
    $c = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
  }

  # Runs a program and stops the install if it fails (PowerShell doesn't stop on a program's exit code by itself).
  # Only programs: a function or alias with the same name (PowerShell names ignore case) must never run instead.
  function Run([string]$File, [string[]]$Arguments) {
    Say "  > $File $($Arguments -join ' ')"
    $exe = Find $File
    if (-not $exe) { Fail "$File isn't on the PATH" }
    & $exe @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "$File exited with $LASTEXITCODE" }
  }

  function Install-WithWinget([string]$Id, [string]$Name) {
    if (-not (Find 'winget')) {
      Fail "$Name is missing and winget isn't available to install it. Install it yourself, open a new PowerShell window and run this again. (winget comes with the App Installer from the Microsoft Store.)"
    }
    Run 'winget' @('install', '--id', $Id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
    Update-Path
  }

  Say ''
  Say 'Mortiflix: a motion design studio on your own machine'
  Say ''

  $build = [Environment]::OSVersion.Version.Build
  if ($build -lt 17763) { Fail "Windows 10 version 1809 or newer is needed (this is build $build)." }
  Update-Path

  # ---- what Mortiflix needs ----
  Say 'Checking what this computer has:'

  $node = Find 'node'
  $nodeMajor = 0
  if ($node) { $nodeMajor = [int]((& $node --version) -replace '^v(\d+).*', '$1') }
  if ($nodeMajor -ge 20) { Ok "Node $(& $node --version)" }
  else {
    if ($node) { Missing "Node $(& $node --version) is too old: Mortiflix needs 20 or newer" } else { Missing 'Node.js: runs Mortiflix' }
    if (-not (Ask '  Install Node.js LTS with winget?')) { Fail 'Node.js 20 or newer is needed.' }
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js'
    if (-not (Find 'node')) { Fail 'Node.js installed, but this window can''t see it yet: open a new PowerShell window and run this again.' }
    Ok "Node $(node --version)"
  }

  if (Find 'git') { Ok 'Git for Windows' }
  else {
    Missing 'Git for Windows: downloads Mortiflix, and its Git Bash runs the sessions'' shell commands'
    if (-not (Ask '  Install Git for Windows with winget?')) { Fail 'Git is needed to download Mortiflix.' }
    Install-WithWinget 'Git.Git' 'Git'
    if (-not (Find 'git')) { Fail 'Git installed, but this window can''t see it yet: open a new PowerShell window and run this again.' }
    Ok 'Git for Windows'
  }

  if ((Find 'ffmpeg') -and (Find 'ffprobe')) { Ok 'ffmpeg' }
  else {
    Missing 'ffmpeg: renders and checks every video'
    if (Ask '  Install ffmpeg with winget?') {
      Install-WithWinget 'Gyan.FFmpeg' 'ffmpeg'
      if (Find 'ffmpeg') { Ok 'ffmpeg' } else { Missing 'ffmpeg installed: open a new PowerShell window before you make a video' }
    } else { Missing 'skipped: videos can''t render until ffmpeg is installed (winget install Gyan.FFmpeg)' }
  }

  $claudeDir = Join-Path $env:USERPROFILE '.local\bin'
  if (Find 'claude') {
    if (Test-Path (Join-Path $claudeDir 'claude.exe')) { Add-UserPath $claudeDir }
    Ok 'Claude Code'
  } else {
    Missing 'Claude Code: does the work with your Claude plan (or use an Anthropic API key instead, asked for later)'
    if (Ask '  Install Claude Code with Anthropic''s installer (claude.ai/install.ps1)?') {
      # In its own PowerShell, so nothing it does (an `exit`, its variables) reaches this install.
      Run 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex')
      if (Test-Path (Join-Path $claudeDir 'claude.exe')) { Add-UserPath $claudeDir }
      Update-Path
      if (Find 'claude') { Ok 'Claude Code: run "claude" once to log in' } else { Missing 'Claude Code installed: open a new PowerShell window and run "claude" once to log in' }
    } else { Say '  Skipped: Mortiflix can use an Anthropic API key, or the free demo backend.' }
  }

  # ---- Mortiflix itself ----
  Say ''
  if (Test-Path (Join-Path $Dir '.git')) {
    Say "Updating Mortiflix in $Dir"
    Run 'git' @('-C', $Dir, 'pull', '--ff-only')
  } elseif ((Test-Path $Dir) -and (Get-ChildItem -Force $Dir | Select-Object -First 1)) {
    Fail ("$Dir already exists and isn't a Mortiflix checkout. Pick another folder, e.g. " + '$env:MORTIFLIX_DIR = ''C:\somewhere''' + ', and run this again.')
  } else {
    Say "Downloading Mortiflix into $Dir"
    Run 'git' @('clone', '--branch', $Branch, $Repo, $Dir)
  }

  Push-Location $Dir
  try {
    Run 'npm.cmd' @('install', '--no-audit', '--no-fund', '--loglevel=error')
    Run 'npm.cmd' @('link', '--no-audit', '--no-fund', '--loglevel=error')
  } finally { Pop-Location }
  # npm link also writes mortiflix.ps1, which PowerShell picks over mortiflix.cmd, and Windows' default script
  # policy (Restricted) refuses to run it. The .cmd works under every policy, so keep only that one.
  foreach ($bin in 'mortiflix', 'mfx') { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA "npm\$bin.ps1") }
  Update-Path
  $mfx = Find 'mortiflix'
  if (-not $mfx) { Fail "npm link finished but mortiflix isn't on the PATH: add $(Join-Path $env:APPDATA 'npm') to your PATH, or run: node `"$Dir\bin\mortiflix`"" }
  Ok "mortiflix is on your PATH ($mfx)"

  Say ''
  if ($SkipInit) {
    Say 'Done. Next: mortiflix init'
    return
  }
  Say 'Starting `mortiflix init`: it makes your studio folder and walks through setup.'
  & $mfx init
  Say ''
  Say 'Any time: mortiflix doctor (what''s here), mortiflix serve (the studio in your browser).'
  Say 'New PowerShell windows already have mortiflix on the PATH.'
}

Install-Mortiflix -Dir $Dir -Branch $Branch -Yes ([bool]$Yes) -SkipInit ([bool]$SkipInit)
