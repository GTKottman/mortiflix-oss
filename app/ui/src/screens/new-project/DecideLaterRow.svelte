<!-- Voice, music, sound design and pauses can wait for the Voice & music step. -->
<script lang="ts">
  import BoolControl from './BoolControl.svelte';
  import { useNewProject } from './context';
  import Note from './Note.svelte';

  const { form } = useNewProject();
</script>

<div class="decide">
  <BoolControl
    short
    label="Decide later"
    checked={form.decidingLater}
    onchange={(on) => form.setDecideLater(on)}
  />
  <Note as="span"
    >Voice, music, sound design and pauses are chosen later in Voice & music. What you set below is kept as a
    first preference.</Note
  >
</div>

<style>
  .decide {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: var(--s-12);
    padding: var(--s-8) 0;
  }
</style>
