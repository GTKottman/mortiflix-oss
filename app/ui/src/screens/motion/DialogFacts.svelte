<!-- What a decision does, as term and answer rows: scope, version, time, cost. -->
<script lang="ts">
  interface Props {
    rows: readonly { term: string; detail: string }[];
  }

  let { rows }: Props = $props();
</script>

<dl>
  {#each rows as row (row.term)}
    <dt>{row.term}</dt>
    <dd>{row.detail}</dd>
  {/each}
</dl>

<style>
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--s-8) var(--s-12);
    font-size: var(--t13);
  }
  dt {
    white-space: nowrap;
    padding-top: var(--s-2);
    color: var(--faint);
    font-size: var(--t12);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
</style>
