<!-- Version 1, 2, …: centred under the player. Approve keeps the scene's
     newest version (motion.scene.approve takes the scene, not a version), and the note says so when an older one is on
     screen. Compare shows Before and After at the same time and play state. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { useMotion } from './motion.svelte';

  const motion = useMotion();

  const versions = $derived(motion.versions);
  const viewed = $derived(motion.viewed);
  const approvesText = $derived(
    viewed && viewed.n !== motion.latest
      ? `Approve keeps the newest, Version ${motion.latest}, not Version ${viewed.n}.`
      : `Approve keeps Version ${motion.latest}, the newest.`,
  );
  const when = (iso: string): string =>
    new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
</script>

<div class="vers">
  {#if motion.scene && !versions.length}
    {#if motion.scene.state !== 'waiting'}<span class="nowrap">No version yet</span>{/if}
  {:else if versions.length === 1}
    <span class="nowrap">Version {versions[0]?.n}{versions[0]?.at ? ` · ${when(versions[0].at)}` : ''}</span>
  {:else if versions.length > 1}
    {#if motion.compare}
      <span class="seg" role="group" aria-label="Before and after">
        <button type="button" aria-pressed={motion.side === 'before'} onclick={() => motion.setSide('before')}
          >Before · Version {versions.at(-2)?.n}</button
        >
        <button type="button" aria-pressed={motion.side === 'after'} onclick={() => motion.setSide('after')}
          >After · Version {versions.at(-1)?.n}</button
        >
      </span>
    {:else}
      <span class="seg" role="group" aria-label="Versions">
        {#each versions as version, i (version.n)}
          <button type="button" aria-pressed={viewed === version} onclick={() => motion.pickVersion(i)}
            >Version {version.n}</button
          >
        {/each}
      </span>
    {/if}
    <Button
      size="sm"
      variant={motion.compare ? 'secondary' : 'text'}
      pressed={motion.compare}
      onclick={() => motion.setCompare(!motion.compare)}
      >{motion.compare ? 'Done comparing' : 'Compare with previous'}</Button
    >
    {#if viewed}
      <span class="note" title={approvesText}>{approvesText}</span>
    {/if}
  {/if}
</div>

<style>
  .vers {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--s-8);
    min-height: var(--h-sm);
    color: var(--muted);
    font-size: var(--t13);
  }
  .nowrap {
    white-space: nowrap;
  }
  .note {
    flex: 1 1 100%;
    color: var(--faint);
    font-size: var(--t12);
    text-align: center;
  }
  /* Many versions scroll sideways inside the pill; the row keeps its fixed height. */
  .seg {
    display: inline-flex;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    border: 1px solid var(--line-2);
    border-radius: var(--r);
  }
  .seg button {
    height: var(--btn-h);
    padding: 0 var(--btn-pad);
    border: 0;
    background: none;
    color: var(--muted);
    font: 600 var(--t12) / 1 var(--body);
    flex-shrink: 0;
    white-space: nowrap;
    cursor: pointer;
  }
  .seg button[aria-pressed='true'] {
    background: var(--ink-3);
    color: var(--text);
  }
</style>
