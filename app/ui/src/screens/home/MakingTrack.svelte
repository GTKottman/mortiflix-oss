<!-- "Making": the projects the AI is working on, nothing to do. The newest stays in the middle and the others grow
     out to the right and left. -->
<script lang="ts">
  import GroupHead from './GroupHead.svelte';
  import ProjectShelf from './ProjectShelf.svelte';
  import { middleOut, middleStart } from './shelf-layout';
  import type { HomeProject, Still } from './types';

  interface Props {
    /** Newest first. */
    projects: readonly HomeProject[];
    stills: Record<string, Still>;
    opening: string | null;
    failure: { id: string; message: string } | null;
    onopen: (project: HomeProject) => void;
  }

  let { projects, stills, opening, failure, onopen }: Props = $props();
</script>

<GroupHead kicker="Making" count={projects.length} />
<ProjectShelf
  projects={middleOut(projects)}
  {stills}
  {opening}
  {failure}
  {onopen}
  label="Projects being made, newest in the middle"
  startAt={middleStart}
/>
