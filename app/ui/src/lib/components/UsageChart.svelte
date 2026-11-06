<!-- Claude tokens per day for the last 30 days: plain bars, today in white, the most used day named. -->
<script lang="ts">
  import { compactCount, fullCount, share, shortDate } from '../usage/format';
  import type { UsageDay } from '../usage/types';

  interface Props {
    days: readonly UsageDay[];
  }

  let { days }: Props = $props();

  const most = $derived(
    days.reduce<UsageDay | null>(
      (best, d) => (d.claude_tokens > (best?.claude_tokens ?? 0) ? d : best),
      null,
    ),
  );
  const largest = $derived(most?.claude_tokens ?? 0);
  const summary = $derived(
    most
      ? `Claude tokens per day, last ${days.length} days. Most: ${fullCount(largest)} on ${shortDate(most.date)}.`
      : `No Claude tokens in the last ${days.length} days.`,
  );
</script>

<figure class="chart">
  <figcaption class="scale">
    <span>Tokens per day</span>
    {#if most}<span>Most {compactCount(largest)} · {shortDate(most.date, { year: false })}</span>{/if}
  </figcaption>
  <div class="bars" role="img" aria-label={summary}>
    {#each days as day, i (day.date)}
      <span
        class="bar"
        class:today={i === days.length - 1}
        class:empty={day.claude_tokens === 0}
        style:--h="{share(day.claude_tokens, largest) * 100}%"
        title="{shortDate(day.date)}: {fullCount(day.claude_tokens)} tokens"
      ></span>
    {/each}
  </div>
  <div class="axis" aria-hidden="true">
    <span>{shortDate(days[0]?.date ?? '', { year: false })}</span>
    <span>Today</span>
  </div>
</figure>

<style>
  .chart {
    display: grid;
    gap: var(--s-8);
  }
  .scale,
  .axis {
    display: flex;
    justify-content: space-between;
    gap: var(--s-8);
    white-space: nowrap;
    color: var(--faint);
    font-size: var(--t12);
  }
  .bars {
    display: flex;
    align-items: flex-end;
    gap: var(--s-2);
    height: var(--chart-h);
    border-bottom: 1px solid var(--line-2);
  }
  .bar {
    flex: 1;
    height: max(var(--h), var(--s-2));
    border-radius: var(--s-2) var(--s-2) 0 0;
    background: var(--faint);
  }
  .empty {
    background: var(--line-2);
  }
  .today {
    background: var(--text);
  }
</style>
