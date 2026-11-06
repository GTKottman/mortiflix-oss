// A stand-in for mortiflix-engine in tests: speaks the same JSON lines. FAKE_MODE: ok | silent (stops talking after
// hello) | crash (exits 1 after hello) ; FAKE_COUNT file counts starts; FAKE_CALLS file logs device/clock/transport calls.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.env.FAKE_MODE || 'ok';
let pos = 0;
if (process.env.FAKE_COUNT) appendFileSync(process.env.FAKE_COUNT, 'x');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let alive = setInterval(() => out({ ev: 'alive', uptimeMs: Math.round(process.uptime() * 1000) }), 200);
process.stderr.write('fake engine started\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (mode === 'silent' && m.cmd !== 'engine.hello') return;
  if (m.cmd === 'engine.hello') {
    out({ id: m.id, ok: true, result: { name: 'fake', rate: 48000 } });
    if (mode === 'silent') clearInterval(alive);
    if (mode === 'crash') setTimeout(() => { process.stderr.write('fake engine crashing\n'); process.exit(1); }, 50);
    return;
  }
  if (m.cmd === 'engine.ping') return out({ id: m.id, ok: true, result: {} });
  if (m.cmd === 'engine.quit') { out({ id: m.id, ok: true, result: {} }); clearInterval(alive); setTimeout(() => process.exit(0), 10); return; }
  if (process.env.FAKE_CALLS) appendFileSync(process.env.FAKE_CALLS, `${JSON.stringify({ cmd: m.cmd, args: m.args })}\n`);
  if (m.cmd === 'song.load') return out({ id: m.id, ok: true, result: { loaded: m.args.path, at: m.args.atSample } });
  if (m.cmd === 'device.set') return out({ id: m.id, ok: true, result: { backend: m.args.backend } });
  if (m.cmd === 'clock.subscribe') return out({ id: m.id, ok: true, result: {} });
  if (m.cmd === 'transport.play' || m.cmd === 'transport.seek') return out({ id: m.id, ok: true, result: { playing: m.cmd === 'transport.play', seconds: (pos = m.args.seconds ?? pos) } });
  if (m.cmd === 'engine.tone') { out({ ev: 'log', level: 'info', text: `tone ${m.args.hz}` }); return out({ id: m.id, ok: true, result: {} }); }
  out({ id: m.id, ok: false, error: `unknown command ${m.cmd}` });
});
process.stdin.on('end', () => process.exit(0));
