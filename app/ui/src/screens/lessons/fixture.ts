import type { ReviewService } from '../../lib/review/types';
import type { Lesson } from './types';

// `#/lessons?fixture=lessons`: the screen with lessons in every state, for screenshots and click-throughs. The
// owner's studio has none yet, and nothing here reaches the service: switches, edits and deletes stay in the page.

const LESSONS: Lesson[] = [
  {
    id: 'f1',
    name: 'Six Words on Screen',
    text: 'Keep on-screen words to six or fewer; the voice says the rest.',
    section: 'Picture and words',
    approved: false,
    on: false,
    scope: 'all',
    used: 0,
    source: {
      project: '261023-black-october-the-cves-hitting-t-fa2f',
      project_title: 'Black October',
      node: 's03',
      note: 'Too much text on this card, I can’t read it in time.',
    },
  },
  {
    id: 'f2',
    name: 'Hold the First Frame',
    text: 'Hold the first frame for half a second before anything moves.',
    section: 'Motion',
    approved: true,
    on: true,
    scope: 'all',
    used: 14,
    source: {
      project: '261017-how-bees-make-honey-27d0',
      project_title: 'How Bees Make Honey',
      node: 's01',
      note: 'It starts moving before I can see it.',
    },
  },
  {
    id: 'f3',
    text: 'Use the accent colour once per frame, on the thing the voice is talking about.',
    section: 'Design',
    approved: true,
    on: true,
    scope: 'all',
    used: 9,
  },
  {
    id: 'f4',
    text: 'Music ducks under the voice by 8 dB, not more.',
    section: 'Sound',
    approved: true,
    on: false,
    scope: 'project',
    used: 3,
    project: '261023-black-october-the-cves-hitting-t-fa2f',
    source: { project: '261023-black-october-the-cves-hitting-t-fa2f', project_title: 'Black October' },
  },
];

export function lessonsFixture(): ReviewService {
  let lessons = LESSONS.map((lesson) => ({ ...lesson }));
  let trash: Lesson[] = [];
  const find = (id: unknown) => lessons.find((lesson) => lesson.id === id);
  const answer = async <T>(value: unknown): Promise<T> => value as T;
  return {
    call: <T>(type: string, params: Record<string, unknown> = {}): Promise<T> => {
      const lesson = find(params['id']);
      if (type === 'lessons.toggle' && lesson) lesson.on = params['on'] === true;
      if (type === 'lessons.approve' && lesson) Object.assign(lesson, { approved: true, on: true });
      if (type === 'lessons.edit' && lesson)
        Object.assign(lesson, {
          name: String(params['name'] ?? lesson.name ?? ''),
          text: String(params['text'] ?? lesson.text),
          section: String(params['section'] ?? lesson.section),
          scope: params['scope'] === 'all' || params['scope'] === 'project' ? params['scope'] : lesson.scope,
        });
      if (type === 'lessons.delete' && lesson) {
        trash.push(lesson);
        lessons = lessons.filter((l) => l !== lesson);
      }
      const gone = trash.find((l) => l.id === params['id']);
      if (type === 'lessons.restore' && gone) {
        trash = trash.filter((l) => l !== gone);
        lessons = [...lessons, gone];
      }
      return answer<T>(type === 'lessons.list' ? { lessons: lessons.map((l) => ({ ...l })) } : { ok: true });
    },
    on: () => () => undefined,
  };
}
