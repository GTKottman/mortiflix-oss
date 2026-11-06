import { describe, expect, it } from 'vitest';
import { stageById } from '../src/lib/stages';
import type { StageStatus } from '../src/lib/service/types';
import { ActiveWork } from '../src/lib/review/active-work.svelte';
import { drainWords, stepWords, waitingWords, workHere, type WorkReport } from '../src/lib/review/waiting';
import { runPause } from '../src/lib/pause';
import type { Project } from '../src/lib/stores/project.svelte';

const look = stageById('look');

const statuses = (voice: string, lookStep = 'ready'): StageStatus[] => [
  { key: 'script', steps: [{ key: 'script', name: 'Script', state: 'approved' }] },
  {
    key: 'voiceMusic',
    steps: [
      { key: 'voice', name: 'Voice', state: 'approved' },
      { key: 'music', name: 'Music', state: voice },
    ],
  },
  { key: 'look', steps: [{ key: 'look', name: 'Style frames', state: lookStep }] },
];

describe('workHere: the clock runs only while the service works on this project and stage', () => {
  it('needs running work', () => {
    expect(workHere(null, 'p1', look)).toBe(false);
    expect(workHere({ project: 'p1', running: false }, 'p1', look)).toBe(false);
  });
  it('for this project', () => {
    expect(workHere({ project: 'p2', running: true, step: { stage: 2 } }, 'p1', look)).toBe(false);
    expect(workHere({ project: 'p1', running: true, step: { stage: 2 } }, 'p1', look)).toBe(true);
  });
  it('in this stage (or on Fixes, with no step)', () => {
    expect(workHere({ project: 'p1', running: true, step: { stage: 1 } }, 'p1', look)).toBe(false);
    expect(workHere({ project: 'p1', running: true, step: null }, 'p1', look)).toBe(true);
  });
});

describe('waitingWords: what a stage waits for when nothing runs', () => {
  it('names the earlier stage and its open step, with a link there', () => {
    const words = waitingWords(look, statuses('ready'), 'the frames');
    expect(words.title).toBe('Waiting for Voice & music');
    expect(words.body).toBe("The music isn't made yet, so the frames can't start yet.");
    expect(words.link).toEqual({ label: 'Go to voice & music ›', route: '/voice' });
  });
  it('says when a step waits for the OK or is being changed', () => {
    expect(waitingWords(look, statuses('in_review'), 'the frames').body).toMatch(/^The music needs your OK/);
    expect(waitingWords(look, statuses('changes'), 'the frames').body).toMatch(
      /^The music is being changed with your notes/,
    );
  });
  it('earlier stages done: nothing is running, no clock and no link', () => {
    const words = waitingWords(look, statuses('approved'), 'the frames');
    expect(words.title).toBe('Nothing is running right now');
    expect(words.body).toContain('Mortiflix is not working on the frames at the moment');
    expect(words.link).toBeUndefined();
    expect(words.idle).toBe(true);
  });
});

// work.get for Director 1 while its runner session made the style frames (2026-11-02, svc/work.mjs activeWork).
const DIR1 = 'p-dir1';
const DIR1_WORK = {
  project: DIR1,
  running: true,
  step: { key: 'style-frames', name: 'Style frames', stage: 2, kind: 'frame', state: 'ready', version: 1 },
  nodes: [],
  current: null,
  doing: 'Making the looks (style samples, not the shots)',
  progress: null,
  shots_eta_min: 15,
  before_shots: ['Style frames', 'Stills'],
};

describe('the real work.get payload of a runner session', () => {
  it('counts as working on Look (step style-frames, stage 2), not on Stills', () => {
    expect(workHere(DIR1_WORK, DIR1, look)).toBe(true);
    expect(workHere(DIR1_WORK, DIR1, stageById('stills'))).toBe(false);
  });
  it('the idle payload (no session) does not', () => {
    expect(workHere({ ...DIR1_WORK, running: false, step: null }, DIR1, look)).toBe(false);
  });
});

describe('ActiveWork: reads work.get for this tab, follows pushes, offers Resume only when truly idle', () => {
  const project = { id: DIR1, state: 'queued', needsYou: null } as unknown as Project;
  function client(answer: () => WorkReport) {
    const calls: [string, unknown][] = [];
    const listeners: ((data: unknown) => void)[] = [];
    return {
      calls,
      push: (data: unknown) => listeners.forEach((listener) => listener(data)),
      call: <T>(type: string, given?: Record<string, unknown>) => {
        calls.push([type, given]);
        return Promise.resolve((type === 'work.get' ? answer() : {}) as T);
      },
      on: <T>(_event: string, listener: (data: T) => void) => {
        listeners.push(listener as (data: unknown) => void);
        return () => {};
      },
    };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('working session: here, not idle', async () => {
    const fake = client(() => DIR1_WORK);
    const work = new ActiveWork(fake, project, look);
    expect(work.idle).toBe(false); // not asked yet: claims neither
    const stop = work.start();
    await flush();
    expect(work.here).toBe(true);
    expect(work.idle).toBe(false);
    stop();
  });

  it("a push for another project reads this project's work again", async () => {
    let now: WorkReport = { project: DIR1, running: false, step: null };
    const fake = client(() => now);
    const work = new ActiveWork(fake, project, look);
    const stop = work.start();
    await flush();
    expect(work.idle).toBe(true);
    // queued: it starts by itself when a slot frees, so no Resume (it answered "not paused (queued)")
    expect(work.action).toBeNull();
    expect(work.queued).toEqual({ ahead: 0, drain: null });
    now = DIR1_WORK;
    fake.push({ project: 'someone-else', running: true });
    await flush();
    expect(work.here).toBe(true);
    stop();
  });

  it('Resume calls project.resume for this project (a stopped one)', async () => {
    const fake = client(() => ({ project: DIR1, running: false, step: null }));
    const stopped = { ...project, state: 'paused' } as unknown as Project;
    const work = new ActiveWork(fake, stopped, look);
    await work.read();
    await work.resume();
    expect(
      fake.calls.some(
        ([type, given]) => type === 'project.resume' && (given as { project: string }).project === DIR1,
      ),
    ).toBe(true);
    expect(work.said).toBe('Resumed. It goes on by itself.');
  });
});

describe('step words read right', () => {
  it('a name of many takes "aren\'t"', () => {
    expect(stepWords({ key: 'style-frames', name: 'Style frames', state: 'ready' })).toBe(
      "The style frames aren't made yet",
    );
    expect(stepWords({ key: 'script', name: 'Script', state: 'working' })).toBe('The script is being made');
    expect(stepWords({ key: 'stills', name: 'Stills', state: 'in_review' })).toBe('The stills need your OK');
    expect(stepWords({ key: 'brief', name: 'Brief', state: 'blocked' })).toBe("The brief isn't made yet");
  });
});

describe('the pause buttons say what really happened', () => {
  const deps = (answer: unknown) => ({
    call: async <T>() => answer as T,
    project: 'p',
    openVoiceSettings: () => undefined,
  });
  it('Resume says resumed; take over says so only when the service did it', async () => {
    expect(await runPause('resume', deps({ resumed: true }))).toBe('Resumed. It goes on by itself.');
    expect(await runPause('takeover', deps({ resumed: true, takeover: true }))).toMatch(/^The AI took over/);
    expect(await runPause('takeover', deps({ resumed: true }))).toBe('Resumed. It goes on by itself.');
  });
});

// Dir1 bdb9 (2026-11-02): during a drained restart a queued project's Sound said "The service can't list the sounds
// yet" and Check again did nothing. Queued work says it waits for the restart, and for what.
describe('a drained restart: queued work says so', () => {
  const t0 = Date.parse('2026-11-02T15:00:00Z');
  const drain = {
    draining: true,
    waiting_for: ['dir3'],
    titles: { dir3: 'Why ice is slippery' },
    started_at: '2026-11-02T15:00:00Z',
    wait_min: 10,
  };
  it('names the project it waits for and the minutes left at most', () => {
    expect(drainWords(drain, t0 + 3 * 60_000)?.body).toBe(
      'Queued: the studio restarts once Why ice is slippery finishes its running step (≤ 7 min); this starts then.',
    );
  });
  it('two projects; no drain = nothing to say', () => {
    expect(drainWords({ ...drain, waiting_for: ['a', 'b'], titles: { a: 'A', b: 'B' } }, t0)?.body).toContain(
      'once A and B finish their running steps (≤ 10 min)',
    );
    expect(drainWords({ draining: false })).toBeNull();
    expect(drainWords(null)).toBeNull();
  });
  it('waitingWords: a queued project during a drain says the drain, else its place in the queue', () => {
    expect(waitingWords(stageById('sound'), [], 'the sounds', { ahead: 0, drain }).body).toMatch(
      /^Queued: the studio restarts once/,
    );
    expect(waitingWords(stageById('sound'), [], 'the sounds', { ahead: 2, drain: null }).body).toBe(
      'Queued: starts when a slot frees (2 ahead).',
    );
  });
  it('ActiveWork carries the drain from work.get', async () => {
    const project = { id: DIR1, state: 'queued', needsYou: null } as unknown as Project;
    const fake = {
      call: <T>(type: string) =>
        Promise.resolve(
          (type === 'work.get' ? { project: DIR1, running: false, step: null, drain } : {}) as T,
        ),
      on: () => () => {},
    };
    const work = new ActiveWork(fake, project, look);
    await work.read();
    expect(work.queued).toEqual({ ahead: 0, drain });
  });
});
