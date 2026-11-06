<!-- Where will it be seen? The destination drop-down, with the shape it usually uses and a way to take that shape. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import LinkButton from '../../lib/components/LinkButton.svelte';
  import { choiceLabel, conflictsAt, RECOMMENDED_SHAPE, valueOf } from './brief';
  import ConflictNote from './ConflictNote.svelte';
  import { useNewProject } from './context';
  import Note from './Note.svelte';
  import SelectBox from './SelectBox.svelte';

  const project = useNewProject();
  const { form, live } = project;
  const id = $props.id();

  const destinationField = $derived(form.fields['delivery.destination']);
  const shapesField = $derived(form.fields['delivery.aspects']);
  const destination = $derived(
    destinationField ? String(valueOf(destinationField, form.settings)) : 'youtube',
  );
  const recommended = $derived(RECOMMENDED_SHAPE[destination] ?? '16:9');

  let select = $state<HTMLSelectElement>();

  onMount(() => project.registerFocus('destination', () => select?.focus()));

  function useRecommended() {
    if (!shapesField) return;
    const shapes = valueOf(shapesField, form.settings);
    const rest = (Array.isArray(shapes) ? shapes.map(String) : []).filter((shape) => shape !== recommended);
    form.set(shapesField, [recommended, ...rest]);
  }
</script>

<div class="field">
  <label for="{id}-destination">Where will it be seen?</label>
  <SelectBox
    bind:element={select}
    id="{id}-destination"
    value={destination}
    onchange={(value) => destinationField && form.set(destinationField, value)}
  >
    {#each destinationField?.choices ?? [] as choice (choice.value)}
      <option value={String(choice.value)}>{choice.label}</option>
    {/each}
  </SelectBox>
  {#if form.mainShape !== recommended && shapesField}
    <Note><LinkButton onclick={useRecommended}>Use {recommended} as the main shape</LinkButton></Note>
  {/if}
  {#each conflictsAt(live.conflicts, 'delivery.destination') as conflict (conflict.id)}<ConflictNote
      {conflict}
    />{/each}
</div>

<style>
  .field {
    display: grid;
    gap: var(--s-8);
    align-content: start;
  }
  label {
    color: var(--muted);
    font-size: var(--t13);
    text-align: center;
  }
</style>
