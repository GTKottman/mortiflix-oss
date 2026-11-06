#!/usr/bin/env bash
# Runs one command in one of N screenshot slots (default 30; owner 2026-11-01: "we should be doing 9 to 30").
# Usage: tools/shot-slot.sh tools/shot.sh <url> <out.png>   (env SHOT_SLOTS=N to change)
N=${SHOT_SLOTS:-30}
D=/tmp/claude-$(id -u)/mfx-shot-slots; mkdir -p "$D"
while :; do
  for i in $(seq 1 "$N"); do
    exec {fd}>"$D/$i.lock"
    if flock -n "$fd"; then "$@"; rc=$?; flock -u "$fd"; exit $rc; fi
    exec {fd}>&-
  done
  sleep 1
done
