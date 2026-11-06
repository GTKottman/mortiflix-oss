<!-- The left rail: Section, Scope and Status, each with how many lessons it holds. -->
<script lang="ts">
  import FilterGroup from './FilterGroup.svelte';
  import { ALL, scopeLabel, SECTIONS, type Choice, type ScopeFilter, type StatusFilter } from './lessons';
  import type { LessonsView } from './lessons.svelte';

  interface Props {
    view: LessonsView;
    /** The open project, for "Only <project>". */
    project: string;
  }

  let { view, project }: Props = $props();

  // The fixed sections, then any other section a lesson was saved under, so every lesson can be found.
  const names = $derived([
    ...SECTIONS,
    ...new Set(view.lessons.map((l) => l.section).filter((name) => !SECTIONS.some((s) => s === name))),
  ]);

  const section = $derived<Choice[]>([
    { id: ALL, label: ALL, count: view.lessons.length, selected: view.filters.section === ALL },
    ...names.map((name) => ({
      id: name,
      label: name,
      count: view.lessons.filter((l) => l.section === name).length,
      selected: view.filters.section === name,
    })),
  ]);

  const scope = $derived<Choice<ScopeFilter>[]>([
    { id: 'all', label: 'Everything', count: view.lessons.length, selected: view.filters.scope === 'all' },
    {
      id: 'every',
      label: 'Every project',
      count: view.lessons.filter((l) => l.scope === 'all').length,
      selected: view.filters.scope === 'every',
    },
    {
      id: 'project',
      label: scopeLabel(project),
      count: view.lessons.filter((l) => l.scope === 'project').length,
      selected: view.filters.scope === 'project',
    },
  ]);

  const status = $derived<Choice<StatusFilter | 'all'>[]>([
    { id: 'all', label: 'All', count: view.totals.total, selected: !view.filters.status },
    {
      id: 'new',
      label: 'Waiting for you',
      count: view.totals.waiting,
      selected: view.filters.status === 'new',
    },
    { id: 'on', label: 'On', count: view.totals.on, selected: view.filters.status === 'on' },
    { id: 'off', label: 'Off', count: view.totals.off, selected: view.filters.status === 'off' },
  ]);
</script>

<aside aria-label="Filters">
  <FilterGroup title="Section" centered choices={section} onpick={(id) => view.setSection(id)} />
  <FilterGroup title="Scope" choices={scope} onpick={(id) => view.setScope(id)} />
  <FilterGroup title="Status" choices={status} onpick={(id) => view.setStatus(id === 'all' ? null : id)} />
</aside>

<style>
  aside {
    display: grid;
    --rail-gap: 39px;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--rail-gap);
  }
  @media (max-width: 1599px) {
    aside {
      --rail-gap: var(--s-24);
    }
  }
  @media (max-width: 1199px) {
    aside {
      gap: var(--s-8);
    }
  }
</style>
