import { describe, expect, it } from 'vitest';
import { ServiceClient, type SocketLike } from '../src/lib/service/client';

// Every tab works on its own project (RUN-BUGS Dir1): calls carry the tab's id, and events for another project are dropped.

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: { id: number; type: string; params: Record<string, unknown> }[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  push(event: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ event, data }) } as MessageEvent);
  }
}

function client(project: string | null) {
  const socket = new FakeSocket();
  const c = new ServiceClient(() => socket);
  c.connect();
  c.setProject(() => project);
  return { c, socket };
}

describe('tab project', () => {
  it('adds the tab project to every project call', () => {
    const { c, socket } = client('tab-a');
    void c.call('chat.answer', { question: 'q1', value: 'yes' });
    void c.call('review.respond', { step: 'brief', verdict: 'ok' });
    void c.call('stage.set', { stage: 2 });
    expect(socket.sent.map((m) => m.params.project)).toEqual(['tab-a', 'tab-a', 'tab-a']);
  });
  it('keeps a project the caller names, and leaves list and open calls alone', () => {
    const { c, socket } = client('tab-a');
    void c.call('project.open', { id: 'tab-b' });
    void c.call('project.list');
    void c.call('usage.get', { range: 'today' });
    void c.call('stage.status', { project: 'tab-c' });
    expect(socket.sent.map((m) => m.params.project)).toEqual([undefined, undefined, undefined, 'tab-c']);
  });
  it('adds nothing when the tab has no project yet', () => {
    const { c, socket } = client(null);
    void c.call('script.get');
    expect(socket.sent[0]?.params).toEqual({});
  });
  it('drops events for another project and keeps its own and project-less ones', () => {
    const { c, socket } = client('tab-a');
    const seen: string[] = [];
    c.on<{ project?: string }>('*', (data, event) => seen.push(`${event}:${data?.project ?? '-'}`));
    socket.push('node.changed', { project: 'tab-b', nodes: [] });
    socket.push('status', { project: null });
    socket.push('node.changed', { project: 'tab-a', nodes: [] });
    socket.push('lessons.changed', {});
    socket.push('project.changed', { id: 'tab-b' });
    socket.push('usage.changed', { project: 'tab-b' });
    expect(seen).toEqual([
      'node.changed:tab-a',
      'lessons.changed:-',
      'project.changed:-',
      'usage.changed:tab-b',
    ]);
  });
});
