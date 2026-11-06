<!-- The open shot's sounds: the list, and the open sound's details beside it (under its row when the window is narrow). -->
<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import { fileUrl } from '../../lib/files';
  import { clockTenths } from '../../lib/time';
  import type { ShotPlayback } from './playback.svelte';
  import SelectedSound from './SelectedSound.svelte';
  import type { SoundState } from './sound-state.svelte';
  import SoundTable from './SoundTable.svelte';
  import type { Cue, PlanShot } from './types';

  interface Props {
    sound: SoundState;
    shot: PlanShot;
    playback: ShotPlayback;
    /** All the sounds the film has, for "3 of 12 sounds". */
    total: number;
    /** The open sound's Change panel is open. */
    changeOpen: boolean;
  }

  let { sound, shot, playback, total, changeOpen = $bindable() }: Props = $props();

  /** Under 1600 the open sound's detail sits under its row instead of in its own column. */
  const narrow = new MediaQuery('max-width: 1599px');
  const cues = $derived(sound.cues);
  const cue = $derived(sound.cue);
</script>

<div class="split">
  <section class="list" aria-labelledby="list-h">
    <div class="section-head">
      <h2 id="list-h">Sound effects · shot {shot.number}</h2>
      <span>{cues.length} of {total} sounds</span>
    </div>
    {#if cues.length}
      <SoundTable
        {cues}
        selectedId={cue?.id}
        making={Boolean(sound.making)}
        onpick={(picked) => sound.selectCue(picked.id)}
        detail={narrow.current ? detail : undefined}
      ></SoundTable>
    {:else}
      <p class="nosound">No sounds in shot {shot.number}. Nothing moves that needs one.</p>
    {/if}
  </section>
  {#if !narrow.current && cue}
    <section aria-labelledby="selected-h">
      <div class="section-head">
        <h2 id="selected-h">Selected sound</h2>
        <span>{clockTenths(cue.at_sec)}</span>
      </div>
      {@render selected(cue, false)}
    </section>
  {/if}
</div>

{#snippet detail(open: Cue)}
  {@render selected(open, true)}
{/snippet}
{#snippet selected(open: Cue, inline: boolean)}
  <SelectedSound
    cue={open}
    making={Boolean(sound.making)}
    busy={Boolean(sound.busy)}
    {inline}
    bind:changeOpen
    onplay={() => open.file && playback.playOne(fileUrl(open.file))}
    onsignoff={() => void sound.signOff(open)}
    oncut={() => void sound.cut(open, true)}
    onrestore={() => void sound.cut(open, false)}
    onchange={(change) => sound.change(open, change)}
  />
{/snippet}

<style>
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--sound-detail-w);
    gap: var(--s-32);
    align-items: start;
  }
  .list {
    min-width: 0;
  }
  section > .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-12);
    padding-bottom: var(--s-8);
  }
  h2 {
    min-width: 0;
    color: var(--faint);
    font: 600 var(--t12) / 1.2 var(--body);
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .section-head span {
    flex-shrink: 0;
    color: var(--muted);
    white-space: nowrap;
    font-size: var(--t13);
  }
  .nosound {
    padding: var(--s-24) 0;
    border-top: 1px solid var(--line);
    color: var(--muted);
  }
  @media (max-width: 1599px) {
    .split {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
