<!-- The persistent panel beside a timeline: it is always there, so nothing around it moves when the selection
     changes. A head (title, small line, actions), an optional band under it (e.g. Claude's options), optional tabs,
     then the body, which scrolls on its own. Sections inside it: InspectorSection.
       label      names the panel for screen readers
       title      the big words in the head; leave out for a body with no head
       kicker     small caps above the title, e.g. "AUDIO OVERVIEW"
       subtitle   one muted line under the title
       actions    the head's right side: status, previous / next
       lead       a band between the head and the body
       tabs, tab  when the body has tabs; `children` gets the open tab's id
       children   the body -->
<script lang="ts" module>
  export interface InspectorTab {
    id: string;
    label: string;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import Tabs, { tabId } from './Tabs.svelte';

  interface Props {
    label: string;
    title?: string;
    kicker?: string;
    subtitle?: string;
    tabs?: readonly InspectorTab[];
    tab?: string;
    actions?: Snippet;
    lead?: Snippet;
    children: Snippet<[tab: string]>;
  }

  let {
    label,
    title,
    kicker,
    subtitle,
    tabs,
    tab = $bindable(tabs?.[0]?.id ?? ''),
    actions,
    lead,
    children,
  }: Props = $props();
  const group = $props.id();
  // The tab on show: the chosen one while it is in the list, else the first (tabs that arrive after mount, or a
  // chosen tab that left the list). A $bindable default is read only once, so it cannot do this by itself.
  const current = $derived(tabs?.some((item) => item.id === tab) ? tab : (tabs?.[0]?.id ?? tab));
</script>

<aside class="inspector" aria-label={label}>
  {#if title || kicker || actions}
    <header class="head">
      <div class="name">
        {#if kicker}<p class="kicker">{kicker}</p>{/if}
        {#if title}<b>{title}</b>{/if}
        {#if subtitle}<span>{subtitle}</span>{/if}
      </div>
      {@render actions?.()}
    </header>
  {/if}
  {@render lead?.()}
  {#if tabs}
    <Tabs items={tabs} value={current} {label} {group} onchange={(id) => (tab = id)} />
    <div role="tabpanel" id="{group}-panel" aria-labelledby={tabId(group, current)} class="body">
      {@render children(current)}
    </div>
  {:else}
    <div class="body">{@render children(tab)}</div>
  {/if}
</aside>

<style>
  .inspector {
    display: grid;
    align-content: start;
    grid-auto-rows: max-content;
    /* one column the panel wide: values never run under the panel's edge (owner's tablet 2026-11-04) */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-12);
    min-height: 0;
    padding-left: var(--s-24);
    scrollbar-gutter: stable;
    border-left: 1px solid var(--line);
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--ink-4) transparent;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
  .name {
    display: grid;
    min-width: 0;
    margin-right: auto;
  }
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  b {
    font-size: var(--t17);
    font-weight: 500;
  }
  .name span {
    overflow-wrap: anywhere;
    color: var(--muted);
    font-size: var(--t14);
  }
  .body {
    display: grid;
    gap: var(--s-12);
  }
</style>
