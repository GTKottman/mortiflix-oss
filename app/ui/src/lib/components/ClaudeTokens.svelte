<!-- Claude's tokens: the total, then a split bar and rows for what it is made of, so a big number reads
     calmly (most of it is cache read: Claude re-reading text it has already seen). -->
<script lang="ts">
  import { fullCount, share } from '../usage/format';
  import type { ClaudeTokens } from '../usage/types';

  interface Props {
    tokens: ClaudeTokens;
  }

  let { tokens }: Props = $props();

  const parts = $derived([
    { id: 'cache-read', name: 'Cache read', value: tokens.cache_read, why: 'Re-reading text it has seen' },
    { id: 'cache-write', name: 'Cache write', value: tokens.cache_write, why: 'Keeping text to re-read' },
    { id: 'out', name: 'Out', value: tokens.output, why: 'What Claude wrote' },
    { id: 'in', name: 'In', value: tokens.input, why: 'New text Claude read' },
  ]);
  const cacheShare = $derived(share(tokens.cache_read, tokens.total));
</script>

<section>
  <h4 class="kicker">Claude</h4>
  <!-- fresh tokens first (input, output, cache writes); cache reads apart, never in the big number -->
  <p class="big">{fullCount(tokens.input + tokens.output + tokens.cache_write)} <span>fresh tokens</span></p>
  <p class="reads">+ {fullCount(tokens.cache_read)} cache reads (re-reading text already sent)</p>
  {#if tokens.total > 0}
    <div class="split" aria-hidden="true">
      {#each parts as part (part.id)}
        <span class="part {part.id}" style:--w="{share(part.value, tokens.total) * 100}%"></span>
      {/each}
    </div>
    <dl>
      {#each parts as part (part.id)}
        <div>
          <dt><span class="swatch {part.id}" aria-hidden="true"></span>{part.name}</dt>
          <dd>{fullCount(part.value)}</dd>
          <dd class="why">{part.why}</dd>
        </div>
      {/each}
    </dl>
    {#if cacheShare >= 0.5}
      <p class="note">
        {Math.round(cacheShare * 100)}% is cache read: Claude re-reading the same instructions.
      </p>
    {/if}
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: var(--s-8);
    align-content: start;
  }
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .big {
    font: 600 var(--t20) / 1.2 var(--body);
    font-variant-numeric: tabular-nums;
  }
  .big span {
    color: var(--muted);
    font-size: var(--t13);
    font-weight: 400;
  }
  .split {
    display: flex;
    gap: var(--s-2);
    height: var(--s-4);
    border-radius: var(--r-pill);
    overflow: hidden;
    background: var(--ink-4);
  }
  .part {
    width: var(--w);
  }
  .part:not([style*='--w: 0%']) {
    min-width: var(--s-2);
  }
  .cache-read {
    background: var(--faint);
  }
  .cache-write {
    background: var(--muted);
  }
  .out {
    background: var(--text);
  }
  .in {
    background: var(--link);
  }
  dl {
    display: grid;
    gap: var(--s-4);
    font-size: var(--t13);
  }
  dl div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }
  dt {
    display: flex;
    align-items: center;
    gap: var(--s-8);
  }
  dd {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .why {
    grid-column: 1 / -1;
    padding-left: var(--s-16);
    color: var(--faint);
    font-size: var(--t12);
    text-align: left;
  }
  .swatch {
    width: var(--s-8);
    height: var(--s-8);
    border-radius: var(--s-2);
  }
  .note {
    color: var(--muted);
    font-size: var(--t12);
  }
  .reads {
    margin: 0;
    color: var(--faint);
    font-size: var(--t12);
  }
</style>
