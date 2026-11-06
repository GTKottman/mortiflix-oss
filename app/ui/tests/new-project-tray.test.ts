import { describe, expect, it, vi } from 'vitest';
import { formatSize, isInTray, linkProblem, statusText, type TraySource } from '../src/lib/source-tray';
import { Problems } from '../src/lib/stores/problems.svelte';
import { Draft } from '../src/screens/new-project/draft.svelte';
import { safeZoneNote, safeZoneShape } from '../src/screens/new-project/safeZone';
import type { SoftService } from '../src/screens/new-project/soft-service';

const page: TraySource = { id: 's1', kind: 'url', label: 'A page', url: 'https://a.test/x', status: 'ready' };

describe('the source tray', () => {
  it('refuses what is not a web link, and a link already there', () => {
    expect(linkProblem('hello', [])).toBe('A link starts with http:// or https://');
    expect(linkProblem('https://a.test/x', [page])).toBe('That link is already in the tray.');
    expect(linkProblem('https://b.test/y', [page])).toBeNull();
  });

  it('says what became of each source in plain words', () => {
    expect(statusText({ ...page, status: 'fetching' })).toBe('Reading…');
    expect(statusText({ ...page, status: 'stored', bytes: 310000 })).toBe('Kept as it is · 310 KB');
    expect(statusText({ ...page, status: 'ready', text: 'Read · 12 pages' })).toBe('Read · 12 pages');
    expect(statusText({ ...page, status: 'failed' })).toBe('Could not read this');
    expect(statusText({ ...page, status: 'failed', text: 'That page is gone (404).' })).toBe(
      'That page is gone (404).',
    );
  });

  it('writes sizes and spots a file already added', () => {
    expect(formatSize(2.4e6)).toBe('2.4 MB');
    expect(formatSize(10)).toBe('1 KB');
    const file = new File(['abc'], 'quotes.pdf');
    expect(isInTray(file, [{ ...page, label: 'quotes.pdf', bytes: 3 }])).toBe(true);
    expect(isInTray(file, [page])).toBe(false);
  });
});

describe('the safe zone drawing', () => {
  it('is wide for 16:9 and marks the covered edges only on tall shapes', () => {
    const wide = safeZoneShape('16:9');
    expect(wide).toMatchObject({ width: 160, height: 90, covered: [] });
    const tall = safeZoneShape('9:16');
    expect(tall.width).toBe(51);
    expect(tall.covered).toHaveLength(2);
  });

  it('explains the red areas whenever they are drawn, and draws 16:9 for a shape it cannot read', () => {
    expect(safeZoneShape('4:5').covered).toHaveLength(2);
    expect(safeZoneNote('4:5')).toContain('Red:');
    expect(safeZoneNote('1:1')).not.toContain('Red:');
    expect(safeZoneShape('auto')).toEqual(safeZoneShape('16:9'));
  });
});

describe('the draft', () => {
  const source = { contract: () => ({ version: 1, idea: 'x' }), open: () => ({}), hasContent: () => true };

  it('says when the service did not keep it', async () => {
    const soft = { call: vi.fn(async () => undefined) } as unknown as SoftService;
    const draft = new Draft(soft, new Problems(), source);
    await draft.save(true);
    expect(draft.saved).toBe('Draft kept in this browser only');
  });

  it('once the project exists, a save still waiting never brings the draft back', async () => {
    vi.useFakeTimers();
    const call = vi.fn<(type: string) => Promise<{ draft: string }>>(async () => ({ draft: 'd1' }));
    const draft = new Draft({ call } as unknown as SoftService, new Problems(), source);
    await draft.save(true);
    await draft.save();
    draft.finish();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(call.mock.calls.map(([type]) => type)).toEqual(['brief.draft.save', 'brief.draft.delete']);
    expect(draft.id).toBeNull();
  });
});
