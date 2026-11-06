import type { Preset } from './types';

// Starting points the owner can apply to the settings. They never touch the idea, the name or the sources.

export const TEMPLATES: readonly Preset[] = [
  {
    name: 'Quick explainer',
    template: true,
    brief: {
      story: { research_depth: 'quick', verification: 'light', structure: 'explainer', hook: 'question' },
    },
  },
  {
    name: 'Documentary deep dive',
    template: true,
    brief: {
      story: {
        research_depth: 'investigative',
        verification: 'strict',
        structure: 'documentary',
        citations: 'on_screen',
      },
      workflow: {
        checkpoints: ['outline', 'script', 'voice_music', 'look', 'stills', 'motion', 'sound', 'final'],
      },
    },
  },
  {
    name: 'Short vertical',
    template: true,
    brief: {
      delivery: { destination: 'tiktok', aspects: ['9:16'] },
      story: { hook: 'bold_claim' },
      visual: { captions: { mode: 'on', style: 'word_by_word' }, motion_intensity: 'intense' },
    },
  },
];
