import { describe, expect, it } from 'vitest';
import { elapsedText } from '../src/lib/time';
import {
  answersFor,
  sessionStartedAt,
  submittedNote,
  submittedQuestions,
  whatIsWaiting,
} from '../src/screens/script/brief';
import { stageById, stageCount } from '../src/lib/stages';

const brief = { key: 'brief', name: 'Brief', state: 'in_review', version: 1 };
const script = { key: 'script', name: 'Script', state: 'blocked' };

describe('what the Script screen waits on', () => {
  it('puts a step in review first, even while a session runs', () => {
    expect(whatIsWaiting([brief, script], true)).toEqual({ kind: 'review', step: brief });
  });
  it('says writing only while a session runs', () => {
    const working = { ...script, state: 'working' };
    expect(whatIsWaiting([{ ...brief, state: 'approved' }, working], true).kind).toBe('writing');
    expect(whatIsWaiting([{ ...brief, state: 'approved' }, working], false).kind).toBe('idle');
  });
  it('a running session writes the next step in line before that step says working', () => {
    const ready = { ...brief, state: 'ready' };
    expect(whatIsWaiting([ready, script], true)).toEqual({ kind: 'writing', step: ready });
    expect(whatIsWaiting([ready, script], false)).toEqual({ kind: 'idle', next: ready });
  });
});

describe('the brief the service submitted', () => {
  const events = [
    { t: '2026-11-02T08:00:00Z', event: 'SUBMITTED', step: 'brief', version: 1, details: 'old' },
    { t: '2026-11-02T08:10:00Z', event: 'SUBMITTED', step: 'brief', version: 2, details: 'new' },
  ];
  it('takes the note of the version in review', () => {
    expect(submittedNote(events, { ...brief, version: 1 })).toBe('old');
    expect(submittedNote(events, { ...brief, version: 2 })).toBe('new');
  });
  it('takes the questions of the submission card', () => {
    const q = { id: 'a', text: 'Who?', choices: null, default: 'All' };
    const rows = [{ card: { kind: 'submission', step: 'brief', version: 1, questions: [q] } }, {}];
    expect(submittedQuestions(rows, brief)).toEqual([q]);
  });
  it('answers with the pick, else the suggestion, and refuses a question with neither', () => {
    const qs = [
      { id: 'a', text: 'A', choices: ['x', 'y'], default: 'x' },
      { id: 'b', text: 'B', choices: null, default: null },
    ];
    expect(answersFor(qs, { b: 'free' })).toEqual({ a: 'x', b: 'free' });
    expect(answersFor(qs, {})).toBeNull();
  });
});

describe('how long Mortiflix has been working', () => {
  it('counts from the last session start that has not ended', () => {
    const start = { t: '2026-11-02T08:00:00Z', event: 'SESSION_STARTED' };
    expect(sessionStartedAt([start])).toBe(Date.parse(start.t));
    expect(sessionStartedAt([start, { t: '2026-11-02T08:01:00Z', event: 'SESSION_ENDED' }])).toBeNull();
  });
  it('prints seconds, then minutes', () => {
    expect(elapsedText(42_000)).toBe('42 s');
    expect(elapsedText(125_000)).toBe('2 min 05 s');
  });
});

describe('the top bar count with a step waiting', () => {
  it('names the step instead of joining numbers and "1 needs you"', () => {
    const status = { key: 'script', done: 1, total: 2, need: 1, text: '1 needs you', steps: [brief, script] };
    expect(stageCount(stageById('script'), status)).toEqual({
      text: 'Brief needs your OK',
      ready: false,
      why: 'Brief needs your OK',
    });
  });
});

describe('OK and Fix on the brief', () => {
  it('answers every question on OK and sends the version back with the typed words on Fix', async () => {
    const { BriefStore } = await import('../src/screens/script/brief.svelte');
    const calls: [string, unknown][] = [];
    const client = {
      call: async (type: string, params: unknown) => {
        calls.push([type, params]);
        return [];
      },
    };
    const store = new BriefStore(client as never);
    store.questions = [
      { id: 'a', text: 'A', choices: ['x', 'y'], default: 'x' },
      { id: 'b', text: 'B', choices: null, default: 'z' },
    ];
    store.loaded = true;
    store.picked = { a: 'y' };
    await store.ok(brief);
    expect(calls).toEqual([
      ['chat.answer', { question: 'a', value: 'y' }],
      ['chat.answer', { question: 'b', value: 'z' }],
      ['review.respond', { step: 'brief', version: 1, verdict: 'ok' }],
    ]);
    calls.length = 0;
    expect(await store.fix(brief, '  shorter  ')).toBe(true);
    expect(calls).toEqual([
      ['review.respond', { step: 'brief', version: 1, verdict: 'changes', notes: 'shorter' }],
    ]);
    expect(await store.fix(brief, '   ')).toBe(false);
  });

  it('marks OK as sent for the step version in review', async () => {
    const { BriefStore } = await import('../src/screens/script/brief.svelte');
    const store = new BriefStore({ call: async () => [] } as never);
    expect(store.canOk).toBe(false);
    store.loaded = true;
    store.questions = [{ id: 'a', text: 'A', choices: null, default: null }];
    expect(store.canOk).toBe(false);
    store.questions = [{ id: 'a', text: 'A', choices: null, default: 'z' }];
    expect(store.canOk).toBe(true);
    await store.ok(brief);
    expect(store.okSentFor).toBe('brief:1');
  });

  it('OKs a brief with no questions with the verdict itself', async () => {
    const { BriefStore } = await import('../src/screens/script/brief.svelte');
    const calls: [string, unknown][] = [];
    const store = new BriefStore({
      call: async (type: string, params: unknown) => {
        calls.push([type, params]);
        return [];
      },
    } as never);
    await store.load({ ...brief, version: 3 });
    expect(store.questions).toEqual([]);
    expect(store.canOk).toBe(true);
    calls.length = 0;
    await store.ok({ ...brief, version: 3 });
    expect(calls).toEqual([['review.respond', { step: 'brief', version: 3, verdict: 'ok' }]]);
    expect(store.okSentFor).toBe('brief:3');
  });

  it('says why the brief could not be read instead of showing nothing', async () => {
    const { BriefStore } = await import('../src/screens/script/brief.svelte');
    const store = new BriefStore({
      call: async () => {
        throw new Error('offline');
      },
    } as never);
    await store.load(brief);
    expect(store.loaded).toBe(true);
    expect(store.loadError).toBe('offline');
    await store.loadSession();
    expect(store.sessionStart).toBeNull();
  });
});

describe('OK after the answers', () => {
  it('ends with the verdict even when the service already approved on the last answer, and stops on a failed answer', async () => {
    const { BriefStore } = await import('../src/screens/script/brief.svelte');
    const calls: string[] = [];
    let failAnswer = false;
    const store = new BriefStore({
      call: async (type: string) => {
        calls.push(type);
        if (type === 'chat.answer' && failAnswer) throw new Error('no question a');
        // the service's answer to an OK on a step it already approved
        if (type === 'review.respond')
          return { step: 'brief', version: 1, verdict: 'approve', already: true };
        return [];
      },
    } as never);
    store.questions = [{ id: 'a', text: 'A', choices: null, default: 'x' }];
    store.loaded = true;
    await store.ok(brief);
    expect(calls).toEqual(['chat.answer', 'review.respond']);
    expect(store.error).toBe('');
    expect(store.okSentFor).toBe('brief:1');
    calls.length = 0;
    store.okSentFor = null;
    failAnswer = true;
    await store.ok(brief);
    expect(calls).toEqual(['chat.answer']);
    expect(store.error).toBe('no question a');
    expect(store.okSentFor).toBeNull();
  });
});
