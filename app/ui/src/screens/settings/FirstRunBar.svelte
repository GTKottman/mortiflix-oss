<!-- First run only: what is ready so far and the one way forward. Stays at the bottom while the page scrolls. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';

  interface Props {
    /** "Writing ✓ · Voice ○ · Video Notes ○", or why saving failed. */
    note: string;
    busy: boolean;
    /** The button's words: "Done, start making", or "Start anyway" after saving failed. */
    label: string;
    ondone: () => void;
  }

  let { note, busy, label, ondone }: Props = $props();
</script>

<div class="bar">
  <span class="note" role="status">{note}</span>
  <Button variant="primary" size="lg" disabled={busy} onclick={ondone}>{label}</Button>
</div>

<style>
  .bar {
    position: sticky;
    /* The page scrolls inside padding; stick past it so the bar sits on the window edge. */
    bottom: calc(var(--work-pad-y) * -1);
    z-index: 2;
    display: flex;
    gap: var(--s-16);
    align-items: center;
    justify-content: space-between;
    margin-top: var(--s-24);
    padding: var(--s-16) 0;
    border-top: 1px solid var(--line);
    background: var(--ink);
  }
  .note {
    min-width: 0;
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
