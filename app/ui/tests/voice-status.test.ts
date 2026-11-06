import { describe, expect, it } from 'vitest';
import { cueSubtitle, cueTitle, lineSubtitle, spokenBy } from '../src/screens/voice/heading';
import { usableTakes } from '../src/screens/voice/review';
import { cueStatus, differenceNote, lineStatus } from '../src/screens/voice/status';
import type { MusicCue, VoiceLine } from '../src/screens/voice/types';

describe('voice status words', () => {
  it('says what a line is: making, OK or to check', () => {
    expect(lineStatus({ state: 'approved' }, true)).toEqual({ tone: 'busy', glyph: '◌', text: 'Making' });
    expect(lineStatus({ state: 'approved' }, false)).toEqual({ tone: 'ok', glyph: '✓', text: 'OK' });
    expect(lineStatus({ state: 'ready' }, false)).toEqual({ tone: 'fix', glyph: '!', text: 'To check' });
  });

  it('says what a cue is, and Queued wins over its state', () => {
    expect(cueStatus('ok', true).text).toBe('Queued');
    expect(cueStatus('ok', false).tone).toBe('ok');
    expect(cueStatus('planned', false).text).toBe('Not made');
    expect(cueStatus('stale', false).text).toBe('Words changed');
    expect(cueStatus('made', false).text).toBe('To check');
  });

  it('counts the words that differ', () => {
    expect(differenceNote(0)).toBe('words differ');
    expect(differenceNote(1)).toBe('1 word differs');
    expect(differenceNote(3)).toBe('3 words differ');
  });
});

describe('voice inspector heading', () => {
  const line = { start_sec: 74.2, dur_sec: 3.1 } as VoiceLine;
  const cue = { id: 'm02', mood: '', from_sec: 0, to_sec: 90, crossfade_sec: 2 } as MusicCue;

  it('names who speaks', () => {
    expect(spokenBy({ role: 'Narrator', name: 'Mark' })).toBe('Narrator · Mark');
    expect(spokenBy({ role: 'Narrator', name: '' })).toBe('Narrator');
  });

  it('prints a line and a cue with clock times', () => {
    expect(lineSubtitle(line, 'Narrator')).toBe('1:14–1:17 · Narrator');
    expect(cueTitle(cue)).toBe('Music 2 · Untitled');
    expect(cueSubtitle(cue)).toBe('0:00–1:30 · blends 2 s into the next');
    expect(cueSubtitle({ ...cue, crossfade_sec: undefined, from_library: true })).toBe(
      '0:00–1:30 · blends 0 s into the next · from your library',
    );
  });
});

describe('usable takes', () => {
  it('keeps the reads that have a file and finds the one in use', () => {
    const takes = {
      versions: [
        { v: 1, path: 'a.wav' },
        { v: 2, path: null },
        { v: 3, path: 'c.wav' },
      ],
      plays: 3,
    };
    expect(usableTakes(takes)).toEqual({ versions: [takes.versions[0], takes.versions[2]], inUse: 1 });
  });

  it('starts at the first when none says it is in use', () => {
    expect(usableTakes({ versions: [{ v: 1, path: 'a' }], plays: null }).inUse).toBe(0);
    expect(usableTakes(undefined)).toEqual({ versions: [], inUse: 0 });
  });
});
