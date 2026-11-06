<!-- One line about the whole script: spoken length against the length chosen, words, scenes, approved. -->
<script lang="ts">
  import type { Status } from './status';
  import StatusPill from '../../lib/components/StatusPill.svelte';
  import { useScript } from './script.svelte';
  import { clock } from '../../lib/time';

  const script = useScript();
  const summary = $derived(script.summary);
  const length = $derived(`${summary.estimated ? '~' : ''}${clock(summary.spoken)}`);
  const fit = $derived.by((): Status | null => {
    const verdict = summary.fit;
    if (!verdict) return null;
    if (verdict.kind === 'over') return { tone: 'fix', glyph: '!', text: `${verdict.seconds} s over` };
    if (verdict.kind === 'short') return { tone: 'wait', glyph: '○', text: `${verdict.seconds} s short` };
    return { tone: 'ok', glyph: '✓', text: 'fits' };
  });
  const spoken = $derived(`spoken${summary.estimated ? ' (est.)' : ''}`);
</script>

{#if summary.scenes > 0}
  <div class="facts" aria-live="polite">
    <span class="big">
      <b>{length}</b>{spoken}{summary.chosen === null ? '' : `, of ${clock(summary.chosen)} chosen`}
    </span>
    {#if fit}<span class="fit"><StatusPill {...fit} /></span>{/if}
    <span><b>{summary.words}</b>words</span>
    <span><b>{summary.scenes}</b>{summary.scenes === 1 ? 'scene' : 'scenes'}</span>
    <span><b>{summary.approved} of {summary.scenes}</b>approved</span>
    {#if summary.waiting > 0}
      <button class="link" type="button" onclick={() => script.goToNext()}>Go to the next one ›</button>
    {/if}
  </div>
{/if}

<style>
  .facts {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--s-4) var(--s-24);
    color: var(--muted);
    font-size: var(--t14);
  }
  .facts > span,
  .link {
    flex-shrink: 0;
    white-space: nowrap;
  }
  b {
    margin-right: var(--s-4);
    color: var(--text);
    font: 600 var(--t20) / 1 var(--display);
    font-variant-numeric: tabular-nums;
  }
  .big b {
    font-size: var(--stat-big);
  }
  .fit {
    margin-left: var(--s-8);
  }
  .link {
    all: unset;
    cursor: pointer;
    border-radius: var(--r-sm);
    color: var(--link);
    font-size: var(--t14);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .link:hover {
    filter: brightness(1.15);
  }
  .link:focus-visible {
    outline: var(--focus);
    outline-offset: var(--focus-off);
  }
</style>
