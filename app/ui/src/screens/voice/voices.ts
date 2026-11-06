// Finding a voice: the labels to narrow by, which voices match, and what to say when the list cannot load.
import type { VoiceChoice, VoicesAnswer } from './types';

/** The label groups ElevenLabs uses, in the order the picker shows them, with the owner's words for each. */
export const LABEL_GROUPS = [
  { key: 'gender', name: 'Gender' },
  { key: 'age', name: 'Age' },
  { key: 'accent', name: 'Accent' },
  { key: 'language', name: 'Language' },
  { key: 'use_case', name: 'Use' },
  { key: 'descriptive', name: 'Sound' },
] as const;
export type LabelKey = (typeof LABEL_GROUPS)[number]['key'];

/** Raw ElevenLabs values in plain words ("narrative_story" is "Storytelling"). */
const PLAIN: Record<string, string> = {
  middle_aged: 'Middle-aged',
  young: 'Young',
  old: 'Old',
  narrative_story: 'Storytelling',
  narration: 'Narration',
  entertainment_tv: 'TV',
  informative_educational: 'Educational',
  social_media: 'Social media',
  characters_animation: 'Characters',
  conversational: 'Conversational',
  advertisement: 'Ads',
  news: 'News',
  meditation: 'Meditation',
  audiobook: 'Audiobook',
  video_games: 'Games',
};

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** One label value in plain words: language codes by name ("hi" is "Hindi"), snake_case as words. */
export function plainLabel(key: string, value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  if (key === 'language' && /^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(raw)) {
    try {
      return languageNames.of(raw) ?? raw;
    } catch {
      return raw;
    }
  }
  const known = PLAIN[raw.toLowerCase()];
  if (known) return known;
  const words = raw.replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The value of one group on a voice ("description" is the older name of "descriptive"). */
const valueOf = (voice: VoiceChoice, key: LabelKey): string =>
  voice.labels?.[key] ?? (key === 'descriptive' ? (voice.labels?.description ?? '') : '');

export interface LabelGroup {
  key: LabelKey;
  name: string;
  /** The raw values voices carry, each once, with their plain words, sorted by the words. */
  values: { value: string; text: string }[];
}

/** The filter groups the voices actually carry (a group no voice has is left out). */
export function groupsOf(voices: readonly VoiceChoice[]): LabelGroup[] {
  return LABEL_GROUPS.map(({ key, name }) => {
    const seen = new Map<string, string>();
    for (const voice of voices) {
      const value = valueOf(voice, key);
      if (value && !seen.has(value)) seen.set(value, plainLabel(key, value));
    }
    const values = [...seen]
      .map(([value, text]) => ({ value, text }))
      .sort((a, b) => a.text.localeCompare(b.text));
    return { key, name, values };
  }).filter((group) => group.values.length > 0);
}

/** Uses that suit a narrated video: shown first. */
const NARRATION_USES = ['narrative_story', 'narration', 'news', 'informative_educational', 'audiobook'];

/** How well a voice suits this video: the script's language first, then a narration or news use. */
function fit(voice: VoiceChoice, language: string): number {
  const lang = valueOf(voice, 'language');
  const accent = valueOf(voice, 'accent').toLowerCase();
  // No language label: ElevenLabs' older voices are English unless the accent says otherwise.
  const speaks = lang
    ? lang.split('-')[0] === language
    : language === 'en' && !/japanese|anime|hindi|spanish|french|german|chinese|korean/.test(accent);
  return (speaks ? 2 : 0) + (NARRATION_USES.includes(valueOf(voice, 'use_case')) ? 1 : 0);
}

/**
 * Voices whose name or labels contain the search words and that carry the value picked in each group, the ones that
 * suit the video first (the script's language, then narration and news), otherwise in ElevenLabs' order.
 */
export function matchVoices(
  voices: readonly VoiceChoice[],
  query: string,
  picked: Readonly<Partial<Record<LabelKey, string>>>,
  language = 'en',
): VoiceChoice[] {
  const wanted = query.trim().toLowerCase();
  const found = voices.filter((voice) => {
    const words = LABEL_GROUPS.map(({ key }) => {
      const value = valueOf(voice, key);
      return value ? `${value} ${plainLabel(key, value)}` : '';
    }).join(' ');
    return (
      (!wanted || `${voice.name} ${words}`.toLowerCase().includes(wanted)) &&
      Object.entries(picked).every(([key, value]) => !value || valueOf(voice, key as LabelKey) === value)
    );
  });
  return found
    .map((voice, at) => ({ voice, at, score: fit(voice, language) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map(({ voice }) => voice);
}

/** "Female · Middle-aged · British · Storytelling", or the category when there are no labels. */
export const describeVoice = (voice: VoiceChoice): string =>
  LABEL_GROUPS.filter(({ key }) => key !== 'descriptive')
    .map(({ key }) => plainLabel(key, valueOf(voice, key)))
    .filter(Boolean)
    .join(' · ') || plainLabel('', voice.category ?? '');

export function failureWords(
  reason: NonNullable<VoicesAnswer['reason']>,
  noKey: string | null | undefined,
): { title: string; detail: string } {
  const title = {
    no_key: noKey || 'ElevenLabs has no key yet. Add one in Settings › Keys to choose voices.',
    bad_key: 'ElevenLabs refused the key. Check it in Settings › Voice.',
    unreachable: 'Can’t reach ElevenLabs right now.',
  }[reason];
  return { title, detail: reason === 'no_key' ? 'Samples are free once the key is in.' : '' };
}
