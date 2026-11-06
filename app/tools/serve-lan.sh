#!/usr/bin/env bash
# Serve Mortiflix Studio to the home network and prove every route works from the LAN address.
#   tools/serve-lan.sh            restart the bridge in LAN mode (MFX_BRIDGE_LAN=1) on :4646, then test
#   tools/serve-lan.sh --test     only test
# Prints the links to give out. Any FAIL line = broken for other devices.
# MFX_BRIDGE_LAN=1 forces home-network access on, whatever Settings > Home network says (that switch, off by default,
# turns it on and off without a restart).
set -u
cd "$(dirname "$0")/.."
PORT=4646
STUDIO=${MORTIFLIX_STUDIO:-$HOME/Mortiflix}
LOG=${TMPDIR:-/tmp}/mfx-bridge-lan.log
IPS=$(ip -4 -o addr | awk '$2!="lo" && $4 ~ /^(192\.168|10\.)/ {split($4,a,"/"); print a[1]}')

if [ "${1:-}" != "--test" ]; then
  # Only this repo's own bridge is stopped (kill by PID, and only after checking what it is); anything else on the
  # port (another program, or a listener whose owner ss cannot see) is left alone and the script stops.
  old=$(ss -ltnpH "sport = :$PORT" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  if [ -z "$old" ] && ss -ltnH "sport = :$PORT" | grep -q .; then echo "port $PORT is in use by a program this user cannot see: stop it first"; exit 1; fi
  if [ -n "$old" ]; then
    if [ "$(readlink "/proc/$old/cwd")" != "$PWD" ] || ! tr '\0' ' ' < "/proc/$old/cmdline" | grep -q 'bridge\.mjs'; then
      echo "port $PORT is used by pid $old ($(tr '\0' ' ' < "/proc/$old/cmdline")), not this repo's bridge: stop it first"; exit 1
    fi
    kill "$old"; while ss -ltnH "sport = :$PORT" | grep -q .; do sleep 0.2; done
  fi
  MFX_BRIDGE_LAN=1 MORTIFLIX_STUDIO="$STUDIO" setsid nohup node bridge.mjs --port $PORT > "$LOG" 2>&1 < /dev/null &
  for _ in $(seq 1 50); do ss -ltnH "sport = :$PORT" | grep -q . && break; sleep 0.2; done
  for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$PORT/api/status" | grep -q '"up":true' && break; sleep 0.2; done
fi

img=$(find "$STUDIO/projects" -name '*.png' -size +10k 2>/dev/null | head -1)
q=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$img")
fails=0
check() { # name url
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$2")
  if [ "$code" = 200 ]; then echo "ok   $1"; else echo "FAIL $1 ($code) $2"; fails=$((fails+1)); fi
}
for ip in $IPS; do
  b="http://$ip:$PORT"
  check "$ip app page"   "$b/app/"
  check "$ip app script" "$b/app/$(grep -o 'assets/index-[^"]*\.js' web/app/index.html | head -1)"
  check "$ip picture"    "$b/file?path=$q"
  check "$ip thumbnail"  "$b/thumb?w=200&path=$q"
  check "$ip stills api" "$b/api/stills"
  body=$(curl -s -w '\n%{http_code}' --max-time 10 -X POST -H "Origin: $b" --data-binary 'x' "$b/api/upload?name=lan-check.txt")
  up=${body##*$'\n'}
  if [ "$up" = 200 ]; then echo "ok   $ip upload"; else echo "FAIL $ip upload ($up)"; fails=$((fails+1)); fi
  # the check file is not kept in <studio>/uploads/
  f=$(printf '%s' "${body%$'\n'*}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("path",""))' 2>/dev/null)
  case "$f" in "$STUDIO"/uploads/*-lan-check.txt) rm -f -- "$f" ;; esac
  if node -e "
    const W=require('ws');const w=new W('ws://$ip:$PORT/ws',{headers:{Origin:'$b'}});
    const t=setTimeout(()=>process.exit(1),8000);
    w.on('message',m=>{if(String(m).includes('\"up\":true')){clearTimeout(t);process.exit(0)}});w.on('error',()=>process.exit(1));"; then
    echo "ok   $ip live connection"; else echo "FAIL $ip live connection"; fails=$((fails+1)); fi
done
echo
for ip in $IPS; do echo "link: http://$ip:$PORT/app/"; done
[ $fails = 0 ] && echo "ALL OK" || echo "$fails FAILED"
exit $fails
