<!-- Reference videos and scripts are sources: this points to the tray. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { useNewProject } from './context';
  import Note from './Note.svelte';

  const project = useNewProject();
</script>

<div class="row">
  <b>Reference videos, scripts and inspiration</b>
  <Note>They live in the source tray above, so the whole project shares them.</Note>
  <div><Button size="sm" onclick={() => project.focus('link')}>Add to the source tray</Button></div>
</div>

<style>
  .row {
    display: grid;
    grid-column: 1 / -1;
    gap: var(--s-8);
  }
  b {
    font-size: var(--t14);
    font-weight: 500;
    white-space: nowrap;
  }
</style>
