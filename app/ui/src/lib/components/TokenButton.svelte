<!-- The token counter (owner 2026-11-02): "a little button that looks like a token, and you click it, and
     there's just a hovering drop down that shows you what's going on." A coin with today's Claude tokens;
     click opens the usage dropdown under the bar (the bar is its anchor). Esc or a click outside closes it. -->
<script lang="ts">
  import { useProject, useUsage } from '../stores/context';
  import { compactCount, fullCount } from '../usage/format';
  import UsagePanel from './UsagePanel.svelte';
  import TokenRuns from '../usage/TokenRuns.svelte';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  const usage = useUsage();
  const project = useProject();
  const id = $props.id();
  let root = $state<HTMLElement>();
  let coin = $state<HTMLButtonElement>();

  // Today, every project. The coin shows the fresh tokens (input, output, cache writes); cache reads are re-reads of
  // context already sent, often 90% of the lump, so they are named apart and never added in (2026-11-02: the coin
  // showed 123M, three directors' sessions, 112M of it cache reads).
  const claude = $derived(usage.today ? usage.today.totals.claude : null);
  const today = $derived(claude ? claude.input + claude.output + claude.cache_write : null);
  const label = $derived(
    !claude || today === null
      ? usage.todayError
        ? `Usage: ${usage.todayError}`
        : 'Usage'
      : `Today, all projects: ${fullCount(today)} fresh Claude tokens (input ${fullCount(claude.input)}, output ${fullCount(claude.output)}, cache writes ${fullCount(claude.cache_write)}) and ${fullCount(claude.cache_read)} cache reads, not added in`,
  );
  // "This project" numbers belong to one project: after the tab moves to another one they are not shown, and are
  // read again for the new one.
  const visible = $derived(
    usage.shown && (usage.shown.range !== 'project' || usage.shown.project === project.id) ? usage.shown : null,
  );
  const nothingToRead = $derived(usage.range === 'project' && project.id === null);

  let menu = $state<HTMLElement>();

  $effect(() => {
    if (open) menu?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });

  $effect(() => {
    if (open && !visible && !nothingToRead && !usage.loading && !usage.error) void usage.show(usage.range);
  });

  function close({ refocus }: { refocus: boolean }) {
    open = false;
    if (refocus) coin?.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      close({ refocus: true });
    }
  }

  function onpointerdown(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) close({ refocus: false });
  }
</script>

<svelte:window {onkeydown} {onpointerdown} />

<div class="token" bind:this={root}>
  <button
    bind:this={coin}
    type="button"
    class="coin"
    aria-label={label}
    title={label}
    aria-expanded={open}
    aria-controls="{id}-menu"
    onclick={() => (open = !open)}
  >
    <span class="face">{today === null ? '–' : compactCount(today)}</span>
  </button>
  {#if open}
    <div bind:this={menu} id="{id}-menu" class="menu" role="dialog" aria-label="Usage">
      <UsagePanel
        usage={visible}
        source="service"
        range={usage.range}
        loading={usage.loading}
        error={usage.error}
        hasProject={project.id !== null}
        onrange={(range) => usage.show(range)}
        onretry={() => usage.show(usage.range)}
      />
      <!-- the open project's Claude runs, what used the tokens and what was re-read (the old app's Token Tracker) -->
      <TokenRuns project={project.id} />
    </div>
  {/if}
</div>

<style>
  .token {
    flex: none;
  }
  .coin {
    display: grid;
    place-items: center;
    width: var(--h);
    height: var(--h);
    padding: var(--s-2);
    border: 0;
    border-radius: 50%;
    background: conic-gradient(from var(--angle), var(--violet), var(--pink), var(--cyan), var(--violet));
    cursor: pointer;
    animation: turn-grad 7s linear infinite;
    transition:
      transform 240ms var(--ease-spring),
      box-shadow 240ms var(--ease-out-quart);
  }
  .coin:hover,
  .coin[aria-expanded='true'] {
    transform: scale(1.08);
    box-shadow: 0 0 16px rgba(177, 140, 255, 0.45);
  }
  .coin:active {
    transform: scale(0.94);
  }
  .face {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: var(--ink);
    color: var(--text);
    font: 600 10.5px / 1 var(--mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--s-8));
    right: var(--bar-pad-x);
    z-index: var(--z-menu);
    width: var(--menu-w);
    max-height: calc(100dvh - var(--bar-h) - var(--s-16));
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--line-2);
    border-radius: var(--r-lg);
    background: var(--ink-3);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
</style>
