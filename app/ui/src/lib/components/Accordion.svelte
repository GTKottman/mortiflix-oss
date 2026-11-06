<!-- A section that collapses. Closed, it still says what is inside (summary). It pushes the page, never covers it,
     and can remember being open (storageKey). -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** Shown in the header, e.g. "3 settings changed". */
    summary?: string;
    open?: boolean;
    /** Remembers open/closed across visits under this key. */
    storageKey?: string;
    children: Snippet;
  }

  let { title, summary, open = $bindable(false), storageKey, children }: Props = $props();
  const id = $props.id();

  // Storage can be blocked (private windows, site settings): MDN says localStorage access may throw a SecurityError.
  // Then the accordion simply does not remember, instead of failing to set up.
  $effect.pre(() => {
    let saved: string | null = null;
    try {
      saved = storageKey ? localStorage.getItem(storageKey) : null;
    } catch {
      saved = null;
    }
    if (saved) open = saved === 'open';
  });

  function toggle() {
    open = !open;
    try {
      if (storageKey) localStorage.setItem(storageKey, open ? 'open' : 'closed');
    } catch {
      // not remembered; the accordion still opens and closes
    }
  }
</script>

<section class="accordion">
  <h3>
    <button type="button" class="head" aria-expanded={open} aria-controls="{id}-body" onclick={toggle}>
      <span class="chevron" aria-hidden="true">›</span>
      <span class="title">{title}</span>
      {#if summary}<span class="summary">{summary}</span>{/if}
    </button>
  </h3>
  <div id="{id}-body" class="body" hidden={!open}>{@render children()}</div>
</section>

<style>
  .accordion {
    border-bottom: 1px solid var(--line);
  }
  h3 {
    font: inherit;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s-12);
    width: 100%;
    min-height: var(--hit);
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font: 600 var(--t13) / 1.3 var(--body);
    text-align: left;
    cursor: pointer;
  }
  .chevron {
    width: var(--s-12);
    color: var(--faint);
    transition: transform 240ms var(--ease-spring);
  }
  [aria-expanded='true'] .chevron {
    transform: rotate(90deg);
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .summary {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--muted);
    font-weight: 400;
    font-size: var(--t13);
  }
  .body {
    padding: 0 0 var(--s-16) var(--s-24);
  }
</style>
