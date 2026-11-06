#!/usr/bin/env bash
# Linux packages of Mortiflix Studio: AppImage + .deb + the plain binary, in one Tauri build through render-queue.
# See docs/LINUX-PACKAGING.md. Output: shell/dist/ (git-ignored).
#   shell/package-linux.sh            stage resources, build, copy results to shell/dist/
#   LIMIT=900 shell/package-linux.sh  build time limit in seconds (default 1500)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
SERVICE="${MFX_SERVICE_DIR:-$APP/..}"
TAURI="${TAURI_CLI:-$HOME/.cache/mfx-tauri-cli/node_modules/.bin/tauri}"
RES="$HERE/bundle-res"
OUT="$HERE/dist"
LIMIT="${LIMIT:-1500}"
export TMPDIR="$HOME/.cache/build-tmp"; mkdir -p "$TMPDIR"
export CARGO_TARGET_DIR="$HOME/.cache/cargo-target/tauri2"

[ -x "$TAURI" ] || { echo "Tauri CLI missing: (cd ~/.cache/mfx-tauri-cli && npm i @tauri-apps/cli@^2)"; exit 1; }
[ -f "$APP/web/app/index.html" ] || { echo "web/app/ is not built: run tools/ui-build.sh first"; exit 1; }
# a web/app/ older than the UI source would ship an old UI
[ -z "$(find "$APP/ui/src" "$APP/ui/index.html" -newer "$APP/web/app/index.html" -print -quit)" ] || { echo "web/app/ is older than ui/src: run tools/ui-build.sh first"; exit 1; }
[ "$(df -BG --output=avail /home | tail -1 | tr -dc 0-9)" -ge 5 ] || { echo "/home < 5 GB"; exit 1; }

# 1. resources: the bridge + web pages, and the service (no git, no tests, nothing git-ignored)
rm -rf "$RES"; mkdir -p "$RES/app/tools" "$RES/app/node_modules" "$RES/service" "$RES/renderer"
cp "$APP/bridge.mjs" "$APP/package.json" "$RES/app/"
cp "$APP/tools/media-http.mjs" "$RES/app/tools/"
rsync -a "$APP/web/" "$RES/app/web/"
rsync -a "$APP/node_modules/ws/" "$RES/app/node_modules/ws/"
# the service's tracked files plus new files that are not git-ignored (uncommitted work ships; ignored keys, .env and
# caches do not), then its node_modules
git -C "$SERVICE" ls-files -z --cached --others --exclude-standard | grep -zv -e '^test/' -e '^app/' -e '\.ps1$' \
  | rsync -a --from0 --files-from=- --ignore-missing-args "$SERVICE/" "$RES/service/"
rsync -a "$SERVICE/node_modules/" "$RES/service/node_modules/"
# The renderer, installed with the app (nothing to click; owner requirement 4): the owner's own build of the engine,
# its JavaScript packs from the fork (the same packs as Windows, KG_PACKS) + the Linux addon built from the fork
# (KG_LINUX_ADDON, BUILD.json commit 88a2ab60: the fork's Rust is unchanged since). main.rs points the service at
# renderer/node_modules/kinetograph/dist/cli.js (MFX_KINETOGRAPH) and puts renderer/bin on the PATH.
KG_PACKS="${KG_PACKS:?set KG_PACKS to the folder of renderer tarballs}"
KG_LINUX_ADDON="${KG_LINUX_ADDON:?set KG_LINUX_ADDON to the Linux renderer addon}"
[ -f "$KG_LINUX_ADDON" ] || { echo "no Linux renderer addon at $KG_LINUX_ADDON"; exit 1; }
mkdir -p "$RES/renderer/bin"
echo '{"name":"mortiflix-renderer","private":true}' > "$RES/renderer/package.json"
( cd "$RES/renderer" && npm install $(ls "$KG_PACKS"/*.tgz | grep -v native-win32) "$KG_LINUX_ADDON" --omit=dev --no-audit --no-fund --no-bin-links --loglevel=error )
[ -f "$RES/renderer/node_modules/@kinetographdev/native-linux-x64-gnu/kinetograph.linux-x64-gnu.node" ] || { echo "the renderer's Linux addon did not install"; exit 1; }
printf '#!/bin/sh\nd="$(dirname "$(readlink -f "$0")")"\nexec node "$d/../node_modules/kinetograph/dist/cli.js" "$@"\n' > "$RES/renderer/bin/kinetograph"
chmod +x "$RES/renderer/bin/kinetograph"
# npm writes the build machine's tarball paths into these: nothing at run time reads them
rm -f "$RES/renderer/package-lock.json" "$RES/renderer/node_modules/.package-lock.json"
echo '{"name":"mortiflix-renderer","private":true}' > "$RES/renderer/package.json"
echo "service: $(git -C "$SERVICE" rev-parse --abbrev-ref HEAD) $(git -C "$SERVICE" rev-parse --short HEAD)" > "$RES/VERSION.txt"
echo "app:     $(git -C "$APP" rev-parse --short HEAD)" >> "$RES/VERSION.txt"
du -sh "$RES/app" "$RES/service" "$RES/renderer"

# one-time seed of the shared target from Singer's compiled deps (same as build.sh)
mkdir -p "$CARGO_TARGET_DIR"
SEED="$HOME/Documents/programs/singer/app/src-tauri/target/release"
[ -d "$CARGO_TARGET_DIR/release" ] || [ ! -d "$SEED" ] || cp -a "$SEED" "$CARGO_TARGET_DIR/"

# 2. one build: binary + AppImage + .deb
cd "$HERE/src-tauri"
render-queue -l "build: mortiflix studio linux packages" -- \
  env TMPDIR="$TMPDIR" CARGO_TARGET_DIR="$CARGO_TARGET_DIR" CARGO_BUILD_JOBS=4 NO_STRIP=true \
  timeout -k 30 "$LIMIT" "$TAURI" build --bundles appimage,deb --ci -- --locked

# 3. results
mkdir -p "$OUT"
B="$CARGO_TARGET_DIR/release"
cp "$B/mortiflix-studio" "$OUT/mortiflix-studio"
# the newest only: the shared target dir keeps older versions too
cp "$(ls -t "$B"/bundle/appimage/*.AppImage | head -1)" "$OUT/"
cp "$(ls -t "$B"/bundle/deb/*.deb | head -1)" "$OUT/"
cp "$RES/VERSION.txt" "$OUT/"
ls -la "$OUT"
