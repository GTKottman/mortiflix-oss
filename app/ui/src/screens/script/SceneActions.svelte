<!-- The scene's buttons: Edit, OK / Reopen, Undo last save; or Save / Cancel while it is open for editing.
     A scene still being written has no Edit or OK: it says so instead. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import SceneMenu from './SceneMenu.svelte';
  import { useScript } from './script.svelte';
  import { plural } from '../../lib/words';
  import { isApproved, isBusy, isCut, okCostText } from './timing';
  import type { Beat } from './types';

  interface Props {
    beat: Beat;
  }

  let { beat }: Props = $props();
  const script = useScript();

  const label = $derived(`scene ${beat.no}: ${beat.name}`);
  const open = $derived(script.editing.has(beat.id));
  const changed = $derived(beat.lines.filter((l) => l.id in script.drafts).length + script.addedCount(beat));
  /** New lines are read on Voice & music once the scene has a voice: a character a credit, asked before it runs. */
  const newCredits = $derived(
    (script.added[beat.id] ?? []).reduce((sum, l) => sum + l.words.trim().length, 0),
  );
  const approving = $derived(Boolean(script.approving[beat.id]));
  /** At least one line can be changed (lines still being written are read-only); a cut scene is not in the video. */
  const editable = $derived(!isCut(beat) && beat.lines.some((l) => !l.read_only));
  const cut = $derived(isCut(beat));
  const busy = $derived(isBusy(beat));
  const okCost = $derived(okCostText(script.beats, beat, script.voiceBy, script.voicePaid));
  const hint = $derived.by(() => {
    if (!editable) return 'Mortiflix is still writing this scene';
    if (!changed) return 'Change a line, then Save';
    const back = isApproved(beat) ? ' · the scene goes back to Needs review' : '';
    const read =
      newCredits > 0 && script.voicePaid
        ? ` · a new line is read on Voice & music: about ${newCredits.toLocaleString('en-US')} credits, asked first`
        : ' · nothing is voiced or charged';
    return `${plural(changed, 'line')} changed${back}${read}`;
  });
</script>

<div class="acts">
  {#if open}
    <Button
      size="sm"
      variant="primary"
      disabled={script.saving || changed === 0}
      onclick={() => void script.save(beat)}>{script.saving ? 'Saving…' : 'Save'}</Button
    >
    <Button size="sm" variant="text" disabled={script.saving} onclick={() => script.cancel(beat)}
      >Cancel</Button
    >
    <span class="hint">{hint}</span>
  {:else}
    {#if editable}
      <Button
        size="sm"
        aria-label={`Edit ${label}`}
        disabled={approving}
        onclick={() => script.startEdit(beat)}>Edit</Button
      >
    {/if}
    {#if isApproved(beat)}
      <Button
        size="sm"
        variant="text"
        aria-label={`Reopen ${label}`}
        disabled={approving}
        onclick={() => void script.decide(beat, 'clear')}>Reopen</Button
      >
    {:else if !busy && !cut}
      <Button
        size="sm"
        aria-label={`Approve ${label}${okCost ? `. ${okCost}` : ''}`}
        title={okCost ?? undefined}
        disabled={approving}
        onclick={() => void script.decide(beat, 'ok')}>OK</Button
      >
    {/if}
    {#if editable && !busy}
      <Button
        size="sm"
        variant="text"
        aria-label={`Fix ${label} with a note`}
        aria-expanded={script.fixOpen === beat.id}
        disabled={approving || script.fixSending !== null}
        onclick={() => (script.fixOpen === beat.id ? script.closeFix() : script.openFix(beat.id))}
        >Fix…</Button
      >
    {/if}
    {#if script.fixSent === beat.id}
      <span class="hint" role="status">Fix sent · Mortiflix is rewriting this scene</span>
    {/if}
    {#if script.undoable[beat.id]}
      <Button
        size="sm"
        variant="text"
        disabled={script.saving || approving}
        onclick={() => void script.undo(beat)}>Undo last save</Button
      >
    {/if}
    <SceneMenu {beat} />
    {#if busy}
      <span class="hint">Mortiflix is still writing this scene</span>
    {:else if okCost && !isApproved(beat) && !cut}
      <span class="hint cost">{okCost}</span>
    {/if}
  {/if}
</div>

<style>
  .acts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-8);
    min-height: var(--h-sm);
  }
  .acts > :global(*) {
    flex-shrink: 0;
  }
  .acts > .hint {
    flex-shrink: 1;
    min-width: 0;
  }
  .hint.cost {
    color: var(--warn);
  }
  .hint {
    color: var(--faint);
    font-size: var(--t13);
  }
</style>
