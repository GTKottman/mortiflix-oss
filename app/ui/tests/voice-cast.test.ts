import { describe, expect, it } from 'vitest';
import { CastStore } from '../src/screens/voice/cast.svelte';
import type { VoiceService } from '../src/screens/voice/mock';
import type { CastAnswer, CastMember } from '../src/screens/voice/types';

function service(answers: { current: CastAnswer | Error }) {
  const calls: { type: string; data?: unknown }[] = [];
  const fake = {
    call: async (type: string, data?: unknown) => {
      calls.push({ type, data });
      if (type === 'cast.get') {
        if (answers.current instanceof Error) throw answers.current;
        return answers.current;
      }
      return {};
    },
    on: () => () => {},
  } as unknown as VoiceService;
  return { fake, calls };
}

describe('cast store', () => {
  it('is not ready until the service has answered, and falls back to one narrator', () => {
    const { fake } = service({ current: { cast: [] } });
    const store = new CastStore(fake, () => 'Mark');
    expect(store.ready).toBe(false);
    expect(store.members).toEqual([{ role: 'narrator', name: 'Mark' }]);
    expect(store.speakerOf('narrator')).toEqual({ role: 'Narrator', name: 'Mark' });
  });

  it('prefers the fallback voice name, then "Voice"', async () => {
    const { fake } = service({ current: { cast: [], fallback: { role: 'x', name: 'Eli' } } });
    const store = new CastStore(fake, () => undefined);
    await store.load();
    expect(store.ready).toBe(true);
    expect(store.members[0]?.name).toBe('Eli');
    expect(new CastStore(fake, () => undefined).members[0]?.name).toBe('Voice');
  });

  it('lists the saved cast and finds a speaker by role', async () => {
    const cast: CastMember[] = [
      { role: 'narrator', name: 'Mark' },
      { role: 'dale', name: 'Dale K' },
    ];
    const { fake } = service({ current: { cast } });
    const store = new CastStore(fake, () => 'Other');
    await store.load();
    expect(store.member('dale')?.name).toBe('Dale K');
    expect(store.speakerOf('dale')).toEqual({ role: 'Dale', name: 'Dale K' });
    expect(store.speakerOf('ghost')).toEqual({ role: 'Ghost', name: '' });
  });

  it('goes back to not ready when the cast cannot be read', async () => {
    const answers = { current: { cast: [] } as CastAnswer | Error };
    const { fake } = service(answers);
    const store = new CastStore(fake, () => undefined);
    await store.load();
    answers.current = new Error('offline');
    await store.load();
    expect(store.ready).toBe(false);
  });

  it('saves a whole cast without engines and keeps the old one for Undo', async () => {
    const before: CastMember[] = [{ role: 'narrator', name: 'Mark', engine: 'v3' }];
    const answers = { current: { cast: before } as CastAnswer | Error };
    const { fake, calls } = service(answers);
    const store = new CastStore(fake, () => undefined);
    await store.load();
    answers.current = { cast: [{ role: 'narrator', name: 'Eli' }] };
    await store.save([{ role: 'narrator', name: 'Eli', engine: 'v3' }], {
      text: 'Eli now reads',
      role: 'narrator',
    });
    expect(calls.find((c) => c.type === 'cast.set')?.data).toEqual({
      cast: [{ role: 'narrator', name: 'Eli' }],
    });
    expect(store.note).toEqual({
      text: 'Eli now reads',
      role: 'narrator',
      before: [{ role: 'narrator', name: 'Mark' }],
    });
    expect(store.members[0]?.name).toBe('Eli');
  });

  it('leaves no note when the save has none', async () => {
    const { fake } = service({ current: { cast: [] } });
    const store = new CastStore(fake, () => undefined);
    await store.save([{ role: 'narrator' }], null);
    expect(store.note).toBeNull();
  });
});
