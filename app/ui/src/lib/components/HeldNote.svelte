<!-- Why a piece is held: a check was not satisfied (a measured check after 2 fixes, with its boxes and px, or the AI
     inspection after 3 rounds). Plain words; the owner decides: OK anyway, or Fix (the check result goes with it). -->
<script lang="ts">
  interface Props {
    reasons: readonly string[] | null;
  }

  let { reasons }: Props = $props();
  const list = $derived(reasons?.length ? reasons : ['The studio could not make it pass its own checks.']);
</script>

<div class="held" role="status">
  <b>Not satisfied after the studio's own fixes:</b>
  <ul>
    {#each list as reason, index (index)}<li>{reason}</li>{/each}
  </ul>
</div>

<style>
  .held {
    display: grid;
    gap: var(--s-8);
    border-left: 3px solid var(--warn);
    padding: var(--s-4) 0 var(--s-4) var(--s-12);
  }
  b {
    font: 600 var(--t15) / 1.3 var(--body);
  }
  ul {
    padding-left: var(--s-16);
    color: var(--muted);
    font-size: var(--t14);
  }
  li {
    padding: var(--s-2) 0;
  }
</style>
