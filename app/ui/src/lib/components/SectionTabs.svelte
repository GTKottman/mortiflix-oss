<!-- The top bar's sections when no project stage is open: Projects | Lessons | Settings. -->
<script lang="ts" module>
  export type Section = 'projects' | 'lessons' | 'settings';
</script>

<script lang="ts">
  import { routeHref } from '../router.svelte';

  interface Props {
    current: Section;
  }

  let { current }: Props = $props();

  const SECTIONS: readonly { id: Section; label: string; path: string }[] = [
    { id: 'projects', label: 'Projects', path: '/' },
    { id: 'lessons', label: 'Lessons', path: '/lessons' },
    { id: 'settings', label: 'Settings', path: '/settings' },
  ];
</script>

<nav class="sections" aria-label="Sections">
  {#each SECTIONS as section (section.id)}
    <a
      class:on={section.id === current}
      href={routeHref(section.path)}
      aria-current={section.id === current ? 'page' : undefined}>{section.label}</a
    >
  {/each}
</nav>

<style>
  .sections {
    display: flex;
    align-self: stretch;
    gap: var(--s-24);
  }
  a {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    font-size: var(--t13);
    font-weight: 600;
    text-decoration: none;
    transition: color var(--dur-fast) var(--ease);
  }
  a:hover,
  .on {
    color: var(--text);
  }
  .on {
    border-bottom-color: var(--violet);
  }
</style>
