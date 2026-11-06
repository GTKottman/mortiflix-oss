import type { Problems } from '../../lib/stores/problems.svelte';
import type { NewProject } from './newProject.svelte';
import type { LiveDemo } from './live.svelte';
import type { ServiceSource, Suggestion } from './types';

// Screenshot states, opened as /app/?demo=<name>#/new. The form is real, but nothing is saved, created or asked of
// Claude, so a screen can be looked at without touching the shared studio.

export const DEMO_NAMES = [
  'idea',
  'sources',
  'accordion',
  'conflict',
  'improve',
  'creating',
  'error',
] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

export const isDemoName = (name: string | null): name is DemoName =>
  DEMO_NAMES.some((known) => known === name);

const IDEA =
  'How heat pumps work, for homeowners deciding this year. They should leave knowing the one number to ask installers for.';

const SUGGESTIONS: Suggestion[] = [
  {
    id: 'c1',
    kind: 'set',
    path: 'story.audience',
    value: 'curious beginners',
    label: 'Set the audience to "curious beginners".',
    why: 'Your idea does not say who watches.',
  },
  {
    id: 'c2',
    kind: 'set',
    path: 'story.hook',
    value: 'question',
    label: 'Open with a question.',
    why: 'Your idea is a question.',
  },
  { id: 'c3', kind: 'clarify', label: 'What should a viewer do at the end?' },
];

export const demoSuggestions = (name: DemoName | null): LiveDemo | null =>
  name ? { suggestions: SUGGESTIONS } : null;

const TRAY: ServiceSource[] = [
  {
    id: 's01',
    kind: 'url',
    label: 'Heat pump systems | Department of Energy',
    url: 'https://www.energy.gov/energysaver/heat-pump-systems',
    status: 'ready',
    status_text: 'Read · 5,321 characters',
  },
  {
    id: 's02',
    kind: 'pdf',
    label: 'installer-quotes-2026.pdf',
    bytes: 2.4e6,
    status: 'ready',
    status_text: 'Read · 12 pages',
  },
  {
    id: 's03',
    kind: 'url',
    label: 'https://www.youtube.com/watch?v=abc123',
    url: 'https://www.youtube.com/watch?v=abc123',
    status: 'fetching',
    status_text: 'Reading…',
  },
  {
    id: 's04',
    kind: 'image',
    label: 'sketch-outdoor-unit.png',
    bytes: 3.1e5,
    status: 'stored',
    status_text: 'Kept as it is',
  },
  {
    id: 's05',
    kind: 'url',
    label: 'https://old.example.com/gone',
    url: 'https://old.example.com/gone',
    status: 'failed',
    error: "Couldn't reach that page (404). Remove it or try another link.",
  },
];

const LATER_MS = 600;

export function applyDemo(project: NewProject, name: DemoName, problems: Problems): void {
  const { form } = project;
  form.idea = IDEA;
  if (['sources', 'accordion', 'improve', 'creating'].includes(name)) project.sources.replace(TRAY);
  if (name === 'accordion') {
    form.open = { story: true };
    form.settings = {
      story: {
        audience: 'homeowners deciding this year',
        tone: ['cinematic'],
        research_depth: 'investigative',
        citations: 'on_screen',
        structure: 'explainer',
      },
      delivery: { destination: 'youtube' },
    };
  }
  if (name === 'conflict') {
    form.open = { story: true, delivery: true };
    form.settings = {
      delivery: { destination: 'tiktok', duration: { mode: 'manual', seconds: 20 }, aspects: ['16:9'] },
      story: { research_depth: 'investigative' },
    };
  }
  if (name === 'improve') {
    form.settings = { delivery: { destination: 'youtube' } };
    setTimeout(() => void project.live.improve(), LATER_MS - 100);
  }
  if (name === 'creating') setTimeout(() => project.lock(true), LATER_MS);
  if (name === 'error') {
    setTimeout(
      () =>
        problems.raise({
          id: 'np-create',
          kind: 'bad',
          text: 'Could not create the project: the service did not answer. Your brief is kept.',
          fix: { label: 'Try again', run: () => Promise.resolve('Trying again.') },
        }),
      LATER_MS,
    );
  }
  project.live.refresh();
}
