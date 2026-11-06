// JSON-lines client for the Mortiflix service over stdio (the same transport the app's bridge.mjs uses):
// request {id,type,params} -> reply {id,ok,result|error}; events {event,data}. No sockets.
export class ServiceError extends Error {
  constructor(message, code, type) { super(message); this.name = 'ServiceError'; this.code = code; this.type = type; }
}

export class LineClient {
  // stdin: writable, stdout: readable (utf8 JSON lines)
  constructor({ stdin, stdout, timeoutMs = 30000, keepEvents = 400 }) {
    this.stdin = stdin; this.timeoutMs = timeoutMs; this.keepEvents = keepEvents;
    this.nextId = 1; this.pending = new Map(); this.events = []; this.errors = []; this.listeners = new Set();
    this.closed = false; this.buf = '';
    stdout.setEncoding?.('utf8');
    stdout.on('data', (c) => this.#data(String(c)));
    stdout.on('end', () => this.#down('service output closed'));
    stdout.on('close', () => this.#down('service output closed'));
    stdin.on?.('error', () => {});
  }
  #data(chunk) {
    this.buf += chunk; let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1);
      if (line) this.#line(line);
    }
  }
  #line(line) {
    let m; try { m = JSON.parse(line); } catch { this.badLines = (this.badLines || 0) + 1; return; }
    if (m.event) {
      const ev = { t: Date.now(), event: m.event, data: m.data };
      this.events.push(ev); if (this.events.length > this.keepEvents) this.events.shift();
      for (const fn of this.listeners) { try { fn(ev); } catch {} }
      return;
    }
    const p = this.pending.get(m.id); if (!p) return;
    this.pending.delete(m.id); clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else {
      const e = new ServiceError(m.error?.message || 'failed', m.error?.code, p.type);
      this.errors.push({ t: Date.now(), type: p.type, code: e.code, message: e.message });
      p.reject(e);
    }
  }
  #down(why) {
    if (this.closed) return; this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new ServiceError(why, 'service_down', p.type)); }
    this.pending.clear();
  }
  call(type, params = {}, { timeout } = {}) {
    if (this.closed) return Promise.reject(new ServiceError('service is down', 'service_down', type));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const e = new ServiceError(`no reply to ${type} in ${(timeout ?? this.timeoutMs) / 1000}s`, 'timeout', type);
        this.errors.push({ t: Date.now(), type, code: 'timeout', message: e.message });
        reject(e);
      }, timeout ?? this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type });
      try { this.stdin.write(JSON.stringify({ id, type, params }) + '\n'); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(new ServiceError(e.message, 'write_failed', type)); }
    });
  }
  // a call that returns {ok, result|error} instead of throwing
  async soft(type, params, opts) {
    try { return { ok: true, result: await this.call(type, params, opts) }; }
    catch (e) { return { ok: false, error: { code: e.code, message: e.message } }; }
  }
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  recent(n = 5) { return this.events.slice(-n).map((e) => ({ event: e.event, data: clip(e.data) })); }
}

export function clip(v, max = 300) {
  let s; try { s = JSON.stringify(v); } catch { s = String(v); }
  if (s == null) return s;
  return s.length > max ? s.slice(0, max) + '...' : s;
}
