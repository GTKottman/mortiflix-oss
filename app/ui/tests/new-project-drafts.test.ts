import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceClient } from '../src/lib/service/client';
import { ServiceError } from '../src/lib/service/client';
import { Problems } from '../src/lib/stores/problems.svelte';
import { pacingOf, scenesAbout, spokenWordsAbout } from '../src/screens/new-project/brief';
import { draftWhen } from '../src/screens/new-project/drafts';
import { decodeTitle } from '../src/screens/new-project/entities';
import { NewProject } from '../src/screens/new-project/newProject.svelte';
import fallback from '../src/screens/new-project/schema.fallback.json';
import type { BriefSchema, SchemaField } from '../src/screens/new-project/types';

// Real-run bugs from the directors (ui/RUN-BUGS.md, 2026-11-02): drafts shared across tabs, raw entities in link
// titles, two word estimates for one length, the voice choice missing from the brief.

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

function stubService(answers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: { type: string; params: Record<string, unknown> }[] = [];
  const client = {
    call: vi.fn((type: string, params: Record<string, unknown> = {}) => {
      calls.push({ type, params });
      const answer = answers[type];
      return answer
        ? Promise.resolve(answer(params))
        : Promise.reject(new ServiceError('no such call', 'unknown_type'));
    }),
    on: vi.fn(() => () => undefined),
  } as unknown as ServiceClient;
  return { client, calls };
}

const schema = fallback as BriefSchema;
const OTHERS_DRAFT = {
  id: 'd-other',
  brief: { version: 1, idea: 'Who gets your chatbot chats when the company goes bankrupt?' },
  sources: [],
};
const answers = {
  'brief.schema': () => schema,
  'brief.summary': () => ({}),
  'brief.draft.save': (p: Record<string, unknown>) => ({
    draft: p['draft'],
    saved_at: '2026-11-02T08:40:00Z',
  }),
  'brief.draft.list': () => ({
    drafts: [
      {
        id: 'd-other',
        saved_at: '2026-11-02T08:40:00Z',
        idea_excerpt: 'Who gets your chatbot chats',
        sources: 0,
      },
    ],
  }),
  'brief.draft.get': (p: Record<string, unknown>) => ({
    draft: p['draft'] === 'd-other' ? OTHERS_DRAFT : null,
  }),
};

describe('a draft belongs to the tab that started it', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a fresh New project loads no one else’s draft and offers it under Continue a draft', async () => {
    const { client, calls } = stubService(answers);
    const project = new NewProject(client, new Problems(), { onCreated: async () => undefined });
    await project.start();
    expect(project.form.idea).toBe('');
    expect(project.restored).toBe(false);
    expect(project.draft.others.map((d) => d.id)).toEqual(['d-other']);
    expect(calls.some((c) => c.type === 'brief.draft.get')).toBe(false);
  });

  it('Continue makes the draft this tab’s own, and a reload of the tab brings it back', async () => {
    const { client } = stubService(answers);
    const first = new NewProject(client, new Problems(), { onCreated: async () => undefined });
    await first.start();
    await first.continueDraft('d-other');
    expect(first.form.idea).toBe(OTHERS_DRAFT.brief.idea);
    expect(first.draft.id).toBe('d-other');
    expect(first.draft.others).toEqual([]);

    const reloaded = new NewProject(client, new Problems(), { onCreated: async () => undefined });
    await reloaded.start();
    expect(reloaded.form.idea).toBe(OTHERS_DRAFT.brief.idea);
    expect(reloaded.draft.others).toEqual([]);
  });

  it('saves into the tab’s own new draft, never the newest one', async () => {
    const { client, calls } = stubService(answers);
    const project = new NewProject(client, new Problems(), { onCreated: async () => undefined });
    await project.start();
    project.form.setIdea('Why ice is slippery, for curious kids.');
    await project.draft.save(true);
    const saved = calls.filter((c) => c.type === 'brief.draft.save').map((c) => c.params['draft']);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((id) => id !== 'd-other')).toBe(true);
  });
});

describe('the voice choice reaches the brief', () => {
  it('Delivery: Calm is in the brief sent with Create script', async () => {
    const { client, calls } = stubService({ ...answers, 'project.new': () => ({ id: 'p-1' }) });
    const project = new NewProject(client, new Problems(), { onCreated: async () => undefined });
    project.form.schema = schema;
    const voice = schema.sections.flatMap((s) => s.fields).find((f) => f.id === 'voice.voice') as SchemaField;
    project.form.setPart(voice, 'delivery', 'calm');
    project.form.setIdea('How heat pumps work, for homeowners deciding this year.');
    await project.create();
    const brief = calls.find((c) => c.type === 'project.new')?.params['brief'] as Record<string, unknown>;
    expect(brief['voice']).toEqual({ voice: { delivery: 'calm' } });
  });
});

describe('one spoken-word estimate', () => {
  const fields = Object.fromEntries(schema.sections.flatMap((s) => s.fields.map((f) => [f.id, f])));
  it('agrees with the service at a natural pace: 3 minutes is about 405 words, 23 scenes', () => {
    expect(spokenWordsAbout(180, pacingOf(fields, {}))).toBe(405);
    expect(scenesAbout(180)).toBe(23);
  });
  it('follows the pace the voice settings ask for', () => {
    expect(pacingOf(fields, { voice: { voice: { pacing: 'brisk' } } })).toBe('brisk');
    expect(spokenWordsAbout(60, 'brisk')).toBe(162);
  });
});

describe('link titles', () => {
  it('decode named, numeric and doubly encoded entities', () => {
    expect(decodeTitle('Flock ignores it &amp;mdash; city acts')).toBe('Flock ignores it — city acts');
    expect(decodeTitle('A &ndash; B&#8217;s &#x2026;')).toBe('A – B’s …');
    expect(decodeTitle('Plain title')).toBe('Plain title');
  });
});

describe('draft times', () => {
  const now = new Date(2026, 10, 2, 9, 0);
  it('say today, yesterday or the date', () => {
    expect(draftWhen(new Date(2026, 10, 2, 2, 40).toISOString(), now)).toBe('Today 02:40');
    expect(draftWhen(new Date(2026, 10, 1, 23, 10).toISOString(), now)).toBe('Yesterday 23:10');
    expect(draftWhen(new Date(2026, 9, 30, 14, 2).toISOString(), now)).toBe('30 Oct 14:02');
    expect(draftWhen('', now)).toBe('');
  });
});
