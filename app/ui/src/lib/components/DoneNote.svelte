<!-- Toast-free feedback: a check and what was done, in place, for a few seconds. -->
<script lang="ts">
  interface Props {
    text: string;
    /** How long it stays. 0 = until the parent removes it. */
    ms?: number;
    ondone?: () => void;
  }

  let { text, ms = 4000, ondone }: Props = $props();

  $effect(() => {
    if (!ms) return;
    const timer = setTimeout(() => ondone?.(), ms);
    return () => clearTimeout(timer);
  });
</script>

<p class="done" role="status">{text}</p>

<style>
  .done {
    color: var(--muted);
    font-size: var(--t13);
    animation: mfx-fade var(--dur-fast) var(--ease);
  }
  .done::before {
    content: '\2713\00a0\00a0';
    color: var(--good);
  }
</style>
