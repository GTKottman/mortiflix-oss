<!-- A shortcut to the Outline checkpoint of Production workflow: stop at an outline before the script. -->
<script lang="ts">
  import BoolControl from './BoolControl.svelte';
  import { useNewProject } from './context';
  import { valueOf } from './brief';
  import Note from './Note.svelte';

  const { form } = useNewProject();

  const field = $derived(form.fields['workflow.checkpoints']);
  const offered = $derived(Boolean(field && form.schema?.checkpoints.some((c) => c.value === 'outline')));
  const chosen = $derived((field ? valueOf(field, form.settings) : []) as string[]);

  function change(on: boolean) {
    if (!field || !form.schema) return;
    form.set(
      field,
      form.schema.checkpoints.map((c) => c.value).filter((v) => (v === 'outline' ? on : chosen.includes(v))),
    );
  }
</script>

{#if offered}
  <div class="row">
    <BoolControl
      label="Stop at an outline before the script"
      checked={chosen.includes('outline')}
      onchange={change}
    />
    <Note>You read and OK the outline first. Same as the Outline checkpoint in Production workflow.</Note>
  </div>
{/if}

<style>
  .row {
    display: grid;
    grid-column: 1 / -1;
    gap: var(--s-8);
  }
</style>
