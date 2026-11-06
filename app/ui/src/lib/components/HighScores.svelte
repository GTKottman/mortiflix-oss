<!-- High scores, all time: biggest day, biggest project, biggest call, longest streak. Claude tokens. -->
<script lang="ts">
  import { compactCount, countLabel, shortDate } from '../usage/format';
  import type { UsageRecords } from '../usage/types';

  interface Props {
    records: UsageRecords;
  }

  let { records }: Props = $props();

  const call = $derived(records.biggest_call);
  const callWhere = $derived(call ? [call.model, call.stage].filter(Boolean).join(', ') : '');
  const scores = $derived([
    {
      name: 'Biggest day',
      value: records.biggest_day ? `${compactCount(records.biggest_day.claude_tokens)} tokens` : '—',
      detail: records.biggest_day ? shortDate(records.biggest_day.date) : '',
    },
    {
      name: 'Biggest project',
      value: records.biggest_project?.label ?? '—',
      detail: records.biggest_project ? `${compactCount(records.biggest_project.claude_tokens)} tokens` : '',
    },
    {
      name: 'Biggest call',
      value: call ? `${compactCount(call.claude_tokens)} tokens` : '—',
      detail: callWhere,
    },
    {
      name: 'Longest streak',
      value: countLabel(records.streak.longest, 'day'),
      detail: records.streak.current
        ? `Now ${countLabel(records.streak.current, 'day')} in a row`
        : 'Days in a row',
    },
  ]);
</script>

<section>
  <h4 class="kicker">High scores</h4>
  <dl>
    {#each scores as score (score.name)}
      <div>
        <dt>{score.name}</dt>
        <dd title={score.value}>{score.value}</dd>
        {#if score.detail}<dd class="detail">{score.detail}</dd>{/if}
      </div>
    {/each}
  </dl>
</section>

<style>
  section {
    display: grid;
    gap: var(--s-8);
  }
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--s-16);
  }
  dt {
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--t12);
  }
  dd {
    font-size: var(--t14);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    color: var(--muted);
    font-size: var(--t12);
    font-weight: 400;
  }
</style>
