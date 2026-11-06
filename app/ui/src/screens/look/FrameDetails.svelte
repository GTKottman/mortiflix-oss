<!-- Details for this frame: what the packs offered, which packs, and the tokens each round used. Closed by default. -->
<script lang="ts">
  import { assetWords } from '../../lib/review/logic';
  import { plural } from '../../lib/words';
  import type { FrameEntry, PoolInfo, RoundUsage } from '../../lib/review/types';

  interface Props {
    frame: FrameEntry | undefined;
    pool: PoolInfo | null;
    usage: readonly RoundUsage[];
  }

  let { frame, pool, usage }: Props = $props();

  const offered = $derived(assetWords(frame?.pool_assets ?? []));
  const number = (value: number | undefined): string => (value ?? 0).toLocaleString();
</script>

<details>
  <summary>Details for this frame</summary>
  <p>{offered.length ? `Offered from the packs: ${offered.join(', ')}.` : 'No pack assets were offered.'}</p>
  {#if pool?.packs}
    <p>
      Style pack: {pool.packs.style || 'none'}{pool.packs.assets?.length
        ? ` · Asset packs: ${pool.packs.assets.join(', ')}`
        : ''}.
    </p>
  {/if}
  {#if usage.length}
    <ul>
      <!-- a round and its remakes share a number (round 1, then round 1 remade): keyed by place, never by number -->
      {#each usage as round, index (index)}
        <li>
          Round {round.round}{round.kind === 'fix' ? ' (remake)' : ''}: {plural(round.calls, 'call')}{round.fixes
            ? `, ${plural(round.fixes, 'fix')}`
            : ''} · {number(round.input_tokens)} in · {number(round.output_tokens)} out · {number(
            round.cache_read_input_tokens,
          )} from cache
        </li>
      {/each}
    </ul>
  {/if}
</details>

<style>
  details {
    color: var(--muted);
    font-size: var(--t13);
  }
  summary {
    cursor: pointer;
    white-space: nowrap;
    padding: var(--s-4) 0;
  }
  p,
  ul {
    margin-top: var(--s-4);
  }
  ul {
    padding-left: var(--s-16);
  }
</style>
