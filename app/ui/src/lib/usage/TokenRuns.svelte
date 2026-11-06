<!-- Token usage (the old app's Token Tracker, crates/mortiflix-ui/src/tokens.rs; owner 2026-10-18): every Claude run
     of the open project as a row, newest on top. Pick one: its calls as bars by what they did, sorted by raw tokens,
     each split into input, cache and output (so a cheap, cache-heavy step never looks like the most expensive one),
     with why it ran (Claude's own words) and what it did. Under the bars, what was pulled into the context and how
     many later calls re-read it: the place to look when token-optimizing a pipeline. A run can use several models:
     each run and bar says which, and a run's detail splits its tokens by model.
     Reads again only while it is on screen: every 5 s while a run is going, else every minute.
     Owner 2026-11-02: no money anywhere, so the old app's list price is not shown. -->
<script lang="ts">
  import EmptyState from '../components/EmptyState.svelte';
  import ErrorState from '../components/ErrorState.svelte';
  import LoadingState from '../components/LoadingState.svelte';
  import { useService } from '../stores/context';
  import { compactCount, share } from './format';
  import {
    modelsLine,
    readDetail,
    readRuns,
    splitText,
    voiceLines,
    when,
    type Pulled,
    type RunDetail,
    type TokenRun,
    type VoiceUse,
  } from './runs';

  interface Props {
    /** The open project, or null. */
    project: string | null;
  }

  let { project }: Props = $props();
  const client = useService();

  /** While a run is going. */
  const POLL_RUNNING = 5_000;
  /** Nothing running: a finished run doesn't change. */
  const POLL_IDLE = 60_000;

  let runs = $state<TokenRun[]>([]);
  let voice = $state<VoiceUse[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let selected = $state<string | null>(null);
  let detail = $state<RunDetail | null>(null);
  let openBar = $state<string | null>(null);
  let retries = $state(0);

  const biggestRun = $derived(Math.max(0, ...runs.map((r) => r.total)));
  const selectedRunning = $derived(runs.some((r) => r.id === selected && r.running));

  const LEGEND = [
    { id: 'in', name: 'Input' },
    { id: 'cache', name: 'Cache' },
    { id: 'out', name: 'Output' },
  ];
  const LEGEND_WHY =
    "Raw tokens. Input: new to Claude on that call. Cache: the context written to or re-read from Claude's cache (cheap to re-read, but it adds up on every call). Output: what Claude wrote.";

  /** The three parts of a bar, as shares of `largest`. */
  const parts = (u: { input: number; cache_write: number; cache_read: number; output: number }, largest: number) => [
    { id: 'in', w: share(u.input, largest) },
    { id: 'cache', w: share(u.cache_write + u.cache_read, largest) },
    { id: 'out', w: share(u.output, largest) },
  ];

  const runTitle = (run: TokenRun): string =>
    [
      when(run.started),
      `${run.model || 'Claude'} · ${run.backend}`,
      splitText(run),
      ...(run.models.length > 1 ? run.models.map((m) => `${m.model} (${m.calls} calls): ${splitText(m)}`) : []),
    ].join('\n');

  const runLine = (run: TokenRun): string => {
    const models = run.models.length > 1 ? `${modelsLine(run.models)} · ` : '';
    return `${models}${run.calls} calls${run.why ? ` · ${run.why}` : ''}`;
  };

  // The runs: read when the project changes, then again every 5 s while a run is going, else every minute. The
  // newest run is shown until another is picked. svelte.dev $effect: the teardown runs before the effect re-runs
  // and when the component goes, so the old project's timer never lands on the new one.
  $effect(() => {
    const id = project;
    void retries;
    runs = [];
    voice = [];
    loaded = false;
    error = null;
    selected = null;
    detail = null;
    openBar = null;
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const answer = readRuns(await client.call('tokens.runs', { project: id }));
        if (stopped) return;
        runs = answer.runs;
        voice = answer.voice;
        loaded = true;
        error = null;
        if (!selected || !runs.some((r) => r.id === selected)) {
          selected = runs[0]?.id ?? null;
          detail = null;
        }
      } catch (e) {
        if (stopped) return;
        error = (e instanceof Error && e.message ? e.message : "The studio didn't answer.").slice(0, 300);
      }
      if (!stopped) timer = setTimeout(tick, runs.some((r) => r.running) ? POLL_RUNNING : POLL_IDLE);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  // The picked run: read when picked, and every 5 s while it is still going (once more when it ends).
  $effect(() => {
    const id = project;
    const run = selected;
    const live = selectedRunning;
    if (!id || !run) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const answer = readDetail(await client.call('tokens.run', { project: id, run }));
        if (!stopped && answer.run.id === run) detail = answer;
      } catch {
        // the row stays as it was; the next read tries again
      }
      if (!stopped && live) timer = setTimeout(tick, POLL_RUNNING);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  const pulledTitle = (p: Pulled): string =>
    `${p.label}${p.from ? `\nFrom: ${p.from}` : ''}\n${compactCount(p.tokens)} tokens, re-read by ${p.calls_after} later calls: ${compactCount(p.carried)} tokens in all (${p.group})`;

  function pick(id: string) {
    if (selected === id) return;
    selected = id;
    detail = null;
    openBar = null;
  }
</script>

<section class="viewer" aria-label="Token usage">
  <h4 class="kicker">Token usage</h4>

  {#if project && !error}
    {#each voice as v, i (i)}
      {@const line = voiceLines(v)}
      <div class="voice">
        <p>{line.name}</p>
        <p class="small">{line.amount}</p>
        <p class="small dim">{line.how}</p>
      </div>
    {/each}
  {/if}

  <p class="legend" title={LEGEND_WHY}>
    {#each LEGEND as part (part.id)}
      <span><span class="swatch {part.id}" aria-hidden="true"></span>{part.name}</span>
    {/each}
  </p>

  {#if !project}
    <EmptyState title="No project open" body="Open a project to see what its Claude runs used." />
  {:else if error}
    <ErrorState title="Could not read the runs" detail={error} onretry={() => retries++} />
  {:else if !loaded}
    <LoadingState text="Reading the runs…" />
  {:else if !runs.length}
    <EmptyState title="No Claude runs yet" body="Each run shows here as it starts." />
  {:else}
    <ul class="runs">
      {#each runs as run (run.id)}
        <li>
          <button
            type="button"
            class="row"
            class:cur={run.id === selected}
            aria-current={run.id === selected ? 'true' : undefined}
            title={runTitle(run)}
            onclick={() => pick(run.id)}
          >
            <span class="head">
              <span class:live={run.running}>{when(run.started)}{run.running ? ' · running' : ''}</span>
              <span class="num">{compactCount(run.total)}</span>
            </span>
            <span class="split" aria-hidden="true">
              {#each parts(run, biggestRun) as part (part.id)}
                <span class="part {part.id}" style:--w="{part.w * 100}%"></span>
              {/each}
            </span>
            <span class="line">{runLine(run)}</span>
          </button>
        </li>
      {/each}
    </ul>

    {#if !detail}
      <LoadingState text="Reading the run…" />
    {:else}
      {@const r = detail.run}
      {@const biggestBar = detail.bars[0]?.total ?? 0}
      {@const mostCarried = Math.max(1, detail.pulled[0]?.carried ?? 0)}
      <div class="detail">
        <p class="strong">{when(r.started)} · {r.calls} calls · {compactCount(r.total)}</p>
        <p class="small dim">{splitText(r)}</p>

        {#if r.models.length}
          <h4 class="kicker">By model</h4>
          <ul class="list">
            {#each r.models as m (m.model)}
              <li class="item" title={`${m.model} · ${m.calls} calls\n${splitText(m)}`}>
                <span class="name">{m.model} · {m.calls}×</span>
                <span class="num dim">{compactCount(m.total)}</span>
                <span class="split" aria-hidden="true">
                  {#each parts(m, r.models[0]?.total ?? 0) as part (part.id)}
                    <span class="part {part.id}" style:--w="{part.w * 100}%"></span>
                  {/each}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        <h4 class="kicker">What used the tokens</h4>
        <ul class="list">
          {#each detail.bars as b (b.key)}
            {@const open = openBar === b.key}
            <li>
              <button
                type="button"
                class="bar"
                aria-expanded={open}
                title={splitText(b)}
                onclick={() => (openBar = open ? null : b.key)}
              >
                <span class="chevron" aria-hidden="true">›</span>
                <span class="name">{b.key}</span>
                <span class="num dim"
                  >{compactCount(b.total)} · {b.calls}×{b.models.length ? ` · ${b.models.join(', ')}` : ''}</span
                >
                <span class="split" aria-hidden="true">
                  {#each parts(b, biggestBar) as part (part.id)}
                    <span class="part {part.id}" style:--w="{part.w * 100}%"></span>
                  {/each}
                </span>
              </button>
              {#if open}
                <div class="open">
                  {#if b.why}
                    <p class="small faint">Why (Claude's words)</p>
                    <p class="dim">{b.why}</p>
                  {/if}
                  {#if b.examples.length}
                    <p class="small faint">What it did</p>
                    {#each b.examples as e, i (i)}
                      <p class="dim name" title={e.label}>{e.label}{e.times > 1 ? `  ×${e.times}` : ''}</p>
                    {/each}
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>

        {#if detail.pulled.length}
          <h4
            class="kicker"
            title="Each thing read into Claude's context stays there: every later call re-reads it from the cache. Big, early reads cost the most."
          >
            Pulled into the context
          </h4>
          <ul class="list">
            {#each detail.pulled as p, i (i)}
              <li class="item" title={pulledTitle(p)}>
                <span class="name">{p.label}</span>
                <span class="num dim">{compactCount(p.tokens)} × {p.calls_after}</span>
                <span class="track" aria-hidden="true"
                  ><span class="fill" style:--w="{share(p.carried, mostCarried) * 100}%"></span></span
                >
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  /* the same parts as UsagePanel, ClaudeTokens, UsageBreakdown, Accordion and FrameCheckGrid: no new look */
  .viewer {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-16);
    border-top: 1px solid var(--line);
  }
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .detail .kicker {
    margin-top: var(--s-16);
  }
  p {
    margin: 0;
    font-size: var(--t13);
  }
  .small {
    font-size: var(--t12);
  }
  .dim {
    color: var(--muted);
  }
  .faint {
    color: var(--faint);
  }
  .strong {
    font-weight: 600;
  }
  .voice {
    display: grid;
    gap: var(--s-2);
  }
  .legend {
    display: flex;
    gap: var(--s-16);
    color: var(--muted);
    font-size: var(--t12);
  }
  .legend > span {
    display: flex;
    align-items: center;
    gap: var(--s-8);
  }
  .swatch {
    width: var(--s-8);
    height: var(--s-8);
    border-radius: var(--s-2);
  }
  ul {
    list-style: none;
  }
  .runs {
    max-height: calc(var(--h-lg) * 6);
    overflow: auto;
    overscroll-behavior: contain;
  }
  .row {
    display: grid;
    gap: var(--s-4);
    width: 100%;
    min-height: 48px;
    padding: var(--s-8) 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    border-radius: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--t13);
    text-align: left;
    cursor: pointer;
  }
  .cur {
    box-shadow: inset 3px 0 0 var(--text);
    padding-left: var(--s-8);
  }
  .head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--s-8);
  }
  .live {
    color: var(--good);
  }
  .line,
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line {
    color: var(--muted);
    font-size: var(--t12);
  }
  .num {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .split {
    grid-column: 1 / -1;
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
  .in {
    background: var(--link);
  }
  .cache {
    background: var(--faint);
  }
  .out {
    background: var(--text);
  }
  .detail {
    display: grid;
    gap: var(--s-8);
  }
  .list {
    display: grid;
    gap: var(--s-8);
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--s-2) var(--s-8);
    font-size: var(--t13);
  }
  .bar {
    display: grid;
    grid-template-columns: var(--s-12) minmax(0, 1fr) auto;
    gap: var(--s-2) var(--s-8);
    align-items: center;
    width: 100%;
    min-height: var(--hit);
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--t13);
    text-align: left;
    cursor: pointer;
  }
  .chevron {
    color: var(--faint);
    transition: transform var(--dur-fast) var(--ease);
  }
  [aria-expanded='true'] .chevron {
    transform: rotate(90deg);
  }
  .open {
    display: grid;
    gap: var(--s-4);
    padding: var(--s-4) 0 var(--s-8) var(--s-24);
  }
  .track {
    grid-column: 1 / -1;
    height: var(--s-2);
    background: var(--ink-4);
  }
  .fill {
    display: block;
    width: var(--w);
    height: 100%;
    background: var(--muted);
  }
</style>
