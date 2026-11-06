<!-- A search box with the "/" hint. Pressing "/" anywhere on the page (outside a text field) jumps into it. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** What it searches, e.g. "Search projects". Also its accessible name. */
    label: string;
    value?: string;
    /** Escape clears the text. */
    clearOnEscape?: boolean;
    /** A button at the end of the box, after the "/" hint (Home: the round + for a new project). */
    end?: Snippet;
  }

  let { label, value = $bindable(''), clearOnEscape = false, end }: Props = $props();
  let input = $state<HTMLInputElement>();

  export function focus(): void {
    input?.focus();
  }

  function typing(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
    );
  }

  function slash(event: KeyboardEvent) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
    event.preventDefault();
    input?.focus();
  }

  function escape(event: KeyboardEvent) {
    if (clearOnEscape && event.key === 'Escape' && value) value = '';
  }
</script>

<svelte:window onkeydown={slash} />

<label class="search">
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
  <input
    bind:this={input}
    bind:value
    placeholder={label}
    aria-label={label}
    autocomplete="off"
    onkeydown={escape}
  />
  <kbd aria-hidden="true">/</kbd>
  {#if end}{@render end()}{/if}
</label>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    width: 100%;
    height: var(--h);
    padding: 0 var(--s-16);
    padding-right: var(--end-pad, var(--s-16));
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    color: var(--faint);
    transition:
      border-color 180ms var(--ease-out-quart),
      box-shadow 220ms var(--ease-out-expo),
      color 180ms ease;
  }
  .search:hover {
    border-color: var(--line-hover);
  }
  .search:focus-within {
    border-color: var(--violet);
    box-shadow: 0 0 0 3px rgba(177, 140, 255, 0.16);
    color: var(--violet);
  }
  svg {
    flex: none;
    width: var(--s-16);
    height: var(--s-16);
  }
  input {
    all: unset;
    flex: 1;
    box-shadow: none !important;
    min-width: 0;
    color: var(--text);
    text-align: var(--search-align, start);
  }
  input::placeholder {
    color: var(--faint);
  }
  /* the words go the moment the box is clicked, so typing never lands on top of them (owner 2026-11-05) */
  input:focus::placeholder {
    color: transparent;
  }
  kbd {
    flex: none;
    margin-left: auto;
    padding: var(--s-2) var(--s-4);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    color: var(--muted);
    font: 600 var(--t12) / 1 var(--mono);
  }
</style>
