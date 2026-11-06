import { describe, expect, it } from 'vitest';
import {
  applyPreset,
  conflictsAt,
  formatDuration,
  fromContract,
  isSet,
  partLabel,
  resetSection,
  sectionHeader,
  setByPath,
  setParts,
  setValue,
  shortValue,
  toContract,
  valueOf,
  withoutDecided,
} from '../src/screens/new-project/brief';
import fallback from '../src/screens/new-project/schema.fallback.json';
import type { BriefSchema, SchemaField } from '../src/screens/new-project/types';

const schema = fallback as BriefSchema;
const fields: Record<string, SchemaField> = Object.fromEntries(
  schema.sections.flatMap((s) => s.fields.map((f) => [f.id, f])),
);
const field = (id: string): SchemaField => {
  const found = fields[id];
  if (!found) throw new Error(`no field ${id}`);
  return found;
};

describe('the sparse brief', () => {
  it('reads the default until the owner sets something', () => {
    expect(valueOf(field('story.research_depth'), {})).toBe('standard');
    const set = setValue({}, field('story.research_depth'), 'quick');
    expect(valueOf(field('story.research_depth'), set)).toBe('quick');
    expect(isSet(set, 'story.research_depth')).toBe(true);
  });

  it('drops a setting put back to its default, and the empty section with it', () => {
    const set = setValue({}, field('story.research_depth'), 'quick');
    expect(setValue(set, field('story.research_depth'), 'standard')).toEqual({});
  });

  it('keeps only the touched parts of an object setting', () => {
    const duration = field('delivery.duration');
    const set = setParts({}, duration, { mode: 'manual', seconds: 90 });
    expect(set).toEqual({ delivery: { duration: { mode: 'manual', seconds: 90 } } });
    expect(valueOf(duration, set)).toEqual({ mode: 'manual', seconds: 90 });
    expect(setParts(set, duration, { mode: 'auto', seconds: null })).toEqual({});
  });

  it('resets a section but leaves the quick settings alone', () => {
    const delivery = schema.sections.find((s) => s.id === 'delivery');
    if (!delivery) throw new Error('no delivery section');
    let set = setValue({}, field('delivery.destination'), 'tiktok');
    set = setValue(set, field('delivery.aspects'), ['9:16']);
    expect(resetSection(set, delivery, schema.quick)).toEqual({ delivery: { destination: 'tiktok' } });
  });

  it('ignores a path the schema does not know', () => {
    expect(setByPath({}, fields, 'nope.nothing', 'x')).toEqual({});
  });

  it('puts a preset on top of the settings without touching the idea', () => {
    const next = applyPreset({ story: { audience: 'me' } }, fields, {
      idea: 'ignored',
      story: { hook: 'question' },
      visual: { captions: { mode: 'on' } },
    });
    expect(next).toEqual({
      story: { audience: 'me', hook: 'question' },
      visual: { captions: { mode: 'on' } },
    });
  });
});

describe('the brief the service reads', () => {
  it('sends only what was touched, with the tray ids and the accepted suggestions', () => {
    const brief = toContract({
      idea: 'How heat pumps work',
      title: '',
      settings: { story: { hook: 'question' } },
      decideLater: { voice: true },
      suggested: ['story.hook'],
      sourceIds: ['s01'],
    });
    expect(brief).toEqual({
      version: 1,
      idea: 'How heat pumps work',
      sources: ['s01'],
      story: { hook: 'question' },
      decide_later: { voice: true },
      meta: { suggested: ['story.hook'] },
    });
  });

  it('turns a saved brief back into the screen pieces', () => {
    const saved = toContract({
      idea: 'An idea',
      title: 'Name',
      settings: { delivery: { destination: 'tiktok' } },
      decideLater: null,
      suggested: ['story.tone'],
      sourceIds: ['s01'],
    });
    expect(fromContract(saved)).toEqual({
      idea: 'An idea',
      title: 'Name',
      settings: { delivery: { destination: 'tiktok' } },
      decideLater: null,
      suggested: ['story.tone'],
    });
  });

  it('stops being "decide later" for a voice setting once it is chosen', () => {
    const later = { voice: true, music: true };
    expect(withoutDecided(later, 'voice.voice')).toEqual({ music: true });
    expect(withoutDecided({ voice: true }, 'voice.voice')).toBeNull();
    expect(withoutDecided(later, 'story.tone')).toBe(later);
  });
});

describe('the words on screen', () => {
  it('says what is set in a closed accordion and counts its conflicts', () => {
    const story = schema.sections.find((s) => s.id === 'story');
    if (!story) throw new Error('no story section');
    const settings = { story: { research_depth: 'investigative', audience: 'homeowners' } };
    const conflict = { id: 'c', paths: ['story.research_depth', 'delivery.duration'], text: 'Too short' };
    expect(sectionHeader(story, settings, schema.quick, [conflict], null)).toEqual({
      summary: 'homeowners · Investigative',
      count: '! 1 conflict',
      conflicted: true,
    });
    expect(sectionHeader(story, {}, schema.quick, [], null).summary).toBe('Defaults');
  });

  it('says "Decide later" for Voice & sound when nothing there is set', () => {
    const voice = schema.sections.find((s) => s.id === 'voice');
    if (!voice) throw new Error('no voice section');
    expect(sectionHeader(voice, {}, schema.quick, [], null).summary).toMatch(/^Decide later/);
  });

  it('shortens each kind of value', () => {
    expect(shortValue(field('story.tone'), { story: { tone: ['serious', 'my words'] } })).toBe(
      'Serious, my words',
    );
    expect(shortValue(field('story.must_include'), { story: { must_include: ['a', 'b'] } })).toBe(
      'Mandatory facts (2)',
    );
    expect(shortValue(field('voice.voice'), { voice: { voice: { pacing: 'brisk' } } })).toBe('Brisk');
  });

  it('labels object parts by their own words', () => {
    expect(partLabel('narrative_pauses')).toBe('Pauses between lines');
    expect(partLabel('heading_font')).toBe('Heading font');
    expect(partLabel('accent')).toBe('Accent');
  });

  it('finds the conflicts at a control, including a part inside it', () => {
    const conflicts = [
      { id: 'a', paths: ['delivery.duration.seconds'], text: 'x' },
      { id: 'b', paths: ['story.tone'], text: 'y' },
    ];
    expect(conflictsAt(conflicts, 'delivery.duration').map((c) => c.id)).toEqual(['a']);
    expect(conflictsAt(conflicts, 'story.tone').map((c) => c.id)).toEqual(['b']);
  });

  it('writes lengths plainly', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(90)).toBe('1:30');
    expect(formatDuration(120)).toBe('2 min');
  });
});
