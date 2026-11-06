#!/usr/bin/env bash
# Replace the old Mortiflix Studio on this PC with the new window (shell/dist/mortiflix-studio from package-linux.sh).
# The old binary, launcher and icons are moved (never deleted) to ~/.local/share/mortiflix-studio-old/.
#   shell/install-linux.sh           install
#   shell/install-linux.sh --undo    put the old app back
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin/mortiflix-studio"
DESK="$HOME/.local/share/applications/com.mortiflix.studio.desktop"
ICONS="$HOME/.local/share/icons/hicolor"
OLD="$HOME/.local/share/mortiflix-studio-old"
SIZES="16 24 32 48 64 128 256 512"

refresh() {
  gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true   # optional tool: the launcher works without it
}

if [ "${1:-}" = "--undo" ]; then
  [ -f "$OLD/mortiflix-studio" ] || { echo "nothing to undo: $OLD/mortiflix-studio missing"; exit 1; }
  mv -f "$OLD/mortiflix-studio" "$BIN"
  mv -f "$OLD/com.mortiflix.studio.desktop" "$DESK"
  (cd "$OLD/icons" && for f in */apps/*; do mkdir -p "$ICONS/$(dirname "$f")"; mv -f "$f" "$ICONS/$f"; done)
  refresh; echo "old Mortiflix Studio is back"; exit 0
fi

NEW="$HERE/dist/mortiflix-studio"
[ -x "$NEW" ] || { echo "$NEW missing: run shell/package-linux.sh first"; exit 1; }
pgrep -x mortiflix-studi >/dev/null && { echo "Mortiflix Studio is running: close it first"; exit 1; }
command -v magick >/dev/null || { echo "ImageMagick (magick) is needed to make the icons: install it first"; exit 1; }

# 1. keep the old app (only the first time, so a second install never overwrites the kept old copy)
if [ ! -f "$OLD/mortiflix-studio" ]; then
  mkdir -p "$OLD/icons"
  [ -f "$BIN" ] && mv "$BIN" "$OLD/mortiflix-studio"
  [ -f "$DESK" ] && mv "$DESK" "$OLD/"
  (cd "$ICONS" && for f in */apps/com.mortiflix.studio.*; do [ -e "$f" ] || continue; mkdir -p "$OLD/icons/$(dirname "$f")"; mv "$f" "$OLD/icons/$f"; done)
fi

# 2. the new window, its icon (shell/src-tauri/icons/icon.png, the Mortiflix ink + violet mark) and launcher
install -m755 "$NEW" "$BIN"
for s in $SIZES; do
  mkdir -p "$ICONS/${s}x${s}/apps"
  magick "$HERE/src-tauri/icons/icon.png" -resize "${s}x${s}" "$ICONS/${s}x${s}/apps/com.mortiflix.studio.png"
done
cat > "$DESK" <<EOF
[Desktop Entry]
Type=Application
Name=Mortiflix Studio
GenericName=Video Studio
Comment=Make a video with AI, step by step, approving every stage
Exec=$BIN
TryExec=$BIN
Icon=com.mortiflix.studio
Terminal=false
StartupNotify=true
StartupWMClass=mortiflix-studio
Categories=AudioVideo;Video;
Keywords=video;studio;ai;mortiflix;
EOF
refresh
echo "installed $BIN (old app kept in $OLD)"
