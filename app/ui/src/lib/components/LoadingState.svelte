<!-- Shows only when loading takes longer than a moment, so quick loads never flash. -->
<script lang="ts">
  interface Props {
    text?: string;
    /** Wait before showing, in ms. */
    delay?: number;
  }

  let { text = 'Loading…', delay = 300 }: Props = $props();
  let visible = $state(false);

  $effect(() => {
    const timer = setTimeout(() => (visible = true), delay);
    return () => clearTimeout(timer);
  });
</script>

<div class="loading" role="status" aria-busy="true">
  {#if visible}<span class="pulse" aria-hidden="true"></span>{text}{/if}
</div>

<style>
  .loading {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-16) 0;
    color: var(--muted);
    min-height: var(--h);
  }
  .pulse {
    width: var(--s-24);
    height: var(--s-2);
    background: var(--busy);
    animation: mfx-pulse 1.2s var(--ease) infinite;
  }
</style>
