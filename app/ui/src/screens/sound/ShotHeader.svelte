<!-- The open shot's name and time range, with Play shot and OK shot. OK is the screen's one gradient button
     once every sound in the shot is made; before that it says why it can't be used, on screen (not only on hover). -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { clockTenths } from '../../lib/time';
  import type { OkState, PlanShot } from './types';

  interface Props {
    shot: PlanShot;
    playing: boolean;
    ok: OkState;
    /** A change is being saved: OK waits. */
    busy: boolean;
    onplay: () => void;
    onok: () => void;
  }

  let { shot, playing, ok, busy, onplay, onok }: Props = $props();
</script>

<div class="top">
  <div class="title">
    <h2>Shot {shot.number}{shot.name ? ` · ${shot.name}` : ''}</h2>
    <span class="range">{clockTenths(shot.from)} to {clockTenths(shot.to)}</span>
  </div>
  <div class="actions">
    <Button size="sm" onclick={onplay}>{playing ? '❚❚ Pause' : '▶ Play shot'}</Button>
    {#if ok.kind === 'signed'}
      <span class="signed"><span aria-hidden="true">✓</span> Shot {shot.number} OK</span>
    {:else if ok.kind === 'ready'}
      <Button size="sm" variant="primary" disabled={busy} onclick={onok}
        >OK shot {shot.number}'s sounds</Button
      >
    {:else if ok.kind === 'blocked'}
      <span class="reason">{ok.reason}</span>
      <Button size="sm" disabled title={ok.reason}>OK shot {shot.number}'s sounds</Button>
    {/if}
  </div>
</div>

<style>
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-16);
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s-12);
    min-width: 0;
  }
  h2 {
    font: 600 var(--t17) / 1.2 var(--display);
    letter-spacing: 0.01em;
    text-transform: uppercase;
  }
  .range {
    color: var(--muted);
    font: 400 var(--t13) / 1 var(--mono);
    white-space: nowrap;
  }
  .actions {
    display: flex;
    flex: 0 1 auto;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--s-8);
  }
  .reason {
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .signed {
    display: inline-flex;
    gap: var(--s-4);
    align-items: center;
    padding: 0 var(--s-8);
    color: var(--good);
    font-size: var(--t14);
    font-weight: 600;
    white-space: nowrap;
  }
</style>
