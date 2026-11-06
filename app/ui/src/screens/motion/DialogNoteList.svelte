<!-- The notes a decision is about: where each one points, then its words. -->
<script lang="ts">
  import { clock } from './scenes';
  import type { SceneNote } from './types';

  interface Props {
    notes: readonly SceneNote[];
    /** Show the end of a range note too, not only where it starts. */
    ranges?: boolean;
  }

  let { notes, ranges = false }: Props = $props();

  const where = (note: SceneNote): string => {
    if (note.kind === 'scene') return 'Scene';
    const start = clock(note.time ?? 0);
    return ranges && note.time_end !== undefined ? `${start}–${clock(note.time_end)}` : start;
  };
</script>

<ul>
  {#each notes as note (note.id)}
    <li><b>{where(note)}</b>{note.text || 'Spoken note'}</li>
  {/each}
</ul>

<style>
  ul {
    display: grid;
    gap: var(--s-4);
    list-style: none;
    color: var(--muted);
    font-size: var(--t13);
  }
  b {
    white-space: nowrap;
    margin-right: var(--s-8);
    color: var(--link);
    font: 400 var(--t13) / 1.4 var(--mono);
  }
</style>
