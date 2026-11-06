<!-- Something failed: what, why in plain words, and Try again when it can be retried. -->
<script lang="ts">
  import Button from './Button.svelte';

  interface Props {
    title: string;
    detail?: string;
    onretry?: () => void;
    /** A one-line version for inside rows. */
    inline?: boolean;
  }

  let { title, detail, onretry, inline = false }: Props = $props();
</script>

<div class="state" class:inline role="alert">
  <b>{title}</b>
  {#if detail}<span>{detail}</span>{/if}
  {#if onretry}<div class="actions"><Button size="sm" onclick={onretry}>Try again</Button></div>{/if}
</div>

<style>
  .state {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-16) 0;
    color: var(--muted);
    max-width: var(--reading);
  }
  .inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    padding: var(--s-8) 0;
    font-size: var(--t13);
  }
  b {
    color: var(--text);
    font: 600 var(--t16) / 1.3 var(--body);
  }
  .inline b {
    font-size: var(--t14);
    white-space: nowrap;
  }
  b::before {
    content: '! ';
    color: var(--bad);
  }
  .actions {
    display: flex;
    gap: var(--s-8);
  }
</style>
