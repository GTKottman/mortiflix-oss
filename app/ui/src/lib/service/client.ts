import { BASE } from '../base';
// The one connection to the Mortiflix service, through the bridge's WebSocket at /ws.
// Same behaviour as web/app.js (mfx): calls are queued until the socket opens, events fan out to listeners,
// the socket reconnects by itself, and a call that meets a restarting service is sent once more when it is back.

/** 'ok' = connected; 'restart' = the bridge is up but the service is restarting; 'lost' = no socket. */
export type LinkState = 'ok' | 'restart' | 'lost';

export type Listener<T = unknown> = (data: T, event: string) => void;

/** The part of a WebSocket the client uses, so tests can hand in a fake one. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((message: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

export type SocketFactory = () => SocketLike;

export interface BridgeState {
  up: boolean;
  hello?: unknown;
}

/** A call the service refused or could not finish. `code` is the service's error code, e.g. 'unknown_type'. */
export class ServiceError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

/** True when the service does not know this request yet: show "Coming in this build", never invented data. */
export const isNotBuiltYet = (error: unknown): boolean =>
  error instanceof ServiceError && error.code === 'unknown_type';

interface Reply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message?: string; code?: string };
}
interface EventMessage {
  event: string;
  data: unknown;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Went out on the socket (not just queued). */
  sent: boolean;
}

const SOCKET_OPEN = 1;

/**
 * Requests that must NOT get the tab's project added: they list or open projects, or their `project` means
 * "only this project" where the caller wants all of them (usage.get). Every other call carries the tab's project,
 * because the service's one open project may belong to another tab (RUN-BUGS Dir1: an OK landed on the wrong project).
 */
const NO_PROJECT: ReadonlySet<string> = new Set([
  'state.get',
  'project.list',
  'project.new',
  'project.open',
  'project.close',
  'usage.get',
  'render.list',
]);

/** Events about every project (Home's list, the token counter): never dropped for naming another project. */
const ALL_PROJECTS: ReadonlySet<string> = new Set([
  'project.changed',
  'usage.changed',
  'bridge.state',
  'link',
]);

/** The `project` an event names, or undefined when it names none. */
function projectOf(data: unknown): string | null | undefined {
  if (!data || typeof data !== 'object' || !('project' in data)) return undefined;
  const value = (data as { project?: unknown }).project;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string')
    return (value as { id: string }).id;
  return undefined;
}

export class ServiceClient {
  readonly #openSocket: SocketFactory;
  readonly #reconnectMs: number;
  readonly #reconnectMaxMs: number;
  /** Reconnect attempts since the last open socket (drives the backoff). */
  #attempts = 0;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #pending = new Map<number, Pending>();
  readonly #queue: { id: number; text: string }[] = [];
  #socket: SocketLike | null = null;
  #nextId = 1;
  #up = false;
  #link: LinkState = 'ok';
  #stopped = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #tabProject: () => string | null = () => null;

  constructor(
    openSocket: SocketFactory,
    { reconnectMs = 1000, reconnectMaxMs = 30000 }: { reconnectMs?: number; reconnectMaxMs?: number } = {},
  ) {
    this.#openSocket = openSocket;
    this.#reconnectMs = reconnectMs;
    this.#reconnectMaxMs = reconnectMaxMs;
  }

  /** The service is running behind the bridge. */
  get up(): boolean {
    return this.#up;
  }

  get link(): LinkState {
    return this.#link;
  }

  connect(): void {
    this.#stopped = false;
    clearTimeout(this.#reconnectTimer);
    // One live socket at a time: a socket replaced here must not flush the queue, answer calls or reconnect.
    const old = this.#socket;
    this.#socket = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = null;
      old.close();
      this.#failSent();
    }
    let socket: SocketLike;
    try {
      socket = this.#openSocket();
    } catch (error) {
      // The constructor can throw (MDN: SyntaxError for a bad URL). Keep trying instead of ending the loop.
      console.error(error);
      this.#failSent();
      this.#up = false;
      this.#setLink('lost');
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#attempts = 0;
      this.#setLink(this.#up ? 'ok' : 'restart');
      for (const { id, text } of this.#queue.splice(0)) this.#write(socket, id, text);
    };
    socket.onmessage = (message) => {
      if (this.#socket === socket) this.#receive(message.data);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#failSent();
      this.#up = false;
      this.#setLink('lost');
      this.#emit('bridge.state', { up: false } satisfies BridgeState);
      this.#scheduleReconnect();
    };
  }

  /**
   * Capped exponential backoff with full jitter (AWS Architecture Blog, "Exponential Backoff And Jitter"):
   * wait a random time between 0 and min(cap, base * 2^attempt), so many tabs do not reconnect in one burst.
   */
  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const ceiling = Math.min(this.#reconnectMaxMs, this.#reconnectMs * 2 ** this.#attempts);
    this.#attempts = Math.min(this.#attempts + 1, 30);
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.connect(), Math.random() * ceiling);
  }

  /** Fails every call that went out on the socket that is gone. Queued (never sent) calls stay queued. */
  #failSent(): void {
    // Calls already sent will never be answered on this socket: fail them now, so no screen waits forever.
    // Not resent by itself: the service may have done the work before the link dropped.
    for (const [id, pending] of this.#pending) {
      if (!pending.sent) continue;
      this.#pending.delete(id);
      pending.reject(new ServiceError('the link to the studio dropped before it answered', 'link_lost'));
    }
  }

  /** Stops reconnecting and closes the socket (tests, page teardown). */
  disconnect(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    // calls still waiting to be sent never will be: fail them now (sent ones fail in the socket's onclose)
    this.#queue.splice(0);
    for (const [id, pending] of this.#pending) {
      if (pending.sent) continue;
      this.#pending.delete(id);
      pending.reject(new ServiceError('the studio link was closed before this was sent', 'closed'));
    }
    this.#socket?.close();
  }

  /**
   * The project this tab works on. From now on every call carries it as `project` (unless the call names its own
   * or lists projects), and an event naming another project never reaches this tab's listeners.
   */
  setProject(get: () => string | null): void {
    this.#tabProject = get;
  }

  /** The tab's project now (null on Home before one is opened). */
  get project(): string | null {
    return this.#tabProject();
  }

  /**
   * Sends one request. Resolves with its result, rejects with a ServiceError.
   * Retried once only on `service_down`: the bridge answers that when the request never reached the service
   * (bridge.mjs, `!up`). A service that died while the request was running answers `service_stopped`, and a
   * dropped link answers `link_lost`: neither is resent, the work may already have been done (paid calls).
   */
  async call<T>(type: string, given: Record<string, unknown> = {}): Promise<T> {
    const params = this.#withProject(type, given);
    try {
      return (await this.#send(type, params)) as T;
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== 'service_down') throw error;
      await this.#whenUp();
      return (await this.#send(type, params)) as T;
    }
  }

  /** Listens to a service event ('*' = every event). Returns a function that stops listening. */
  on<T = unknown>(event: string, listener: Listener<T>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const stored = listener as Listener;
    set.add(stored);
    return () => set.delete(stored);
  }

  #withProject(type: string, params: Record<string, unknown>): Record<string, unknown> {
    if (NO_PROJECT.has(type) || Object.hasOwn(params, 'project')) return params;
    const project = this.#tabProject();
    return project ? { ...params, project } : params;
  }

  #send(type: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      let text: string;
      try {
        text = JSON.stringify({ id, type, params });
      } catch (error) {
        // MDN: stringify throws TypeError on a circular reference or a BigInt. Nothing was sent or kept.
        reject(new ServiceError(error instanceof Error ? error.message : String(error), 'bad_params'));
        return;
      }
      this.#pending.set(id, { resolve, reject, sent: false });
      if (this.#socket?.readyState === SOCKET_OPEN) this.#write(this.#socket, id, text);
      else this.#queue.push({ id, text });
    });
  }

  #write(socket: SocketLike, id: number, text: string): void {
    socket.send(text);
    const pending = this.#pending.get(id);
    if (pending) pending.sent = true;
  }

  #whenUp(): Promise<void> {
    if (this.#up) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.on<BridgeState>('bridge.state', (state) => {
        if (!state.up) return;
        stop();
        resolve();
      });
    });
  }

  #receive(raw: unknown): void {
    let message: Partial<Reply & EventMessage>;
    try {
      message = JSON.parse(String(raw)) as Partial<Reply & EventMessage>;
    } catch (error) {
      // MDN: JSON.parse throws SyntaxError on invalid JSON. One bad frame must not break the socket handler.
      console.error('mortiflix: unreadable message from the bridge', error);
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (typeof message.event === 'string') {
      if (message.event === 'bridge.state') {
        this.#up = Boolean((message.data as BridgeState | undefined)?.up);
        this.#setLink(this.#up ? 'ok' : 'restart');
      }
      if (this.#forOtherProject(message.event, message.data)) return;
      this.#emit(message.event, message.data);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new ServiceError(message.error?.message ?? 'failed', message.error?.code));
  }

  /** A push event about a project that is not this tab's: dropped, so it can never change this tab's screen. */
  #forOtherProject(event: string, data: unknown): boolean {
    if (ALL_PROJECTS.has(event)) return false;
    const mine = this.#tabProject();
    const named = projectOf(data);
    return Boolean(mine) && named !== undefined && named !== mine;
  }

  #setLink(link: LinkState): void {
    if (link === this.#link) return;
    this.#link = link;
    this.#emit('link', link);
  }

  #emit(event: string, data: unknown): void {
    for (const key of [event, '*']) {
      for (const listener of this.#listeners.get(key) ?? []) {
        try {
          listener(data, event);
        } catch (error) {
          console.error(error);
        }
      }
    }
  }
}

/** A client for the page's own bridge (ws://<host>/ws). */
export function createBrowserClient(): ServiceClient {
  const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return new ServiceClient(() => new WebSocket(`${scheme}${location.host}${BASE}/ws`));
}
