<!-- One chip per shot, with its progress, so the owner moves through the film. -->
<script lang="ts">
  import { chipMark } from './sound';
  import type { SoundPlan } from './types';

  interface Props {
    plan: SoundPlan;
    shotId: string;
    /** Sounds are being made. */
    making: boolean;
    onpick: (id: string) => void;
  }

  let { plan, shotId, making, onpick }: Props = $props();
</script>

<div class="chips" role="group" aria-label="Shots">
  {#each plan.shots as shot (shot.id)}
    {@const mark = chipMark(plan, shot, making)}
    <button
      type="button"
      class="chip"
      class:on={shot.id === shotId}
      aria-pressed={shot.id === shotId}
      onclick={() => onpick(shot.id)}
    >
      {#if mark.glyph}<span class="glyph" aria-hidden="true">{mark.glyph}</span>{/if}
      Shot {shot.number}{shot.name ? ` · ${shot.name}` : ''}
      {#if mark.news}<span class="news">{mark.news}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-4);
    height: var(--btn-h);
    padding: 0 var(--btn-pad);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: transparent;
    color: var(--muted);
    font: 400 var(--t13) / 1 var(--body);
    white-space: nowrap;
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--line-hover);
    color: var(--text);
  }
  .chip.on {
    border-color: var(--text);
    background: var(--text);
    color: var(--ink);
  }
  .glyph {
    font-size: var(--t12);
  }
  .news {
    opacity: 0.8;
  }
</style>
