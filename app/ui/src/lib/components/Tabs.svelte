<!-- Tabs: one row of choices, one selected. Arrow keys move between them (roving focus), Home/End jump.
     The parent renders the panel: <div role="tabpanel" id={panelId} aria-labelledby={tabId(value)}>. -->
<script lang="ts" module>
  export interface TabItem<Id extends string = string> {
    id: Id;
    label: string;
  }

  /** The id of a tab's button, for the panel's aria-labelledby. */
  export const tabId = (group: string, id: string): string => `${group}-tab-${id}`;
</script>

<script lang="ts" generics="Id extends string">
  interface Props {
    items: readonly TabItem<Id>[];
    value: Id;
    /** What the tabs choose, read by screen readers, e.g. "Time range". */
    label: string;
    /** Unique per tab group: the tab ids and the panel id are made from it. */
    group: string;
    onchange?: (id: Id) => void;
  }

  let { items, value = $bindable(), label, group, onchange }: Props = $props();
  const buttons: HTMLButtonElement[] = $state([]);

  function pick(id: Id) {
    value = id;
    onchange?.(id);
  }

  function onkeydown(event: KeyboardEvent) {
    const at = items.findIndex((item) => item.id === value);
    const moves: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: items.length - 1,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const index = (to + items.length) % items.length;
    const item = items[index];
    if (!item) return;
    pick(item.id);
    buttons[index]?.focus();
  }
</script>

<div class="tabs" role="tablist" aria-label={label} tabindex="-1" {onkeydown}>
  {#each items as item, i (item.id)}
    <button
      bind:this={buttons[i]}
      id={tabId(group, item.id)}
      class="tab"
      type="button"
      role="tab"
      aria-selected={item.id === value}
      aria-controls="{group}-panel"
      tabindex={item.id === value ? 0 : -1}
      onclick={() => pick(item.id)}>{item.label}</button
    >
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--s-2);
    padding: 3px;
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--ink-2);
  }
  .tab {
    flex: 1 0 auto;
    height: var(--btn-h);
    padding: 0 var(--btn-pad);
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    font: 500 var(--t13) / 1 var(--body);
    white-space: nowrap;
    cursor: pointer;
    transition:
      color 180ms ease,
      background 200ms var(--ease-out-quart),
      transform 120ms ease;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab:active {
    transform: scale(0.96);
  }
  .tab[aria-selected='true'] {
    background: var(--ink-4);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.06),
      0 1px 3px rgba(0, 0, 0, 0.45);
    color: var(--text);
  }
</style>
