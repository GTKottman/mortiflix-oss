import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNotBuiltYet, ServiceClient, ServiceError, type SocketLike } from '../src/lib/service/client';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: { id: number; type: string; params: Record<string, unknown> }[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(message: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  last() {
    const call = this.sent.at(-1);
    if (!call) throw new Error('nothing sent');
    return call;
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const client = new ServiceClient(
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    { reconnectMs: 50 },
  );
  client.connect();
  const socket = () => sockets.at(-1) as FakeSocket;
  return { client, sockets, socket };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ServiceClient', () => {
  it('queues calls until the socket opens, then resolves with the result', async () => {
    const { client, socket } = setup();
    const answer = client.call<{ project: string }>('state.get');
    expect(socket().sent).toHaveLength(0);
    socket().open();
    expect(socket().last()).toMatchObject({ type: 'state.get', params: {} });
    socket().receive({ id: socket().last().id, ok: true, result: { project: 'black-october' } });
    await expect(answer).resolves.toEqual({ project: 'black-october' });
  });

  it('rejects with the service error code', async () => {
    const { client, socket } = setup();
    socket().open();
    const answer = client.call('usage.get', { range: 'today' });
    socket().receive({
      id: socket().last().id,
      ok: false,
      error: { message: 'unknown type', code: 'unknown_type' },
    });
    const error = await answer.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect(isNotBuiltYet(error)).toBe(true);
  });

  it('sends a call once more when the service comes back after service_down', async () => {
    const { client, socket } = setup();
    socket().open();
    const answer = client.call<number>('stage.status');
    socket().receive({ id: socket().last().id, ok: false, error: { message: 'down', code: 'service_down' } });
    await Promise.resolve();
    expect(socket().sent).toHaveLength(1);
    socket().receive({ event: 'bridge.state', data: { up: true } });
    await vi.waitFor(() => expect(socket().sent).toHaveLength(2));
    socket().receive({ id: socket().last().id, ok: true, result: 7 });
    await expect(answer).resolves.toBe(7);
  });

  it('keeps a call made while the link is down and sends it once the new socket opens', async () => {
    vi.useFakeTimers();
    const { client, sockets, socket } = setup();
    socket().open();
    socket().close();
    const answer = client.call<string>('music.plan.make', { project: 'p1' });
    expect(sockets[0]?.sent).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    expect(socket().sent).toHaveLength(0);
    socket().open();
    expect(socket().sent).toEqual([
      { id: socket().last().id, type: 'music.plan.make', params: { project: 'p1' } },
    ]);
    socket().receive({ id: socket().last().id, ok: true, result: 'planned' });
    await expect(answer).resolves.toBe('planned');
    client.disconnect();
  });

  it('sends queued calls in the order they were made, each exactly once', () => {
    const { client, socket } = setup();
    void client.call('voicemusic.view');
    void client.call('voice.list');
    void client.call('cast.get');
    socket().open();
    socket().open();
    expect(socket().sent.map((call) => call.type)).toEqual(['voicemusic.view', 'voice.list', 'cast.get']);
  });

  it('fails a call that went out on a socket that dropped, instead of waiting forever', async () => {
    const { client, socket } = setup();
    socket().open();
    const answer = client.call('voice.line.take', { line: 'b01-1' });
    socket().close();
    const error = await answer.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('link_lost');
    client.disconnect();
  });

  it('fans events out to listeners and "*", and stops when told', () => {
    const { client, socket } = setup();
    const one = vi.fn();
    const all = vi.fn();
    const stop = client.on('status', one);
    client.on('*', all);
    socket().receive({ event: 'status', data: { title: 'A' } });
    stop();
    socket().receive({ event: 'status', data: { title: 'B' } });
    expect(one).toHaveBeenCalledTimes(1);
    expect(one).toHaveBeenCalledWith({ title: 'A' }, 'status');
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('tracks the link and reconnects after the socket closes', () => {
    vi.useFakeTimers();
    const { client, sockets, socket } = setup();
    const links: string[] = [];
    client.on<string>('link', (link) => links.push(link));
    socket().open();
    socket().receive({ event: 'bridge.state', data: { up: true } });
    expect(client.up).toBe(true);
    socket().close();
    expect(client.up).toBe(false);
    expect(client.link).toBe('lost');
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    expect(links).toEqual(['restart', 'ok', 'lost']);
    client.disconnect();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
  });
});
