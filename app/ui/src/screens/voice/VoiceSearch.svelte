<!-- Search by name, accent or mood, and narrow by plain-word filters in groups (Gender, Age, Accent, Language, Use,
     Sound): one pick per group, "Any" by default. -->
<script lang="ts">
  import type { LabelGroup, LabelKey } from './voices';

  interface Props {
    query: string;
    groups: readonly LabelGroup[];
    picked: Readonly<Partial<Record<LabelKey, string>>>;
    onsearch: () => void;
    onpick: (key: LabelKey, value: string) => void;
  }

  let { query = $bindable(), groups, picked, onsearch, onpick }: Props = $props();
  const any = $derived(Object.values(picked).some(Boolean));
</script>

<input
  type="search"
  placeholder="Find a voice: name, accent, mood"
  aria-label="Find a voice"
  bind:value={query}
  oninput={onsearch}
/>
{#if groups.length}
  <div class="filters" role="group" aria-label="Filter voices">
    {#each groups as group (group.key)}
      <label>
        <span>{group.name}</span>
        <select
          value={picked[group.key] ?? ''}
          class:on={Boolean(picked[group.key])}
          onchange={(event) => onpick(group.key, event.currentTarget.value)}
        >
          <option value="">Any</option>
          {#each group.values as option (option.value)}
            <option value={option.value}>{option.text}</option>
          {/each}
        </select>
      </label>
    {/each}
    {#if any}
      <button type="button" class="clear" onclick={() => groups.forEach((g) => onpick(g.key, ''))}
        >Clear filters</button
      >
    {/if}
  </div>
{/if}

<style>
  input {
    flex: 1;
    min-width: calc(var(--s-64) * 2);
    height: var(--h-sm);
    padding: 0 var(--s-8);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--ink-2);
    font-size: var(--t14);
  }
  input:focus {
    border-color: var(--link);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--s-8);
  }
  label {
    display: grid;
    gap: var(--s-2);
    min-width: 0;
  }
  label span {
    color: var(--faint);
    font-size: var(--t12);
    white-space: nowrap;
  }
  select {
    height: var(--s-24);
    max-width: calc(var(--s-64) * 2);
    padding: 0 var(--s-4);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--ink-2);
    color: var(--muted);
    font-size: var(--t12);
  }
  select.on {
    border-color: var(--text);
    color: var(--text);
  }
  select:focus-visible,
  .clear:focus-visible {
    outline: var(--focus);
    outline-offset: 1px;
  }
  .clear {
    height: var(--s-24);
    padding: 0 var(--s-4);
    border: 0;
    background: none;
    color: var(--link);
    font-size: var(--t12);
    white-space: nowrap;
    cursor: pointer;
  }
</style>
