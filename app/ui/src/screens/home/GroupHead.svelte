<!-- The title over a group, centered like the screen's own: "DONE / DRAFTS : 2" (owner's drawing, 2026-11-05). -->
<script lang="ts">
  interface Props {
    kicker: string;
    count: number;
  }

  let { kicker, count }: Props = $props();
</script>

<h2>{kicker} : {count}</h2>

<style>
  h2 {
    padding: var(--s-12) 0 var(--s-32);
    font: 600 var(--t-display) / 1.1 var(--display);
    letter-spacing: -0.02em;
    text-align: center;
    text-transform: uppercase;
  }
</style>
