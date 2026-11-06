<!-- A ⋯ menu holding every action for the selected clip or cue, so none is only a scroll away. Esc or a click outside
     closes it; arrow keys, Home and End move between items. -->
<script lang="ts" module>
  export interface MenuItem {
    label: string;
    run?: () => void;
    href?: string;
    disabled?: boolean;
    /** Why it is off, or what it does, on hover. */
    title?: string;
    /** A line above this item. */
    divider?: boolean;
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../../lib/components/Button.svelte';

  interface Props {
    label: string;
    items: readonly MenuItem[];
    /** Which edge the menu lines up with: the right (default) or, when the button sits at the left, the left. */
    align?: 'left' | 'right';
  }

  let { label, items, align = 'right' }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLElement>();
  let trigger = $state<HTMLElement>();
  let menu = $state<HTMLElement>();

  const focusable = (): HTMLElement[] => [
    ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
  ];

  async function toggle() {
    open = !open;
    if (!open) return;
    await tick();
    focusable()[0]?.focus();
  }

  function close(focusTrigger = true) {
    open = false;
    if (focusTrigger) trigger?.focus();
  }

  function onMenuKey(event: KeyboardEvent) {
    const list = focusable();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowDown') list[(at + 1) % list.length]?.focus();
    else if (event.key === 'ArrowUp') list[(at - 1 + list.length) % list.length]?.focus();
    else if (event.key === 'Home') list[0]?.focus();
    else if (event.key === 'End') list.at(-1)?.focus();
    else if (event.key === 'Tab') {
      close(false);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function closeOn(event: Event) {
    if (open && event.target instanceof Node && !root?.contains(event.target)) open = false;
  }
</script>

<svelte:window onclick={closeOn} />

<div class="more" bind:this={root}>
  <button
    bind:this={trigger}
    class="dots"
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    title={label}
    onclick={toggle}>⋯</button
  >
  {#if open}
    <div
      class="menu"
      class:left={align === 'left'}
      role="menu"
      tabindex="-1"
      bind:this={menu}
      onkeydown={onMenuKey}
    >
      {#each items as item (item.label)}
        {#if item.divider}<hr />{/if}
        <Button
          size="sm"
          variant="text"
          item
          role="menuitem"
          href={item.href}
          disabled={item.disabled}
          title={item.title}
          onclick={() => {
            close(false);
            item.run?.();
          }}>{item.label}</Button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .more {
    position: relative;
    flex-shrink: 0;
  }
  .dots {
    display: inline-grid;
    place-items: center;
    width: var(--h-sm);
    height: var(--h-sm);
    border: 1px solid transparent;
    border-radius: var(--r);
    background: none;
    color: var(--muted);
    font: 600 var(--t16) / 1 var(--body);
    cursor: pointer;
  }
  .dots:hover,
  .dots[aria-expanded='true'] {
    border-color: var(--line-2);
    color: var(--text);
  }
  .dots:focus-visible {
    outline: var(--focus);
    outline-offset: 1px;
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--s-4));
    right: 0;
    z-index: var(--z-menu);
    display: grid;
    min-width: max-content;
    gap: var(--s-2);
    padding: var(--s-4);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-3);
  }
  .menu.left {
    right: auto;
    left: 0;
  }
  hr {
    margin: var(--s-2) 0;
    border: 0;
    border-top: 1px solid var(--line);
  }
</style>
