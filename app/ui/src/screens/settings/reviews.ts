import type { StudioSettings } from '../../lib/service/types';

// The three Reviews steppers. Each is one number in `settings.get`, saved with `settings.set`.

export interface ReviewSetting {
  id: string;
  label: string;
  help: string;
  min: number;
  max: number;
  read: (settings: StudioSettings) => number;
  write: (settings: StudioSettings, value: number) => StudioSettings;
  /** The `settings.set` request for this value. */
  request: (value: number) => Record<string, unknown>;
}

export const REVIEW_SETTINGS: readonly ReviewSetting[] = [
  {
    id: 'options',
    label: 'Options shown',
    help: 'How many buttons Claude offers on each screen.',
    min: 1,
    max: 8,
    read: (s) => s.options.count,
    write: (s, count) => ({ ...s, options: { ...s.options, count } }),
    request: (count) => ({ options: { count } }),
  },
  {
    id: 'frames',
    label: 'Style frames per round',
    help: 'How many looks you compare at once.',
    min: 1,
    max: 6,
    read: (s) => s.review.framesPerRound,
    write: (s, framesPerRound) => ({ ...s, review: { ...s.review, framesPerRound } }),
    request: (framesPerRound) => ({ review: { framesPerRound } }),
  },
  {
    id: 'scenes',
    label: 'Scenes per still group',
    help: 'How many scenes you check together on Stills.',
    min: 1,
    max: 6,
    read: (s) => s.review.scenesPerGroup,
    write: (s, scenesPerGroup) => ({ ...s, review: { ...s.review, scenesPerGroup } }),
    request: (scenesPerGroup) => ({ review: { scenesPerGroup } }),
  },
];
