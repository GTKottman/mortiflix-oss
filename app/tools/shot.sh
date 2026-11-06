#!/bin/sh
# usage: BU_NAME=<unique> [W=1920 H=1080] tools/shot.sh <url> <out.png>   (studio browser :9333)
# Viewports: desktop W=1920 H=1080 · laptop W=1366 H=768 (owner 2026-11-01: phone and tablet out of scope)
# Stops its own browser-harness daemon afterwards (2026-11-01: 276 leftover daemons slowed the PC). KEEP=1 keeps it.
[ -n "$BU_NAME" ] || { echo "set BU_NAME to something unique" >&2; exit 1; }
W=${W:-1920}; H=${H:-1080}
MOB=False; [ "$W" -lt 900 ] && MOB=True
export BU_NAME BU_CDP_URL=http://127.0.0.1:9333
# Tabs open before our daemon starts (a fresh daemon attaches by creating a blank tab of its own, which is ours to close).
export SHOT_BEFORE=$(curl -s -m5 "$BU_CDP_URL/json/list" | python3 -c "import sys,json;print(' '.join(t['id'] for t in json.load(sys.stdin)))" 2>/dev/null)
timeout 90 browser-harness <<PY
import time
# Own tab only: open one, close exactly that one in finally (also on error). An open screen keeps a live socket to the
# service (374 left open slowed it to 90 s a call), and a tab this script did not open is never touched.
import os
before = set(os.environ.get("SHOT_BEFORE", "").split())
try: attached = current_tab()["targetId"]   # a fresh daemon attaches by creating a blank tab when none is open: that one is ours too
except Exception: attached = None
mine = [attached] if attached and attached not in before else []
tid = new_tab("about:blank")
mine.append(tid)
try:
    cdp("Emulation.setDeviceMetricsOverride", width=$W, height=$H, deviceScaleFactor=1, mobile=$MOB)
    goto_url("$1"); wait_for_load(); time.sleep(${SHOT_WAIT:-2.5})
    capture_screenshot("$2")
    print("ok $2")
finally:
    for t in mine:
        try: cdp("Target.closeTarget", targetId=t)
        except Exception: pass
PY
rc=$?
[ -n "$KEEP" ] || python3 "$(dirname "$0")/stop-daemon.py" "$BU_NAME"
exit $rc
