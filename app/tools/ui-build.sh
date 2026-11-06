#!/usr/bin/env bash
# One Svelte build at a time (owner: no overlapping builds). Every agent builds through this:
#   tools/ui-build.sh            -> vite build into web/app/
#   tools/ui-build.sh check      -> npm run check (typecheck + lint + format + tests)
set -euo pipefail
cd "$(dirname "$0")/../ui"
L=/tmp/claude-$(id -u); mkdir -p "$L"   # the shared lock folder may not exist yet (fresh boot, /tmp cleaned)
exec 9>"$L/mfx-ui-build.lock"
flock 9
case "${1:-build}" in
  build)
    timeout 300 npx vite build --logLevel warn ;;   # empties web/app/ first (vite.config.ts emptyOutDir: true)
  check) timeout 600 npm run check ;;
  *) echo "usage: tools/ui-build.sh [build|check]" >&2; exit 2 ;;
esac
