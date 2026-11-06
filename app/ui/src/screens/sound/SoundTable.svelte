<!-- The open shot's sounds, one row per action: Time | Action | Sound (with where it comes from) | Length | Status.
     Each row's action is a button (so Tab, Enter and the arrow keys work); clicking anywhere on the row picks it.
     Under 1600 the picked sound's detail opens as a row right under it (`detail`). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { clockTenths } from '../../lib/time';
  import { cueStatus, soundName, sourceChip } from './sound';
  import type { Cue } from './types';

  interface Props {
    cues: Cue[];
    selectedId: string | undefined;
    /** Sounds are being made. */
    making: boolean;
    onpick: (cue: Cue) => void;
    /** The selected sound's detail, shown as a row under it. Leave out when it has its own column. */
    detail?: Snippet<[Cue]>;
  }

  let { cues, selectedId, making, onpick, detail }: Props = $props();
  let table = $state<HTMLTableElement>();

  async function move(event: KeyboardEvent, index: number) {
    const to = cues[index + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)];
    if (!to || to.id === cues[index]?.id) return;
    event.preventDefault();
    onpick(to);
    queueMicrotask(() => table?.querySelector<HTMLElement>(`[data-cue="${to.id}"]`)?.focus());
  }
</script>

<table bind:this={table} aria-label="Sounds in this shot">
  <colgroup>
    <col style:width="76px" />
    <col style:width="17%" />
    <col />
    <col style:width="76px" />
    <col style:width="150px" />
  </colgroup>
  <thead>
    <tr>
      <th class="n">Time</th>
      <th>Action</th>
      <th>Sound</th>
      <th class="n">Length</th>
      <th>Status</th>
    </tr>
  </thead>
  <tbody>
    {#each cues as cue, index (cue.id)}
      {@const status = cueStatus(cue, making)}
      <tr class:current={cue.id === selectedId}>
        <td class="n time">{clockTenths(cue.at_sec)}</td>
        <td class="action" class:cut={cue.status === 'cut'}>
          <button
            type="button"
            data-cue={cue.id}
            aria-current={cue.id === selectedId}
            title={cue.what}
            onclick={() => onpick(cue)}
            onkeydown={(event) => move(event, index)}>{cue.what}</button
          >
        </td>
        <td class="sound">
          <div>
            <span class="name" title={cue.prompt}>{soundName(cue)}</span>
            <span class="chip">{sourceChip(cue)}</span>
          </div>
          {#if cue.match}<p class="why" title={cue.match}>{cue.match}</p>{/if}
        </td>
        <td class="n length">{cue.dur_sec.toFixed(1)} s</td>
        <td><StatusMark mark={status.mark} text={status.text} /></td>
      </tr>
      {#if detail && cue.id === selectedId}
        <tr class="detail"><td colspan="5">{@render detail(cue)}</td></tr>
      {/if}
    {/each}
  </tbody>
</table>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: var(--t14);
  }
  th {
    height: var(--h-sm);
    padding: 0 var(--s-8);
    border-bottom: 1px solid var(--line);
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-align: left;
    text-transform: uppercase;
  }
  tbody tr {
    position: relative;
  }
  td {
    height: 52px;
    padding: 0 var(--s-8);
    overflow: hidden;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .n {
    font: 400 var(--t13) / 1 var(--mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  th.n {
    font: 600 var(--t12) / 1 var(--body);
    letter-spacing: var(--track-kicker);
  }
  td.n {
    color: var(--text);
  }
  tr.current td {
    background: var(--ink-2);
  }
  .action button {
    max-width: 100%;
    padding: 0;
    overflow: hidden;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  /* The whole row is the button's click target. */
  .action button::after {
    content: '';
    position: absolute;
    inset: 0;
  }
  .action button:focus-visible {
    outline: none;
  }
  .action button:focus-visible::after {
    outline: 2px solid var(--text);
    outline-offset: -2px;
  }
  .action.cut button {
    text-decoration: line-through;
  }
  .sound div {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    min-width: 0;
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .why {
    margin: var(--s-2) 0 0;
    overflow: hidden;
    color: var(--muted);
    font-size: var(--t12);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .chip {
    flex: none;
    padding: var(--s-2) var(--s-8);
    border-radius: var(--r-sm);
    background: var(--line);
    color: var(--text);
    font-size: var(--t12);
  }
  tr.detail td {
    height: auto;
    padding: var(--s-16) var(--s-8) var(--s-24);
    overflow: visible;
    background: var(--ink-2);
    white-space: normal;
  }
</style>
