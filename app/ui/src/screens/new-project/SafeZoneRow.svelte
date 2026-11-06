<!-- Delivery repeats the safe zone drawing of Visual direction, for the main shape. -->
<script lang="ts">
  import { useNewProject } from './context';
  import Note from './Note.svelte';
  import SafeZone from './SafeZone.svelte';

  const { form } = useNewProject();
</script>

<div class="row">
  <b>Safe zones</b>
  <Note>This follows Safe zones under Visual direction, for the main shape.</Note>
  <SafeZone aspect={form.mainShape} />
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
