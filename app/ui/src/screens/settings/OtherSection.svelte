<!-- Other connections: what else Mortiflix found on this computer. Read-only, folded; it opens by itself when
     something needs a fix. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { otherRows, rowWords } from './other';
  import SettingsSection from './SettingsSection.svelte';
  import type { SettingsPage } from './settings-page.svelte';

  interface Props {
    page: SettingsPage;
  }

  let { page }: Props = $props();
  const rows = $derived(otherRows(page.components, page.status));
  const ready = $derived(rows.filter((row) => row.ready).length);
  const broken = $derived(rows.filter((row) => row.needsFix).length);
  let chosen = $state<boolean | null>(null);
  const open = $derived(chosen ?? broken > 0);
  const id = $props.id();
</script>

<SettingsSection title="Other connections" lede="What else Mortiflix found on this computer.">
  {#if page.componentsError}
    <ErrorState
      inline
      title="Couldn't read the list"
      detail={page.componentsError}
      onretry={() => void page.loadComponents()}
    />
  {/if}
  {#if page.components === null && !page.componentsError && !rows.length}
    <LoadingState text="Looking at this computer…" />
  {:else if !rows.length}
    {#if !page.componentsError}<p class="why">Nothing else found.</p>{/if}
  {:else}
    <div class="fold">
      <span class="count">{ready} of {rows.length} ready</span>
      {#if broken}
        <span class="count"
          ><StatusMark mark="fix" text={`${broken} need${broken === 1 ? 's' : ''} a fix`} /></span
        >
      {/if}
      <Button variant="text" aria-expanded={open} aria-controls="{id}-list" onclick={() => (chosen = !open)}
        >{open ? 'Hide' : 'Show'}</Button
      >
    </div>
    {#if open}
      <div class="others" id="{id}-list">
        {#each rows as row (row.name)}
          <span class="name">{row.name}</span>
          <span class="state">
            <StatusMark mark={row.ready ? 'ok' : row.needsFix ? 'fix' : 'wait'} text={rowWords(row)} />
          </span>
        {/each}
      </div>
    {/if}
  {/if}
</SettingsSection>

<style>
  .fold {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-12);
  }
  .count {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .why {
    color: var(--muted);
    font-size: var(--t13);
  }
  .others {
    --name-w: 280px;
    display: grid;
    grid-template-columns: minmax(0, var(--name-w)) auto;
    justify-content: start;
    font-size: var(--t13);
  }
  .others > * {
    padding: var(--s-8) 0;
    border-bottom: 1px solid var(--line);
  }
  .name {
    color: var(--text);
  }
  /* Room between the columns comes from padding, so each row's hairline runs unbroken under both. */
  .state {
    padding-left: var(--s-48);
    white-space: nowrap;
  }
</style>
