<!-- One accordion of settings. Closed, its header says what is set inside and how many conflicts touch it. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { sectionHeader } from './brief';
  import { useNewProject } from './context';
  import DecideLaterRow from './DecideLaterRow.svelte';
  import DeliveryRecap from './DeliveryRecap.svelte';
  import OutlineRow from './OutlineRow.svelte';
  import PresetsRow from './PresetsRow.svelte';
  import ReferencesRow from './ReferencesRow.svelte';
  import SafeZoneRow from './SafeZoneRow.svelte';
  import SchemaField from './SchemaField.svelte';
  import type { SchemaSection } from './types';

  interface Props {
    section: SchemaSection;
  }

  let { section }: Props = $props();
  const project = useNewProject();
  const { form, live } = project;

  const open = $derived(Boolean(form.open[section.id]));
  const header = $derived(
    sectionHeader(section, form.settings, form.quick, live.conflicts, form.decideLater),
  );
  const fields = $derived(section.fields.filter((f) => !form.quick.includes(f.id)));
</script>

<div class="section" class:open>
  <h2>
    <button
      type="button"
      class="head"
      id="head-{section.id}"
      aria-expanded={open}
      aria-controls="panel-{section.id}"
      onclick={() => project.toggleSection(section.id)}
    >
      <span class="chevron" aria-hidden="true">›</span>
      <span class="title">{section.label}</span>
      <span class="summary">{header.summary}</span>
      <span class="count" class:conflicted={header.conflicted}>{header.count}</span>
    </button>
  </h2>
  <div class="panel" id="panel-{section.id}" role="region" aria-labelledby="head-{section.id}" hidden={!open}>
    <p class="blurb">{section.summary}</p>
    <div class="fields">
      {#if section.id === 'delivery'}<DeliveryRecap />{/if}
      {#if section.id === 'voice'}<DecideLaterRow />{/if}
      {#each fields as field (field.id)}
        <SchemaField {field} />
        {#if field.id === 'story.forbidden_topics'}
          <OutlineRow />
          <ReferencesRow />
        {/if}
      {/each}
      {#if section.id === 'delivery'}<SafeZoneRow />{/if}
      {#if section.id === 'workflow'}<PresetsRow />{/if}
    </div>
    <div>
      <Button size="sm" variant="text" onclick={() => form.resetSection(section)}>Reset this section</Button>
    </div>
  </div>
</div>

<style>
  .section {
    padding-bottom: var(--wave-h);
    background: var(--wave-line) repeat-x left bottom / 24px var(--wave-h);
  }
  h2 {
    font: inherit;
  }
  .head {
    --chevron-w: 12px;
    --head-h: 55px;
    display: grid;
    grid-template-columns: var(--chevron-w) minmax(0, 1fr) auto;
    align-items: center;
    align-content: center;
    column-gap: 0;
    width: 100%;
    min-height: var(--head-h);
    padding: 0 var(--s-16) 0 calc(var(--s-16) + var(--s-4));
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .head:focus-visible {
    outline: var(--focus);
    outline-offset: var(--focus-off);
  }
  .chevron {
    grid-row: 1 / span 2;
    justify-self: start;
    color: var(--muted);
    transition: transform var(--dur-fast) var(--ease);
  }
  .open .chevron {
    transform: rotate(90deg);
  }
  .title {
    grid-column: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    font-size: var(--t15);
  }
  .summary,
  .count {
    color: var(--muted);
    font-size: var(--t13);
  }
  .summary {
    grid-column: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    grid-column: 3;
    grid-row: 1 / span 2;
    white-space: nowrap;
  }
  .conflicted {
    color: var(--bad);
  }
  .panel {
    display: grid;
    gap: var(--s-16);
    padding: 0 0 var(--s-24) var(--s-32);
  }
  .panel[hidden] {
    display: none;
  }
  .blurb {
    max-width: var(--reading);
    color: var(--muted);
    font-size: var(--t14);
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-16) var(--s-32);
  }
</style>
