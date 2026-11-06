#!/usr/bin/env python3
"""Stop the browser-harness daemon(s) started with BU_NAME=<name> on the studio browser :9333 (kill by PID only)."""
import os, signal, subprocess, sys
name = sys.argv[1]
daemon = os.path.expanduser('~/.local/share/uv/tools/browser-harness/bin/python') + ' -m browser_harness.daemon'
out = subprocess.run(['pgrep', '-f', '^' + daemon],
                     capture_output=True, text=True).stdout.split()
for p in map(int, out):
    try:
        env = dict(l.split('=', 1) for l in open(f'/proc/{p}/environ', 'rb').read().decode(errors='ignore').split('\0') if '=' in l)
    except OSError:
        continue
    if env.get('BU_NAME') == name and env.get('BU_CDP_URL') == 'http://127.0.0.1:9333':
        try: os.kill(p, signal.SIGTERM)
        except OSError: pass
