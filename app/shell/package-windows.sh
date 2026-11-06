#!/usr/bin/env bash
# Windows installer of Mortiflix Studio (NSIS .exe), cross-built on Linux. See docs/WINDOWS-PACKAGING.md.
# Owner: "The Windows installer should be built on a Linux computer." One Tauri build through render-queue.
#   shell/package-windows.sh            stage resources, build, copy the .exe to shell/dist-win/ and Morti Drive
#   LIMIT=900 shell/package-windows.sh  build time limit in seconds (default 1500)
#   STAGE_ONLY=1 shell/package-windows.sh   stage resources only (no compile)
# Needs (one time): rustup's stable toolchain in ~/.rustup with the x86_64-pc-windows-msvc std (used only here, via
# RUSTUP_TOOLCHAIN; the system Rust in /usr/bin has no Windows std and stays as it is), cargo-xwin (~/.cargo/bin; its SDK cache ~/.cache/cargo-xwin),
# clang/lld-link/llvm-rc (system), the Tauri CLI in ~/.cache/mfx-winbuild/tauri-cli, and NSIS's makensis: Debian's
# nsis + nsis-common 3.11 packages unpacked into ~/.cache/mfx-winbuild/nsis (Arch has no nsis package).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
SERVICE="${MFX_SERVICE_DIR:-$APP/..}"   # branch mfx-service/v3 (v3/windows merged)
B="${MFX_WINBUILD:-$HOME/.cache/mfx-winbuild}"
TAURI="$B/tauri-cli/node_modules/.bin/tauri"
RES="$B/res"
OUT="$HERE/dist-win"
DRIVE="$HOME/MortiDrive/files/Mortiflix Studio"
LIMIT="${LIMIT:-1500}"
NODE_ZIP="$B/dl/node-v26.13.0-win-x64.zip"            # nodejs.org, MIT (check by hand against SHASUMS256.txt: this script does not)
FFMPEG_ZIP="$B/dl/ffmpeg-n9.0-win64-gpl-shared.zip"     # BtbN/FFmpeg-Builds n9.0 win64 gpl-shared, GPL-3.0
export TMPDIR="$HOME/.cache/build-tmp"; mkdir -p "$TMPDIR"
export CARGO_TARGET_DIR="$HOME/.cache/cargo-target/tauri2"
export PATH="$HOME/.cargo/bin:$B/bin:$PATH"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"   # rustup's cargo/rustc (~/.cargo/bin), not /usr/bin's

[ -d "$HOME/.rustup/toolchains/$RUSTUP_TOOLCHAIN-x86_64-unknown-linux-gnu/lib/rustlib/x86_64-pc-windows-msvc" ] || { echo "missing: rustup $RUSTUP_TOOLCHAIN Windows std (rustup target add x86_64-pc-windows-msvc --toolchain $RUSTUP_TOOLCHAIN)"; exit 1; }
for f in "$TAURI" "$NODE_ZIP" "$FFMPEG_ZIP" "$B/nsis/usr/bin/makensis"; do [ -e "$f" ] || { echo "missing: $f"; exit 1; }; done
[ -f "$APP/web/app/index.html" ] || { echo "web/app/ is not built: run tools/ui-build.sh first"; exit 1; }
# a web/app/ older than the UI source would ship an old UI
[ -z "$(find "$APP/ui/src" "$APP/ui/index.html" -newer "$APP/web/app/index.html" -print -quit)" ] || { echo "web/app/ is older than ui/src: run tools/ui-build.sh first"; exit 1; }
[ "$(df -BG --output=avail /home | tail -1 | tr -dc 0-9)" -ge 5 ] || { echo "/home < 5 GB"; exit 1; }

# makensis on the PATH with its data folder (Debian's build looks in /usr/share/nsis unless NSISDIR says otherwise)
mkdir -p "$B/bin"
printf '#!/bin/sh\nNSISDIR="%s/nsis/usr/share/nsis" exec "%s/nsis/usr/bin/makensis" "$@"\n' "$B" "$B" > "$B/bin/makensis"
chmod +x "$B/bin/makensis"

# 1. resources (same layout as Linux: app/ + service/), plus node/ and ffmpeg/ for Windows
rm -rf "$RES"; mkdir -p "$RES/app/tools" "$RES/app/node_modules" "$RES/service" "$RES/node" "$RES/ffmpeg" "$RES/licenses"
cp "$APP/bridge.mjs" "$APP/package.json" "$RES/app/"
cp "$APP/tools/media-http.mjs" "$RES/app/tools/"
rsync -a "$APP/web/" "$RES/app/web/"
rsync -a "$APP/node_modules/ws/" "$RES/app/node_modules/ws/"
# the service as committed (git archive: no untracked files), with its node_modules (pure JS, no native addons)
git -C "$SERVICE" archive HEAD | tar -x -C "$RES/service"
rm -rf "$RES/service/test" "$RES/service/.github" "$RES/service/app"
rsync -aL "$SERVICE/node_modules/" "$RES/service/node_modules/"
# portable Node (node.exe + npm/npx)
bsdtar -xf "$NODE_ZIP" -C "$RES/node" --strip-components 1
cp "$RES/node/LICENSE" "$RES/licenses/node-LICENSE.txt"
# ffmpeg + ffprobe and their DLLs (no ffplay)
bsdtar -xf "$FFMPEG_ZIP" -C "$RES/ffmpeg" --strip-components 2 '*/bin/*'
rm -f "$RES/ffmpeg/ffplay.exe"
bsdtar -xOf "$FFMPEG_ZIP" '*/LICENSE.txt' > "$RES/licenses/ffmpeg-LICENSE.txt"
printf 'ffmpeg: BtbN/FFmpeg-Builds n9.0 win64 gpl-shared (GPL-3.0). Source: https://github.com/FFmpeg/FFmpeg/tree/release/9.0 and build scripts https://github.com/BtbN/FFmpeg-Builds\nNode.js 26.13.0 win-x64 (MIT): https://nodejs.org/dist/v26.13.0/\n' > "$RES/licenses/README.txt"
# The renderer, installed with the app (nothing to click): the owner's own build of the engine, packed as npm tarballs
# in KG_PACKS (its JavaScript packages from the fork's mortiflix branch + the Windows GPU addon built on a Windows PC).
# npm --os/--cpu picks esbuild's Windows binary. The app points the service at it and puts renderer/bin on the PATH.
KG_PACKS="${KG_PACKS:?set KG_PACKS to the folder of renderer tarballs}"
ls "$KG_PACKS"/kinetographdev-native-win32-x64-msvc-*.tgz >/dev/null 2>&1 || { echo "no Windows renderer addon in $KG_PACKS"; exit 1; }
mkdir -p "$RES/renderer/bin"
echo '{"name":"mortiflix-renderer","private":true}' > "$RES/renderer/package.json"
( cd "$RES/renderer" && npm install "$KG_PACKS"/*.tgz --os=win32 --cpu=x64 --force --omit=dev --no-audit --no-fund --no-bin-links --loglevel=error )
# npm writes the build machine's tarball paths into these: nothing at run time reads them
rm -f "$RES/renderer/package-lock.json" "$RES/renderer/node_modules/.package-lock.json"
echo '{"name":"mortiflix-renderer","private":true}' > "$RES/renderer/package.json"
[ -f "$RES/renderer/node_modules/@kinetographdev/native-win32-x64-msvc/kinetograph.win32-x64-msvc.node" ] || { echo "the renderer's Windows addon did not install"; exit 1; }
printf '@"%%~dp0..\\..\\node\\node.exe" "%%~dp0..\\node_modules\\kinetograph\\dist\\cli.js" %%*\r\n' > "$RES/renderer/bin/kinetograph.cmd"
printf '#!/bin/sh\nd="$(dirname "$0")"\nexec "$d/../../node/node.exe" "$d/../node_modules/kinetograph/dist/cli.js" "$@"\n' > "$RES/renderer/bin/kinetograph"
{ echo "service: $(git -C "$SERVICE" rev-parse --abbrev-ref HEAD) $(git -C "$SERVICE" rev-parse --short HEAD)"; echo "app:     $(git -C "$APP" rev-parse --short HEAD)"; } > "$RES/VERSION.txt"
du -sh "$RES"/*
[ -n "${STAGE_ONLY:-}" ] && exit 0

# Resources for this build only: the Linux config's ../bundle-res entries are removed (JSON merge patch null).
RESCONF="$(printf '{"bundle":{"resources":{"../bundle-res/app/":null,"../bundle-res/service/":null,"../bundle-res/renderer/":null,"%s/app/":"app/","%s/service/":"service/","%s/node/":"node/","%s/ffmpeg/":"ffmpeg/","%s/licenses/":"licenses/","%s/renderer/":"renderer/","%s/VERSION.txt":"VERSION.txt"}}}' "$RES" "$RES" "$RES" "$RES" "$RES" "$RES" "$RES")"

# one-time seed of the Windows target from Singer's compiled deps (same Cargo.lock apart from the package name)
SEED="$HOME/Documents/programs/singer/app/src-tauri/target/x86_64-pc-windows-msvc/release"
[ -d "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release" ] || { [ -d "$SEED" ] && mkdir -p "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc" && cp -a "$SEED" "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/"; }

# 2. one build: the .exe + the NSIS installer
cd "$HERE/src-tauri"
render-queue -l "build: mortiflix studio windows installer" -- \
  env TMPDIR="$TMPDIR" RUSTUP_TOOLCHAIN="$RUSTUP_TOOLCHAIN" CARGO_TARGET_DIR="$CARGO_TARGET_DIR" CARGO_BUILD_JOBS=4 PATH="$PATH" \
  timeout -k 30 "$LIMIT" "$TAURI" build --ci --runner cargo-xwin --target x86_64-pc-windows-msvc \
    --bundles nsis --config tauri.windows.conf.json --config "$RESCONF" -- --locked

# 3. results
mkdir -p "$OUT" "$DRIVE"
EXE="$(ls -t "$CARGO_TARGET_DIR"/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe | head -1)"
cp "$EXE" "$OUT/"; cp "$EXE" "$DRIVE/"; cp "$RES/VERSION.txt" "$OUT/"
ls -la "$OUT" "$DRIVE"
