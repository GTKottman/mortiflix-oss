<!-- Every scene: OK ones collapsed to a row, the current one marked, later ones name only and say what they wait for. -->
<script lang="ts">
  import ReviewSection from '../../lib/components/ReviewSection.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import type { StillGroup } from '../../lib/review/types';
  import { sceneOkCount, sceneTag } from './stills';

  interface Props {
    groups: readonly StillGroup[];
    /** The scene on view. */
    current: string;
    onselect: (scene: StillGroup) => void;
  }

  let { groups, current, onselect }: Props = $props();
</script>

<ReviewSection title="Scenes">
  {#snippet aside()}<span class="nowrap">{sceneOkCount(groups)} of {groups.length} OK</span>{/snippet}
  <ul class="rows" aria-label="Scenes">
    {#each groups as group (group.beat)}
      {@const tag = sceneTag(group)}
      {#snippet cells()}
        <span class="n">{group.index}</span>
        <span class="nm">{group.name || `Scene ${group.index}`}</span>
        <StatusMark mark={tag.look} glyph={tag.glyph} text={tag.text} />
      {/snippet}
      <li>
        {#if group.state !== 'waiting'}
          <button
            class="row open"
            class:cur={group.beat === current}
            type="button"
            aria-current={group.beat === current ? 'true' : undefined}
            onclick={() => onselect(group)}
          >
            {@render cells()}
          </button>
        {:else}
          <div class="row wait" class:cur={group.beat === current}>{@render cells()}</div>
        {/if}
      </li>
    {/each}
  </ul>
</ReviewSection>

<style>
  .rows {
    display: grid;
    list-style: none;
  }
  .row {
    display: grid;
    grid-template-columns: 28px 1fr auto;
    gap: var(--s-12);
    align-items: center;
    width: 100%;
    min-height: 40px;
    padding: var(--s-4) 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    border-radius: 0;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
  }
  .open {
    cursor: pointer;
  }
  .open:hover .nm {
    text-decoration: underline;
    text-decoration-color: var(--line-hover);
  }
  .wait {
    color: var(--muted);
  }
  .cur {
    box-shadow: inset 3px 0 0 var(--text);
    padding-left: var(--s-8);
  }
  .nowrap {
    white-space: nowrap;
  }
  .n {
    white-space: nowrap;
    color: var(--muted);
    font: var(--t12) var(--mono);
  }
  .nm {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t14);
  }
</style>
