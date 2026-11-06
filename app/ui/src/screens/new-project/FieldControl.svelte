<!-- The control for one setting, or one part of an object setting, chosen from what the schema says it holds. -->
<script lang="ts">
  import { partLabel, partValue, valueOf } from './brief';
  import BoolControl from './BoolControl.svelte';
  import BrandColours from './BrandColours.svelte';
  import ChipChoice from './ChipChoice.svelte';
  import ChipMulti from './ChipMulti.svelte';
  import { useNewProject } from './context';
  import SelectControl from './SelectControl.svelte';
  import StyleThumbs from './StyleThumbs.svelte';
  import TextControl from './TextControl.svelte';
  import type { Choice, SchemaField, SchemaPart, Value } from './types';

  interface Props {
    field: SchemaField;
    /** Which part of an object setting; leave out for a plain setting. */
    part?: SchemaPart;
  }

  let { field, part }: Props = $props();

  const { form } = useNewProject();

  const source = $derived(part ?? field);
  const label = $derived(part ? partLabel(part.key) : field.label);
  const value = $derived(part ? partValue(field, form.settings, part.key) : valueOf(field, form.settings));
  const choices = $derived<readonly Choice[]>(
    field.id === 'workflow.checkpoints' ? (form.schema?.checkpoints ?? []) : (source.choices ?? []),
  );
  const asStrings = (v: Value): string[] => (Array.isArray(v) ? v.map(String) : []);
  const set = (next: Value) => (part ? form.setPart(field, part.key, next) : form.set(field, next));
</script>

{#if field.id === 'visual.style' && part?.key === 'preset'}
  <StyleThumbs {choices} {value} {label} onpick={set} />
{:else if field.id === 'visual.brand' && part?.key === 'colors'}
  <BrandColours {value} onset={set} />
{:else if source.type === 'choice'}
  {#if choices.length > 7}
    <SelectControl {choices} {value} {label} onpick={set} />
  {:else}
    <ChipChoice {choices} {value} {label} onpick={set} />
  {/if}
{:else if source.type === 'multi'}
  <ChipMulti {choices} values={asStrings(value)} {label} custom={field.custom} onchange={set} />
{:else if source.type === 'bool'}
  <BoolControl {label} checked={value === true} onchange={set} />
{:else if source.type === 'text' || source.type === 'long' || source.type === 'list' || source.type === 'number'}
  <TextControl kind={source.type} {label} {value} min={source.min} max={source.max} onset={set} />
{/if}
