import { describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../src/lib/service/client';
import { Basket } from '../src/screens/voice/basket.svelte';
import type { VoiceService } from '../src/screens/voice/mock';

function basketWith(
  call: (type: string, params: Record<string, unknown>) => Promise<unknown>,
  noKey: string | null = null,
) {
  const service = { call, on: () => () => undefined } as unknown as VoiceService;
  const refresh = vi.fn(async () => undefined);
  const basket = new Basket({ service, lines: () => [], noKey: () => noKey, sent: () => undefined, refresh });
  return { basket, refresh };
}

describe('the queue', () => {
  it('queues a new read with its cost and sends nothing', async () => {
    const calls: string[] = [];
    const { basket } = basketWith(async (type) => {
      calls.push(type);
      return { needs_confirm: true, credits_estimate: 41 };
    });
    await basket.stageTakes(['b01-1', 'b01-2'], 'new read');
    expect(basket.size).toBe(2);
    expect(basket.lines.get('b01-1')?.credits).toBe(41);
    expect(calls).toEqual(['voice.line.take', 'voice.line.take']);
  });

  it('queues nothing while ElevenLabs has no key, and says why', async () => {
    const { basket } = basketWith(async () => ({}), 'No key saved.');
    await basket.stageTakes(['b01-1'], 'new read');
    basket.stage('b01-1', { tags: ['wry'] });
    expect(basket.size).toBe(0);
    expect(basket.error).toBe('No key saved.');
  });

  it('stops at the first billing refusal and says nothing else was sent', async () => {
    const sent: string[] = [];
    const { basket, refresh } = basketWith(async (type, params) => {
      if (params.confirm) {
        sent.push(String(params.line));
        throw new ServiceError('ElevenLabs refused: out of credits', 'billing');
      }
      return { needs_confirm: true, credits_estimate: 5 };
    });
    await basket.stageTakes(['b01-1', 'b01-2'], 'new read');
    await basket.run(false);
    expect(sent).toEqual(['b01-1']);
    expect(basket.error).toBe(
      'ElevenLabs stopped: ElevenLabs refused: out of credits (402). Nothing else was sent.',
    );
    expect(basket.failed.has('b01-1')).toBe(true);
    expect(basket.size).toBe(2);
    expect(basket.making).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('makes only the first item for "Test 1 first"', async () => {
    const sent: string[] = [];
    const { basket } = basketWith(async (_type, params) => {
      if (params.confirm) sent.push(String(params.line));
      return { needs_confirm: true, credits_estimate: 5 };
    });
    await basket.stageTakes(['a', 'b', 'c'], 'new read');
    await basket.run(true);
    expect(sent).toEqual(['a']);
    expect(basket.lines.has('a')).toBe(false);
    expect(basket.size).toBe(2);
  });

  it('drops a queued cue the plan no longer has and ends its estimate once measured', () => {
    const { basket } = basketWith(async () => ({}));
    basket.addCue('mc01', { credits: 10, seconds: 5, estimate: true });
    basket.addCue('mc02', { credits: 10, seconds: 5, estimate: true });
    basket.syncCues(['mc01'], true);
    expect([...basket.cues.keys()]).toEqual(['mc01']);
    expect(basket.cues.get('mc01')?.estimate).toBe(false);
  });
});
