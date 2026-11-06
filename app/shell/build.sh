#!/usr/bin/env bash
# Build the Mortiflix Studio window (part 60 section 8). Only rebuilds when shell/src-tauri changed.
# Run once, by the orchestrator, after merge + tests. Serialized through render-queue's main lane.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$HERE/src-tauri"
export TMPDIR="$HOME/.cache/build-tmp"; mkdir -p "$TMPDIR"
export CARGO_TARGET_DIR="$HOME/.cache/cargo-target/tauri2"
STAMP="$HERE/.build-stamp"
LIMIT="${LIMIT:-1200}"   # first build 1200 s; later rebuilds: LIMIT=600

# disk guards: /home >= 5 GB, / >= 1 GB
[ "$(df -BG --output=avail /home | tail -1 | tr -dc 0-9)" -ge 5 ] || { echo "/home < 5 GB"; exit 1; }
[ "$(df -BG --output=avail / | tail -1 | tr -dc 0-9)" -ge 1 ] || { echo "/ < 1 GB"; exit 1; }

HASH="$(cd "$T" && find Cargo.toml Cargo.lock build.rs tauri.conf.json src capabilities icons ../ui -type f | sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
if [ -z "${FORCE:-}" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$HASH" ] && [ -x "$HERE/mortiflix-studio" ]; then
  echo "shell unchanged, skipping build"; exit 0
fi

# one-time seed of the shared target from Singer's compiled deps
mkdir -p "$CARGO_TARGET_DIR"
SEED="$HOME/Documents/programs/singer/app/src-tauri/target/release"
[ -d "$CARGO_TARGET_DIR/release" ] || [ ! -d "$SEED" ] || cp -a "$SEED" "$CARGO_TARGET_DIR/"

# tauri.conf.json lists bundle-res/renderer/ (filled by package-linux.sh); tauri-build needs the folder to exist
mkdir -p "$HERE/bundle-res/renderer"
cd "$T"
render-queue -l "build: mortiflix studio shell" -- \
  env TMPDIR="$TMPDIR" CARGO_TARGET_DIR="$CARGO_TARGET_DIR" \
  /usr/bin/time -v timeout -k 30 "$LIMIT" cargo build --release -j 4 --locked

cp "$CARGO_TARGET_DIR/release/mortiflix-studio" "$HERE/mortiflix-studio"
echo "$HASH" > "$STAMP"
echo "built $HERE/mortiflix-studio"
