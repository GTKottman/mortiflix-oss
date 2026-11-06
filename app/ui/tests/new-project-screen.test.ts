import { describe, expect, it, vi } from 'vitest';
import type { ServiceClient } from '../src/lib/service/client';
import { ServiceError } from '../src/lib/service/client';
import { Problems } from '../src/lib/stores/problems.svelte';
import { NewProject } from '../src/screens/new-project/newProject.svelte';

// Create script is never pressed on the shared bridge: here the service is a stub that records what it was sent.

function stubService(answers: Record<string, () => unknown>) {
  const calls: { type: string; params: Record<string, unknown> }[] = [];
  const client = {
    call: vi.fn((type: string, params: Record<string, unknown> = {}) => {
      calls.push({ type, params });
      const answer = answers[type];
      return answer
        ? Promise.resolve(answer())
        : Promise.reject(new ServiceError('no such call', 'unknown_type'));
    }),
    on: vi.fn(() => () => undefined),
  } as unknown as ServiceClient;
  return { client, calls };
}

const IDEA = 'How heat pumps work, for homeowners deciding this year.';

describe('Create script', () => {
  it('is not ready until the idea says enough', () => {
    const { client } = stubService({});
    const project = new NewProject(client, new Problems(), { onCreated: async () => undefined });
    expect(project.valid).toBe(false);
    expect(project.why).toBe('');
    project.form.setIdea('short');
    expect(project.why).toBe('A few more words please: what is it about, and for whom?');
    project.form.setIdea(IDEA);
    expect(project.valid).toBe(true);
  });

  it('sends the idea, the name and only what was touched, then goes to the script', async () => {
    const { client, calls } = stubService({ 'project.new': () => ({ id: 'p-1' }) });
    const created: string[] = [];
    const project = new NewProject(client, new Problems(), {
      onCreated: async (id) => {
        created.push(id);
      },
    });
    project.form.setIdea(IDEA);
    project.form.setTitle('  Heat pumps ');
    await project.create();
    expect(created).toEqual(['p-1']);
    expect(calls.find((c) => c.type === 'project.new')?.params).toEqual({
      preset: 'v3',
      idea: IDEA,
      title: 'Heat pumps',
      brief: { version: 1, idea: IDEA, title: '  Heat pumps ' },
      start: true,
    });
  });

  it('says plainly what failed, keeps the brief and offers Try again', async () => {
    const { client } = stubService({
      'project.new': () => {
        throw new ServiceError('The service did not answer.');
      },
    });
    const problems = new Problems();
    const project = new NewProject(client, problems, { onCreated: async () => undefined });
    project.form.setIdea(IDEA);
    await project.create();
    expect(project.busy).toBe(false);
    expect(problems.current?.text).toBe(
      'Could not create the project: The service did not answer. Your brief is kept.',
    );
    expect(problems.current?.fix?.label).toBe('Try again');
    expect(project.form.idea).toBe(IDEA);
  });

  it('when the made project does not open, unlocks, says so and opens it again without a second project', async () => {
    const { client, calls } = stubService({ 'project.new': () => ({ id: 'p-1' }) });
    const problems = new Problems();
    let fail = true;
    const opened: string[] = [];
    const project = new NewProject(client, problems, {
      onCreated: async (id) => {
        if (fail) throw new Error('no answer');
        opened.push(id);
      },
    });
    project.form.setIdea(IDEA);
    await project.create();
    expect(project.busy).toBe(false);
    expect(project.created).toBe(true);
    expect(problems.current?.text).toBe('Your project is made, but it did not open: no answer');
    expect(problems.current?.fix?.label).toBe('Open project');
    fail = false;
    await project.create();
    expect(opened).toEqual(['p-1']);
    expect(calls.filter((c) => c.type === 'project.new')).toHaveLength(1);
  });

  it('says so when the service cannot create projects yet', async () => {
    const { client } = stubService({});
    const problems = new Problems();
    const project = new NewProject(client, problems, { onCreated: async () => undefined });
    project.form.setIdea(IDEA);
    await project.create();
    expect(problems.current?.text).toBe(
      'Creating a project is not available in this build yet. Nothing was made, and your brief is kept.',
    );
  });
});
