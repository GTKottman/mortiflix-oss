<!-- Home's groups of projects, each a shelf above a wavy line: the ones that need you first (no title, owner's
     drawing 2026-11-05), then Making, then Done / drafts. -->
<script lang="ts">
  import GroupHead from './GroupHead.svelte';
  import MakingTrack from './MakingTrack.svelte';
  import ProjectShelf from './ProjectShelf.svelte';
  import type { Group, HomeProject, Still } from './types';

  interface Props {
    groups: Record<Group, HomeProject[]>;
    stills: Record<string, Still>;
    opening: string | null;
    failure: { id: string; message: string } | null;
    onopen: (project: HomeProject) => void;
  }

  let { groups, stills, opening, failure, onopen }: Props = $props();
</script>

{#if groups.needs.length}
  <section class="group" aria-label="Needs you">
    <ProjectShelf
      projects={groups.needs}
      {stills}
      {opening}
      {failure}
      {onopen}
      label="Projects that need you"
    />
  </section>
{/if}
{#if groups.making.length}
  <section class="group" aria-label="Making">
    <MakingTrack projects={groups.making} {stills} {opening} {failure} {onopen} />
  </section>
{/if}
{#if groups.done.length}
  <section class="group" aria-label="Done / drafts">
    <GroupHead kicker="Done / drafts" count={groups.done.length} />
    <ProjectShelf
      projects={groups.done}
      {stills}
      {opening}
      {failure}
      {onopen}
      label="Done and draft projects"
    />
  </section>
{/if}

<style>
  .group {
    padding: var(--s-24) 0 var(--s-12);
    background: var(--wave-line) repeat-x left bottom / 24px 6px;
  }
</style>
