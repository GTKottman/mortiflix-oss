<!-- Two or three buttons where exactly one is pressed (Compact | Detailed, This scene | Whole script). -->
<script lang="ts" generics="Id extends string">
  interface Props {
    items: readonly { id: Id; label: string }[];
    value: Id;
    /** What the group chooses, for screen readers. */
    label: string;
    onpick: (id: Id) => void;
    small?: boolean;
  }

  let { items, value, label, onpick, small = false }: Props = $props();
</script>

<div class="group" role="group" aria-label={label}>
  {#each items as item (item.id)}
    <button type="button" class:small aria-pressed={item.id === value} onclick={() => onpick(item.id)}
      >{item.label}</button
    >
  {/each}
</div>

<style>
  .group {
    display: inline-flex;
    gap: var(--s-2);
    padding: 3px;
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--ink-2);
  }
  button {
    flex-shrink: 0;
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
  button:hover {
    color: var(--text);
  }
  button:active {
    transform: scale(0.96);
  }
  .small {
    height: var(--h-toggle-sm);
  }
  button[aria-pressed='true'] {
    background: var(--ink-4);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.06),
      0 1px 3px rgba(0, 0, 0, 0.45);
    color: var(--text);
  }
</style>
