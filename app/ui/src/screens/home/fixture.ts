import type { HomeProject } from './types';

// `#/?fixture=home`: Home with made-up projects in every group, for screenshots and click-throughs of the ⋯ menu.
// Nothing here reaches the service: rename, duplicate, delete, Undo, pause and Open folder stay in the page.

/** What Home and its menus call: the app's service, or this fixture. */
export interface HomeCaller {
  call<T>(type: string, params?: Record<string, unknown>): Promise<T>;
}

const PROJECTS: HomeProject[] = [
  {
    id: '261102-test-why-ice-is-slippery-0001',
    title: 'Test: Why ice is slippery',
    state: 'waiting',
    stage: 1,
    pipeline: { stage_set: 'v3' },
    needs_you: { text: 'The voice is ready for your OK.' },
    created_at: '2026-11-02T08:55:00.000Z',
  },
  {
    id: '261102-test-how-bees-make-honey-0002',
    title: 'Test: How bees make honey',
    state: 'queued',
    stage: 3,
    pipeline: { stage_set: 'v3' },
    created_at: '2026-11-01T10:00:00.000Z',
  },
  {
    id: '261101-test-the-moon-phases-0003',
    title: 'Test: Why the moon has phases',
    state: 'delivered',
    delivered: true,
    stage: 6,
    pipeline: { stage_set: 'v3' },
    created_at: '2026-10-30T10:00:00.000Z',
  },
];

const COPY_SUFFIX = ' (copy)';

export function homeFixture(): HomeCaller {
  let projects = PROJECTS.map((project) => ({ ...project }));
  let trash: HomeProject[] = [];
  let copies = 0;
  const find = (id: unknown) => projects.find((project) => project.id === id);
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'project.list': () => projects.map((project) => ({ ...project })),
    'project.rename': (params) => {
      const project = find(params['project']);
      if (project) project.title = String(params['title']);
      return { project: params['project'], title: params['title'] };
    },
    'project.duplicate': (params) => {
      const from = find(params['project']);
      if (!from) throw new Error('no such project');
      copies += 1;
      const copy = {
        ...from,
        id: `${from.id}-copy${copies}`,
        title: `${from.title}${COPY_SUFFIX}`,
        state: 'paused',
      };
      projects = [copy, ...projects];
      return { project: copy.id, title: copy.title };
    },
    'project.delete': (params) => {
      const project = find(params['project']);
      if (!project) throw new Error('no such project');
      trash = [...trash, project];
      projects = projects.filter((p) => p !== project);
      return { deleted: project.id };
    },
    'project.restore': (params) => {
      const project = trash.find((p) => p.id === params['project']);
      if (!project) throw new Error('it is not in the trash');
      trash = trash.filter((p) => p !== project);
      projects = [...projects, project];
      return { restored: project.id };
    },
    'project.pause': (params) => Object.assign(find(params['project']) ?? {}, { state: 'paused' }),
    'project.resume': (params) => Object.assign(find(params['project']) ?? {}, { state: 'queued' }),
    'project.cancel': (params) => Object.assign(find(params['project']) ?? {}, { state: 'cancelled' }),
    'files.reveal': () => ({ revealed: true }),
  };
  return {
    call: async <T>(type: string, params: Record<string, unknown> = {}): Promise<T> => {
      const answer = answers[type];
      if (!answer) throw new Error(`the Home fixture does not answer ${type}`);
      return answer(params) as T;
    },
  };
}
