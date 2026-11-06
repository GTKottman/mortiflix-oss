import { describe, expect, it, vi } from 'vitest';
import type { ServiceClient } from '../src/lib/service/client';
import { autosize } from '../src/screens/script/autosize';
import { serviceSource } from '../src/screens/script/source';

const fakeClient = () => {
  const call = vi.fn().mockResolvedValue({});
  return { call, client: { call } as unknown as ServiceClient };
};

describe('serviceSource', () => {
  it('is not a fixture and reads the script and the voice from the service', async () => {
    const { call, client } = fakeClient();
    call.mockResolvedValueOnce({ project: 'p', rev: 1, beats: [] });
    const source = serviceSource(client);
    expect(source.isFixture).toBe(false);
    await source.script();
    await source.voice();
    expect(call).toHaveBeenNthCalledWith(1, 'script.get');
    expect(call).toHaveBeenNthCalledWith(2, 'voice.lines');
  });

  it('reads a scene without a visual (null from the service) as no visual', async () => {
    const call = vi.fn().mockResolvedValue({
      project: 'p',
      rev: 1,
      beats: [{ id: 'b01', no: 1, name: 'A', visual: null, state: null, lines: [] }],
    });
    const data = await serviceSource({ call } as unknown as ServiceClient).script();
    expect(data.beats[0]?.visual).toBeUndefined();
  });

  it('sends a typed Fix: a scene as node.edit fix, the whole script as review.respond changes', async () => {
    const { call, client } = fakeClient();
    const source = serviceSource(client);
    await source.fixScene('b2', 'Make it punchier');
    await source.fixScript('Drop the jargon everywhere');
    expect(call).toHaveBeenCalledWith('node.edit', { node: 'b2', action: 'fix', text: 'Make it punchier' });
    expect(call).toHaveBeenCalledWith('review.respond', {
      step: 'script',
      verdict: 'changes',
      notes: 'Drop the jargon everywhere',
    });
    await source.fixScript('Tighter', 'script');
    expect(call).toHaveBeenCalledWith('stage.reopen', { stage: 'script', text: 'Tighter' });
  });

  it('sends edits, decisions and the unsaved words with the names the service expects', async () => {
    const { call, client } = fakeClient();
    const source = serviceSource(client);
    await source.edit([{ beat: 'b1', line: 'b1-1', words: 'New words.' }]);
    await source.decide('b1', 'ok');
    expect(call).toHaveBeenCalledWith('script.edit', {
      edits: [{ beat: 'b1', line: 'b1-1', words: 'New words.' }],
    });
    expect(call).toHaveBeenCalledWith('node.edit', { node: 'b1', action: 'ok' });
  });

  it('keeps a draft, and clears it with null', async () => {
    const { call, client } = fakeClient();
    const source = serviceSource(client);
    await source.keepDraft({ 'b1-1': 'Draft.' });
    await source.keepDraft(null);
    expect(call).toHaveBeenNthCalledWith(1, 'script.draft', { draft: { lines: { 'b1-1': 'Draft.' } } });
    expect(call).toHaveBeenNthCalledWith(2, 'script.draft', { draft: null });
  });
});

describe('autosize', () => {
  const box = (scrollHeight: number) =>
    ({ style: { height: '' }, scrollHeight }) as unknown as HTMLTextAreaElement;

  it('fits the box to its words, plus the border', () => {
    const node = box(80);
    autosize(node, 'Some words');
    expect(node.style.height).toBe('82px');
  });

  it('fits again when the words change', () => {
    const node = box(40);
    const action = autosize(node, 'Short');
    (node as unknown as { scrollHeight: number }).scrollHeight = 120;
    action.update();
    expect(node.style.height).toBe('122px');
  });
});
