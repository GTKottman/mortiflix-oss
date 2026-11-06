<!-- One setting, drawn from the schema: its name, a Reset when changed, its control(s), help, and any conflict it is in. -->
<script lang="ts">
  import LinkButton from '../../lib/components/LinkButton.svelte';
  import { conflictsAt, isSet, partLabel } from './brief';
  import ConflictNote from './ConflictNote.svelte';
  import { useNewProject } from './context';
  import FieldControl from './FieldControl.svelte';
  import Note from './Note.svelte';
  import SafeZone from './SafeZone.svelte';
  import type { SchemaField } from './types';

  interface Props {
    field: SchemaField;
  }

  let { field }: Props = $props();
  const { form, live } = useNewProject();

  const wide = $derived(
    field.type === 'object' || field.type === 'list' || field.type === 'multi' || field.id === 'visual.style',
  );
</script>

<div class="field" class:wide>
  <div class="label">
    <b>{field.label}</b>
    {#if isSet(form.settings, field.id)}
      <LinkButton onclick={() => form.reset(field)}>Reset</LinkButton>
    {/if}
  </div>
  {#if field.type === 'object'}
    <div class="parts">
      {#each field.parts ?? [] as part (part.key)}
        <div class="field" class:wide={part.type === 'choice' && field.id === 'visual.style'}>
          {#if part.type !== 'bool'}<div class="label"><span>{partLabel(part.key)}</span></div>{/if}
          <FieldControl {field} {part} />
          {#if part.help}<Note>{part.help}</Note>{/if}
        </div>
      {/each}
    </div>
  {:else}
    <FieldControl {field} />
  {/if}
  {#if field.help}<Note>{field.help}</Note>{/if}
  {#if field.id === 'visual.safe_zones'}<SafeZone aspect={form.mainShape} />{/if}
  {#if field.id === 'visual.asset_strategy'}
    <Note>
      Every picture is drawn by Mortiflix in code, or is a file you add. Your files win where both fit.
    </Note>
  {/if}
  {#each conflictsAt(live.conflicts, field.id) as conflict (conflict.id)}<ConflictNote {conflict} />{/each}
</div>

<style>
  .field {
    display: grid;
    gap: var(--s-8);
    min-width: 0;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .label {
    display: flex;
    align-items: baseline;
    gap: var(--s-12);
    color: var(--muted);
    font-size: var(--t13);
  }
  .label b {
    color: var(--text);
    font-weight: 500;
    font-size: var(--t14);
  }
  .parts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-16) var(--s-32);
  }
</style>
