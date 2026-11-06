<!-- The sources in the tray, one row each: what kind, its name, what became of it, and a way to remove it. -->
<script lang="ts">
  import { statusText, type TraySource } from '../source-tray';

  interface Props {
    sources: readonly TraySource[];
    onremove: (source: TraySource) => void;
  }

  let { sources, onremove }: Props = $props();
</script>

<ul class="list">
  {#each sources as source (source.id)}
    <li>
      <span class="kind">{source.kind}</span>
      <span class="name" title={source.url ?? source.label}>{source.label}</span>
      <span
        class="status"
        class:failed={source.status === 'failed'}
        class:reading={source.status === 'fetching'}>{statusText(source)}</span
      >
      <button type="button" class="remove" aria-label="Remove {source.label}" onclick={() => onremove(source)}
        >✕</button
      >
    </li>
  {/each}
</ul>

<style>
  .list {
    display: grid;
    list-style: none;
  }
  li {
    --kind-w: 90px;
    display: grid;
    grid-template-columns: var(--kind-w) minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--s-12);
    min-height: var(--hit);
    border-top: 1px solid var(--line);
    font-size: var(--t14);
  }
  .kind {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--faint);
    font-size: var(--t12);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .failed {
    color: var(--bad);
  }
  .reading::before {
    content: '\25cc\00a0';
  }
  .remove {
    padding: var(--s-8);
    border: 0;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .remove:hover,
  .remove:focus-visible {
    color: var(--text);
  }
</style>
