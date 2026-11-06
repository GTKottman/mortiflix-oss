import { getContext, setContext } from 'svelte';
import type { NewProject } from './newProject.svelte';

// The screen's pieces read the one NewProject made by NewProjectScreen, so nothing is passed down by hand.

const KEY = Symbol('new-project');

export function provideNewProject(project: NewProject): void {
  setContext(KEY, project);
}

export function useNewProject(): NewProject {
  const project = getContext<NewProject | undefined>(KEY);
  if (!project) throw new Error('The New project state is missing: render inside NewProjectScreen.');
  return project;
}
