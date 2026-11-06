import { describe, expect, it } from 'vitest';
import type { VoiceChoice } from '../src/screens/voice/types';
import { describeVoice, failureWords, groupsOf, matchVoices, plainLabel } from '../src/screens/voice/voices';

const voices: VoiceChoice[] = [
  {
    id: 'anime',
    name: 'Hana',
    labels: {
      gender: 'female',
      age: 'young',
      accent: 'japanese',
      language: 'ja',
      use_case: 'characters_animation',
    },
  },
  {
    id: 'mark',
    name: 'Mark',
    labels: { gender: 'male', age: 'middle_aged', accent: 'american', use_case: 'narrative_story' },
  },
  {
    id: 'eli',
    name: 'Eli',
    labels: { gender: 'male', accent: 'british', language: 'en', use_case: 'entertainment_tv' },
  },
  { id: 'raj', name: 'Raj', labels: { language: 'hi', use_case: 'news' } },
  { id: 'zed', name: 'Zed', category: 'cloned' },
];

describe('voice picker rules', () => {
  it('says labels in plain words, languages by name', () => {
    expect(plainLabel('age', 'middle_aged')).toBe('Middle-aged');
    expect(plainLabel('use_case', 'narrative_story')).toBe('Storytelling');
    expect(plainLabel('use_case', 'entertainment_tv')).toBe('TV');
    expect(plainLabel('language', 'hi')).toBe('Hindi');
    expect(plainLabel('language', 'en')).toBe('English');
    expect(plainLabel('accent', 'british')).toBe('British');
  });

  it('groups the filters under names, only the groups voices carry', () => {
    const groups = groupsOf(voices);
    expect(groups.map((g) => g.name)).toEqual(['Gender', 'Age', 'Accent', 'Language', 'Use']);
    expect(groups.find((g) => g.key === 'language')?.values.map((v) => v.text)).toEqual([
      'English',
      'Hindi',
      'Japanese',
    ]);
  });

  it('puts English narration and news first, a Japanese anime voice last', () => {
    expect(matchVoices(voices, '', {}).map((v) => v.id)).toEqual(['mark', 'eli', 'zed', 'raj', 'anime']);
  });

  it('matches search words in names and plain labels, and one pick per group', () => {
    expect(matchVoices(voices, ' BRIT ', {}).map((v) => v.id)).toEqual(['eli']);
    expect(matchVoices(voices, 'storytelling', {}).map((v) => v.id)).toEqual(['mark']);
    expect(matchVoices(voices, '', { gender: 'male' }).map((v) => v.id)).toEqual(['mark', 'eli']);
    expect(matchVoices(voices, '', { gender: 'male', accent: 'british' }).map((v) => v.id)).toEqual(['eli']);
    expect(matchVoices(voices, '', { gender: '' })).toHaveLength(5);
  });

  it('describes a voice in plain words, else its category', () => {
    expect(describeVoice(voices[1] as VoiceChoice)).toBe('Male · Middle-aged · American · Storytelling');
    expect(describeVoice(voices[4] as VoiceChoice)).toBe('Cloned');
    expect(describeVoice({ id: '4', name: 'X' })).toBe('');
  });

  it('says why the list is missing', () => {
    expect(failureWords('no_key', 'Add a key').title).toBe('Add a key');
    expect(failureWords('no_key', null).detail).toBe('Samples are free once the key is in.');
    expect(failureWords('bad_key', null).detail).toBe('');
    expect(failureWords('unreachable', null).title).toContain('Can’t reach');
  });
});
