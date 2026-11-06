<!-- Delivery's first line: the two quick choices made above, with a way back to them. -->
<script lang="ts">
  import LinkButton from '../../lib/components/LinkButton.svelte';
  import { choiceLabel, formatDuration, valueOf } from './brief';
  import { useNewProject } from './context';
  import Note from './Note.svelte';

  const project = useNewProject();
  const { form } = project;

  const destination = $derived.by(() => {
    const field = form.fields['delivery.destination'];
    return field ? choiceLabel(field.choices, valueOf(field, form.settings)) : '';
  });
  const length = $derived(form.lengthSeconds ? formatDuration(form.lengthSeconds) : 'Auto');
</script>

<div class="recap">
  <Note>
    {#if destination}Destination: {destination}.{/if} Length: {length}.
    <LinkButton onclick={() => project.focus('destination')}>Change above</LinkButton>
  </Note>
</div>

<style>
  .recap {
    grid-column: 1 / -1;
  }
</style>
