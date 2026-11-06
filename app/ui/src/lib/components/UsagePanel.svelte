<!-- What the token coin opens: Claude tokens and ElevenLabs credits for a time range, the last 30 days,
     by stage, by model, high scores. Owner 2026-11-02: no money anywhere, tokens and credits only. -->
<script lang="ts">
  import { fullCount, share, shortDate } from '../usage/format';
  import ClaudeTokens from './ClaudeTokens.svelte';
  import type { Usage, UsageRange, UsageSource } from '../usage/types';
  import EmptyState from './EmptyState.svelte';
  import ErrorState from './ErrorState.svelte';
  import HighScores from './HighScores.svelte';
  import LoadingState from './LoadingState.svelte';
  import Tabs, { tabId, type TabItem } from './Tabs.svelte';
  import UsageBreakdown from './UsageBreakdown.svelte';
  import UsageChart from './UsageChart.svelte';

  interface Props {
    usage: Usage | null;
    source: UsageSource;
    range: UsageRange;
    loading?: boolean;
    error?: string | null;
    /** A project is open, so "This project" has something to show. */
    hasProject: boolean;
    onrange: (range: UsageRange) => void;
    onretry: () => void;
  }

  let { usage, source, range, loading = false, error = null, hasProject, onrange, onretry }: Props = $props();

  /** "no key is saved" -> "No key is saved." */
  const sentence = (words: string): string =>
    words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}${/[.!?]$/.test(words) ? '' : '.'}` : '';

  const RANGES: readonly TabItem<UsageRange>[] = [
    { id: 'today', label: 'Today' },
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
    { id: 'all', label: 'All time' },
    { id: 'project', label: 'This project' },
  ];
  const GROUP = 'usage-range';

  const claude = $derived(usage?.totals.claude);
  const balance = $derived(usage?.elevenlabs ?? null);
  const whyNoBalance = $derived(sentence(usage?.elevenlabs_why ?? ''));
  const showData = $derived(usage && usage.range === range && !(range === 'project' && !hasProject));
</script>

<div class="panel">
  <Tabs items={RANGES} value={range} label="Time range" group={GROUP} onchange={onrange} />

  <div class="body" role="tabpanel" id="{GROUP}-panel" aria-labelledby={tabId(GROUP, range)}>
    {#if source === 'sample'}
      <p class="sample">Sample numbers: the real count starts when the service has the usage counter.</p>
    {/if}

    {#if range === 'project' && !hasProject}
      <EmptyState title="No project open" body="Open a project to see what it has used." />
    {:else if error}
      <ErrorState title="Could not load the numbers" detail={error} {onretry} />
    {:else if showData && usage && claude}
      <div class="totals">
        <ClaudeTokens tokens={claude} />
        <section>
          <h4 class="kicker">ElevenLabs</h4>
          <p class="big">{fullCount(usage.totals.elevenlabs.credits)} <span>credits used</span></p>
          {#if balance}
            <div
              class="meter"
              role="meter"
              aria-label="ElevenLabs credits left"
              aria-valuemin={0}
              aria-valuemax={balance.limit}
              aria-valuenow={balance.remaining}
            >
              <span style:--w="{share(balance.remaining, balance.limit) * 100}%"></span>
            </div>
            <p class="left">
              {fullCount(balance.remaining)} of {fullCount(balance.limit)} left{balance.stale
                ? ' (last known)'
                : ''}
            </p>
            {#if balance.resets_at}<p class="left">Resets {shortDate(balance.resets_at)}</p>{/if}
          {:else}
            <p class="left">Credits left: unknown. {whyNoBalance}</p>
          {/if}
        </section>
      </div>

      <!-- the big Claude number above is fresh tokens; everything below counts cache reads too (owner: they must
           see token use, so the two numbers are never left to look like one) -->
      <p class="left">The chart, By stage, By model and High scores count every token, cache reads included.</p>

      <UsageChart days={usage.series} />

      <div class="split">
        <UsageBreakdown title="By stage" rows={usage.by_stage} />
        <UsageBreakdown title="By model" rows={usage.by_model} />
      </div>

      <HighScores records={usage.records} />
    {:else if loading}
      <LoadingState text="Counting…" />
    {:else}
      <EmptyState title="No numbers yet" body="Nothing has been counted for this range yet." />
    {/if}
  </div>
</div>

<style>
  .panel {
    display: grid;
    gap: var(--s-16);
    padding: var(--s-16);
  }
  .body {
    display: grid;
    gap: var(--s-24);
  }
  .sample {
    color: var(--warn);
    font-size: var(--t13);
  }
  .sample::before {
    content: '! ';
  }
  .totals,
  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-24);
  }
  .totals section {
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
  .meter {
    height: var(--s-4);
    border-radius: var(--r-pill);
    background: var(--ink-4);
    overflow: hidden;
  }
  .meter span {
    display: block;
    width: var(--w);
    height: 100%;
    background: var(--text);
  }
  .left {
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
