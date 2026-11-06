<!-- Why the selected line or cue needs a look: "To review: not approved yet." -->
<script lang="ts">
  interface Props {
    why: string;
  }

  let { why }: Props = $props();
</script>

<p>To review: {why}.</p>

<style>
  p {
    color: var(--warn);
    font-size: var(--t14);
  }
</style>
