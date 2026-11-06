<!-- The grid for checking off a group of pictures, shared by Look (all the frames, by round) and Stills (one
     scene's stills): a thumbnail, a name with a small line under it, and the state in words. Click any one to
     look at it. The one on view has an edge; a new group starts with its heading. -->
<script lang="ts" module>
  import type { Tag } from '../review/logic';

  export interface CheckRow {
    id: string;
    name: string;
    /** A small line under the name (how long a frame holds, the words of a still). */
    detail?: string;
    /** Studio path of the picture; empty = not made yet (the row still opens and says why). */
    path: string;
    tag: Tag;
    /** A heading shown above this row when it differs from the row before ("Round 2"). */
    group?: string;
  }
</script>

<script lang="ts">
  import { thumbUrl } from '../files';
  import StatusMark from './StatusMark.svelte';

  interface Props {
    rows: readonly CheckRow[];
    /** The row on view. */
    current: string | null;
    onselect: (id: string) => void;
    /** Names the list for screen readers, e.g. "Frames". */
    label: string;
  }

  let { rows, current, onselect, label }: Props = $props();
</script>

<ul class="rows" aria-label={label}>
  {#each rows as row, index (row.id)}
    {#if row.group && row.group !== rows[index - 1]?.group}<li class="group">{row.group}</li>{/if}
    {#snippet cells()}
      <span class="th"
        >{#if row.path}<img src={thumbUrl(row.path, 192)} alt="" loading="lazy" />{/if}</span
      >
      <span class="nm" title={row.detail}>
        {row.name}
        {#if row.detail}<small>{row.detail}</small>{/if}
      </span>
      <StatusMark mark={row.tag.look} glyph={row.tag.glyph} text={row.tag.text} />
    {/snippet}
    <li>
      <!-- every row opens: one not made yet shows why it waits in the picture's place -->
      <button
        class="row open"
        class:cur={row.id === current}
        type="button"
        aria-current={row.id === current ? 'true' : undefined}
        onclick={() => onselect(row.id)}
      >
        {@render cells()}
      </button>
    </li>
  {/each}
</ul>

<style>
  .rows {
    display: grid;
    list-style: none;
  }
  .group {
    padding: var(--s-12) 0 var(--s-4);
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .row {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    gap: var(--s-12);
    align-items: center;
    width: 100%;
    min-height: 48px;
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
  .cur {
    box-shadow: inset 3px 0 0 var(--text);
    padding-left: var(--s-8);
  }
  .th {
    position: relative;
    width: 64px;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-sm);
    background: var(--ink-3);
    overflow: hidden;
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .nm {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t14);
  }
  small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--muted);
    font-size: var(--t12);
  }
</style>
