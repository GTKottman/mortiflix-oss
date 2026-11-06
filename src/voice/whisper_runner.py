#!/usr/bin/env python3
# Local speech to text for the owner's spoken notes: faster-whisper (free, offline). One audio file in, one JSON line out.
#   python whisper_runner.py <audio> [model]    model: a size (tiny, base, small ...) or a folder; default "base"
# stdout: {"ok": true, "text": "...", "language": "en"} or {"ok": false, "error": "..."}. Library chatter goes to stderr.
import json
import os
import sys

out = os.fdopen(os.dup(1), 'w', buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr
try:
    from faster_whisper import WhisperModel
    audio = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else 'base'
    m = WhisperModel(model, device='auto', compute_type='int8')
    segs, info = m.transcribe(audio, vad_filter=True)
    out.write(json.dumps({'ok': True, 'text': ' '.join(s.text.strip() for s in segs).strip(), 'language': info.language}) + '\n')
except Exception as e:  # noqa: BLE001
    out.write(json.dumps({'ok': False, 'error': str(e)[:400]}) + '\n')
