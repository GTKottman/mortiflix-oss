<!-- The ⋯ button and its menu, for an item with more actions than fit beside it (Home's projects, Lessons,
     Look, Stills, Motion, Sound, Finish). The items go in either as children (`Button item role="menuitem"`,
     `<hr>` between groups) or as an `actions` list. An action that can't run now stays in the list, greyed, with
     its reason as the tooltip; an action may answer a short sentence ("Path copied."), shown next to ⋯ for a
     few seconds. The menu opens above the ⋯ when there is no room under it. Arrow keys, Home and End move; Esc
     closes and returns to ⋯; Tab or a click outside closes. -->
<script lang="ts" module>
  export interface MenuAction {
    label: string;
    /** May answer a short sentence ("Path copied."), shown next to the button for a few seconds. */
    run: () => unknown;
    /** Why it can't run now; the action shows greyed with this as its tooltip. */
    why?: string;
    danger?: boolean;
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import Button from './Button.svelte';

  interface Props {
    /** "More for How bees make honey": what the ⋯ is for, read by screen readers. */
    label: string;
    open?: boolean;
    /** The items as a list (instead of children). */
    actions?: readonly MenuAction[];
    /** The items; `close(true)` closes and puts the focus back on ⋯. */
    children?: Snippet<[close: (refocus: boolean) => void]>;
  }

  let { label, open = $bindable(false), actions, children }: Props = $props();
  const id = $props.id();

  const SAID_MS = 4000;
  let said = $state('');
  let saidTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(saidTimer));

  async function pick(action: MenuAction) {
    if (action.why) return;
    close(true);
    let answer: unknown;
    try {
      answer = await action.run();
    } catch (error) {
      // A failing action must say so in the same place a success speaks, not vanish as an unhandled rejection.
      answer = `Did not work: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    clearTimeout(saidTimer);
    said = typeof answer === 'string' ? answer : '';
    if (said) saidTimer = setTimeout(() => (said = ''), SAID_MS);
  }

  let root = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();
  let list = $state<HTMLElement>();
  let up = $state(false);

  const items = (): HTMLElement[] =>
    list ? [...list.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')] : [];

  /** Puts the focus on the first item, e.g. after the menu swapped its items for a question. */
  export async function focusFirst(): Promise<void> {
    await tick();
    items()[0]?.focus();
  }

  async function show() {
    open = true;
    up = false;
    await tick();
    const box = list?.getBoundingClientRect();
    const button = trigger?.getBoundingClientRect();
    up = Boolean(box && button && box.bottom > window.innerHeight && button.top - box.height > 0);
    items()[0]?.focus();
  }

  function close(refocus: boolean) {
    open = false;
    if (refocus) trigger?.focus();
  }

  const STEP: Record<string, (at: number, count: number) => number> = {
    ArrowDown: (at, count) => (at + 1) % count,
    ArrowUp: (at, count) => (at - 1 + count) % count,
    Home: () => 0,
    End: (_at, count) => count - 1,
  };

  function onkeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    const step = STEP[event.key];
    const all = items();
    if (!step || !all.length) return;
    event.preventDefault();
    all[step(all.indexOf(document.activeElement as HTMLElement), all.length)]?.focus();
  }

  function onpointerdown(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) close(false);
  }
</script>

<svelte:window {onpointerdown} />

<div class="more" bind:this={root} role="presentation" {onkeydown}>
  {#if actions}<span class="said" role="status">{said}</span>{/if}
  <button
    bind:this={trigger}
    type="button"
    class="dots"
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? `${id}-menu` : undefined}
    onclick={() => (open ? close(false) : void show())}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  </button>
  {#if open}
    <div
      bind:this={list}
      id="{id}-menu"
      class="menu"
      class:up
      class:fit={actions}
      role="menu"
      aria-label={label}
    >
      {#if actions}
        {#each actions as action (action.label)}
          <Button
            item
            variant={action.danger ? 'danger' : 'secondary'}
            role="menuitem"
            aria-disabled={action.why ? 'true' : undefined}
            title={action.why}
            onclick={() => void pick(action)}>{action.label}</Button
          >
        {/each}
      {:else}
        {@render children?.(close)}
      {/if}
    </div>
  {/if}
</div>

<style>
  .more {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--s-8);
  }
  .said {
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .said:empty {
    display: none;
  }
  .dots {
    display: grid;
    place-items: center;
    width: var(--h-sm);
    height: var(--h-sm);
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
    transition:
      border-color 160ms ease,
      color 150ms ease;
  }
  .dots:hover,
  .dots[aria-expanded='true'] {
    border-color: var(--line-2);
    color: var(--text);
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--s-4));
    right: 0;
    z-index: var(--z-menu);
    display: grid;
    width: var(--more-menu-w);
    padding: 6px;
    border: 1px solid var(--line-2);
    border-radius: var(--r-lg);
    background: var(--ink-3);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .menu.fit {
    width: max-content;
    min-width: var(--more-menu-w);
  }
  .menu :global([aria-disabled='true']) {
    color: var(--faint);
    cursor: not-allowed;
  }
  .menu.up {
    top: auto;
    bottom: calc(100% + var(--s-4));
  }
  .menu :global(hr) {
    margin: var(--s-4) 0;
    border: 0;
    border-top: 1px solid var(--line);
  }
</style>
