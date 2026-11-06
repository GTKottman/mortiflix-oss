import { describe, expect, it } from 'vitest';
import { neighbour } from '../src/screens/home/keys';
import {
  clampStart,
  lastStart,
  middleOut,
  middleStart,
  shelfFit,
  slotOf,
} from '../src/screens/home/shelf-layout';
import {
  applyChange,
  cardMark,
  countLine,
  groupOf,
  matchesQuery,
  screenOf,
  splitGroups,
  stageNameOf,
  waitingText,
  whyText,
} from '../src/screens/home/projects';
import { setupProblems } from '../src/screens/home/setup-problems';
import type { HomeProject } from '../src/screens/home/types';

const project = (over: Partial<HomeProject> = {}): HomeProject => ({
  id: 'p',
  title: 'A video',
  state: 'queued',
  stage: 2,
  pipeline: { slug: 'v3', stage_set: 'v3' },
  updated_at: '2026-11-01T10:00:00Z',
  ...over,
});

describe('groups', () => {
  it('puts a delivered project in Done whatever its state', () => {
    expect(groupOf(project({ delivered: true, state: 'waiting' }))).toBe('done');
  });
  it('puts waiting, paused and needs_you projects in Needs you', () => {
    expect(groupOf(project({ state: 'waiting' }))).toBe('needs');
    expect(groupOf(project({ state: 'paused' }))).toBe('needs');
    expect(groupOf(project({ state: 'paused', needs_you: { cause: 'gpu' } }))).toBe('needs');
  });
  it('puts queued (working) projects in Making and the rest in Done and paused', () => {
    expect(groupOf(project())).toBe('making');
    expect(groupOf(project({ state: 'draft' }))).toBe('done');
    expect(groupOf(project({ state: 'cancelled' }))).toBe('done');
    expect(groupOf(project({ state: 'delivered' }))).toBe('done');
  });
  it('lists each group newest first', () => {
    const groups = splitGroups([
      project({ id: 'old', updated_at: '2026-10-01T00:00:00Z' }),
      project({ id: 'new', updated_at: '2026-11-01T00:00:00Z' }),
    ]);
    expect(groups.making.map((p) => p.id)).toEqual(['new', 'old']);
  });
});

describe('which screen a project opens at', () => {
  it('uses the v3 stages for the v3 set', () => {
    expect(screenOf(project({ stage: 3 }))).toBe('stills');
    expect(stageNameOf(project({ stage: 1 }))).toBe('Voice & music');
  });
  it('uses the older stages otherwise', () => {
    const old = project({ pipeline: undefined, stage: 3 });
    expect(screenOf(old)).toBe('motion');
  });
  it('opens a delivered project at Finish and an unknown stage at Script', () => {
    expect(screenOf(project({ delivered: true }))).toBe('finish');
    expect(screenOf(project({ stage: 99 }))).toBe('script');
    expect(stageNameOf(project({ stage: 99 }))).toBe('Script');
  });
});

describe('words', () => {
  it('says what a stage waits on', () => {
    expect(waitingText(project({ stage: 2 }))).toBe('Waiting for you to pick a look');
  });
  it('explains a stop from the cause, then the service text, then the stage', () => {
    expect(whyText(project({ needs_you: { cause: 'billing' } }))).toBe('A paid service ran out of credits.');
    expect(whyText(project({ needs_you: { text: 'Plain words from the service' } }))).toBe(
      'Plain words from the service',
    );
    expect(whyText(project({ stage: 2 }))).toContain('Pick one');
    expect(whyText(project({ state: 'paused' }))).toBe('The AI stopped before it finished.');
    expect(whyText(project({ stage: 0, state: 'waiting' }))).toContain('brief or the script');
  });
  it('words the state line of a card', () => {
    expect(cardMark(project({ delivered: true }))).toEqual({ mark: 'ok', text: 'Finished' });
    expect(cardMark(project())).toEqual({ mark: 'busy', text: 'Working on Look' });
    expect(cardMark(project({ state: 'draft' }))).toEqual({ mark: 'wait', text: 'Draft' });
    expect(cardMark(project({ state: 'cancelled' }))).toEqual({ mark: 'cut', text: 'Stopped at Look' });
    expect(cardMark(project({ state: 'paused' }))).toEqual({ mark: 'fix', text: 'Waiting at Look' });
  });
});

describe('search', () => {
  it('matches any part of the title, ignoring case and outer spaces', () => {
    expect(matchesQuery(project({ title: 'Black October' }), ' october ')).toBe(true);
    expect(matchesQuery(project({ title: 'Black October' }), 'plex')).toBe(false);
    expect(matchesQuery(project(), '   ')).toBe(true);
  });
  it('counts the projects in words', () => {
    expect(countLine(1, 1, '')).toBe('1 project · newest first');
    expect(countLine(9, 9, '')).toBe('9 projects · newest first');
    expect(countLine(9, 1, 'plex')).toBe('1 of 9 project · newest first');
    expect(countLine(9, 3, 'plex')).toBe('3 of 9 projects · newest first');
  });
});

describe('project.changed', () => {
  it('patches the project in place', () => {
    const p = project({ state: 'queued', stage: 1 });
    applyChange(p, { id: 'p', state: 'waiting', stage: 2, needs_you: { cause: 'gpu' } });
    expect(p).toMatchObject({ state: 'waiting', stage: 2, delivered: false, needs_you: { cause: 'gpu' } });
  });
  it('marks a project delivered', () => {
    const p = project();
    applyChange(p, { id: 'p', state: 'delivered' });
    expect(p.delivered).toBe(true);
  });
});

describe('the project shelves', () => {
  it('shows three cards on a wide page, fewer when narrow, and never less than one', () => {
    expect(shelfFit(1840)).toEqual({ shown: 3, card: 320 });
    expect(shelfFit(900).shown).toBe(2);
    expect(shelfFit(300).shown).toBe(1);
  });
  it('slides only as far as its cards go', () => {
    expect(lastStart(17, 3)).toBe(14);
    expect(lastStart(2, 3)).toBe(0);
    expect(clampStart(20, 17, 3)).toBe(14);
    expect(clampStart(-3, 17, 3)).toBe(0);
  });
  it('puts the newest of Making in the middle, then right, left, right', () => {
    expect([0, 1, 2, 3, 4].map(slotOf)).toEqual([0, 1, -1, 2, -2]);
    expect(middleOut(['a', 'b', 'c', 'd', 'e'])).toEqual(['e', 'c', 'a', 'b', 'd']);
    expect(middleOut(['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
  });
  it('starts Making on its newest card', () => {
    expect(middleStart(5, 3)).toBe(1);
    expect(middleStart(4, 3)).toBe(0);
    expect(middleStart(3, 3)).toBe(0);
    expect(middleStart(5, 1)).toBe(2);
  });
});

describe('Fix it problems from the setup', () => {
  const actions = { recheck: () => Promise.resolve({}), openVoiceSettings: () => undefined };
  it('raises nothing while everything works', () => {
    const ok = { claude: { found: true, logged_in: true }, keys: [{ id: 'elevenlabs', set: true }] };
    expect(setupProblems(ok, actions)).toEqual([]);
    expect(setupProblems(null, actions)).toEqual([]);
  });
  it('says Claude Code is missing, or not signed in with the command to run', () => {
    expect(setupProblems({ claude: { found: false } }, actions)[0]?.text).toContain('was not found');
    const signedOut = setupProblems(
      { claude: { found: true, logged_in: false, login_command: ['claude', 'login'] } },
      actions,
    );
    expect(signedOut[0]).toMatchObject({ id: 'claude', kind: 'bad' });
    expect(signedOut[0]?.text).toContain('Run claude login in a terminal');
  });
  it('checks again and fails in words while Claude Code is still signed out', async () => {
    const still = setupProblems(
      { claude: { found: true, logged_in: false } },
      { ...actions, recheck: () => Promise.resolve({ claude: { found: true, logged_in: false } }) },
    );
    await expect(still[0]?.fix?.run()).rejects.toThrow('still not signed in');
    const fixed = setupProblems(
      { claude: { found: true, logged_in: false } },
      { ...actions, recheck: () => Promise.resolve({ claude: { found: true, logged_in: true } }) },
    );
    await expect(fixed[0]?.fix?.run()).resolves.toBe('Claude Code is connected.');
  });
  it('warns about a missing ElevenLabs key and opens Settings to add it', async () => {
    let opened = 0;
    const [warn] = setupProblems(
      { claude: { found: true, logged_in: true }, keys: [{ id: 'elevenlabs', set: false }] },
      { ...actions, openVoiceSettings: () => opened++ },
    );
    expect(warn).toMatchObject({ id: 'eleven-key', kind: 'warn' });
    await warn?.fix?.run();
    expect(opened).toBe(1);
  });
});

describe('moving between cards', () => {
  const links = [0, 1, 2].map(() => ({}) as HTMLElement);
  it('steps with the arrows and stops at the ends', () => {
    expect(neighbour(links, links[0] as HTMLElement, 'ArrowDown')).toBe(links[1]);
    expect(neighbour(links, links[1] as HTMLElement, 'ArrowLeft')).toBe(links[0]);
    expect(neighbour(links, links[0] as HTMLElement, 'ArrowUp')).toBeNull();
    expect(neighbour(links, links[2] as HTMLElement, 'ArrowRight')).toBeNull();
  });
  it('ignores other keys', () => {
    expect(neighbour(links, links[0] as HTMLElement, 'Enter')).toBeNull();
  });
});
