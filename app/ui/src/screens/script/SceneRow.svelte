<!-- One scene in one row: number, name, time and state; the narration with its buttons (about 60%);
     and what is on screen beside it (about 40%). The coloured bar is the scene's identity on every stage. -->
<script lang="ts">
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import FixNote from './FixNote.svelte';
  import NarrationEditor from './NarrationEditor.svelte';
  import NarrationLines from './NarrationLines.svelte';
  import OnScreenNote from './OnScreenNote.svelte';
  import SceneActions from './SceneActions.svelte';
  import SceneTime from './SceneTime.svelte';
  import { useScript } from './script.svelte';
  import { overTimeOf, stateOf } from './status';
  import StatusPill from '../../lib/components/StatusPill.svelte';
  import { pad2 } from '../../lib/time';
  import type { Beat } from './types';

  interface Props {
    beat: Beat;
    index: number;
  }

  let { beat, index }: Props = $props();
  const script = useScript();

  const SCENE_COLOURS = 6;
  const current = $derived(beat.id === script.selected);
  /** Collapsed: a one-line row, unless it is the selected scene. */
  const collapsed = $derived(script.compact && !current);
  const open = $derived(script.editing.has(beat.id));
  const state = $derived(stateOf(beat, script.drafts, script.approving[beat.id]));
  const overTime = $derived(overTimeOf(beat, script.timings[beat.id]));
  const error = $derived(script.errors[beat.id]);
</script>

<!-- A scene is a stop for the arrow keys; focusing it (by click or key) selects it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article
  class="scene"
  class:collapsed
  data-beat={beat.id}
  tabindex="0"
  aria-label={`Scene ${beat.no}: ${beat.name}`}
  aria-current={current ? 'true' : undefined}
  style:--c={`var(--scene-${(index % SCENE_COLOURS) + 1})`}
  onfocusin={() => script.select(beat.id)}
>
  <div class="main">
    <div class="head">
      <h2><span class="no">{pad2(beat.no)}</span><span class="nm">{beat.name}</span></h2>
      <div class="meta">
        <SceneTime timing={script.timings[beat.id]} />
        <StatusPill {...state} pill />
        {#if overTime}<StatusPill {...overTime} pill />{/if}
      </div>
    </div>
    {#if open}
      <NarrationEditor {beat} />
    {:else}
      <NarrationLines {beat} compact={collapsed} />
    {/if}
    {#if error}
      <ErrorState inline title={error.title} detail={error.message} onretry={() => void error.retry()} />
    {/if}
    {#if !collapsed}<SceneActions {beat} />{/if}
    {#if script.fixOpen === beat.id && !open}<FixNote target={beat.id} what={`scene ${beat.no}`} />{/if}
  </div>
  <OnScreenNote sceneNo={beat.no} visual={beat.visual} compact={collapsed} />
</article>

<style>
  .scene {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: var(--s-8) var(--s-32);
    align-items: start;
    padding: var(--s-16) var(--s-16) var(--s-16) var(--s-24);
    border-bottom: 1px solid var(--line);
    outline: none;
    scroll-margin: var(--s-16);
    cursor: default;
  }
  .scene::before {
    content: '';
    position: absolute;
    top: var(--s-16);
    bottom: var(--s-16);
    left: 0;
    width: var(--s-4);
    border-radius: var(--s-4);
    background: var(--c);
    opacity: 0.55;
  }
  .scene:hover {
    background: color-mix(in srgb, var(--ink-2) 55%, transparent);
  }
  .scene[aria-current='true'] {
    background: var(--ink-2);
  }
  .scene[aria-current='true']::before {
    opacity: 1;
  }
  .scene:focus-visible {
    outline: var(--focus);
    outline-offset: -2px;
  }
  .main {
    display: grid;
    gap: var(--s-8);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-4) var(--s-12);
    min-height: var(--h-sm);
  }
  h2 {
    display: flex;
    align-items: baseline;
    flex: 1 1 200px;
    gap: var(--s-12);
    min-width: 0;
    font: 600 var(--t16) / 1.3 var(--display);
  }
  .no {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--c);
    font: 600 var(--t13) / 1 var(--body);
    letter-spacing: 0.12em;
  }
  .nm {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-12);
  }
  .collapsed {
    row-gap: 0;
    padding-block: var(--s-8);
  }
  .collapsed::before {
    top: var(--s-8);
    bottom: var(--s-8);
  }
  .collapsed .head {
    min-height: var(--h-toggle);
  }
  @media (max-width: 1199px) {
    .scene {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-height: 800px) {
    .scene:not(.collapsed) {
      padding-block: var(--s-12);
    }
  }
</style>
