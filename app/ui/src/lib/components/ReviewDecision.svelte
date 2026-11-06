<!-- The decision row: what is waiting, Fix (F) and OK (Enter). The gradient is on Fix while notes wait, on OK
     otherwise. Fix is on for every piece the owner can decide on: with no note it puts the cursor in the note box.
     A held piece (a check not satisfied, its result beside the picture) offers Fix (the check result goes with it,
     plus any note) and OK anyway. -->
<script lang="ts">
  import { plural } from '../words';
  import type { Snippet } from 'svelte';
  import type { ReviewItem } from '../review/types';
  import Button from './Button.svelte';
  import StatusMark from './StatusMark.svelte';

  interface Props {
    item: ReviewItem;
    /** Notes waiting, counting one typed and not saved. */
    waiting: number;
    /** What is being sent right now; empty = nothing. */
    busy: string;
    onok: () => void;
    onfix: () => void;
    /** Extra words after the sentence, e.g. a link back to the piece that needs checking. */
    after?: Snippet;
  }

  let { item, waiting, busy, onok, onfix, after }: Props = $props();

  const canDecide = $derived((item.state === 'review' || item.state === 'held') && !busy);
  const fixPrimary = $derived(canDecide && waiting > 0);
</script>

<div class="decide">
  {#if item.state === 'held'}
    <span class="says">
      {#if busy}
        <StatusMark mark="busy" glyph="◌" text={busy} />
      {:else}
        <StatusMark
          mark="fix"
          glyph="!"
          text={waiting
            ? `A check is not satisfied. Fix sends ${plural(waiting, 'note')} with it.`
            : 'A check is not satisfied. You decide.'}
        />
      {/if}
    </span>
    <Button size="lg" variant={fixPrimary ? 'primary' : 'secondary'} disabled={!canDecide} onclick={onfix}
      >Fix <kbd aria-hidden="true">F</kbd></Button
    >
    <Button size="lg" variant={fixPrimary ? 'secondary' : 'primary'} disabled={!canDecide} onclick={onok}
      >OK anyway</Button
    >
  {:else}
    <span class="says">
      {#if busy}
        <StatusMark mark="busy" glyph="◌" text={busy} />
      {:else if item.state === 'making' && item.waitWords}
        <StatusMark mark="fix" glyph="!" text={item.waitWords} />
      {:else if item.state === 'making'}
        <StatusMark mark="busy" glyph="◌" text="Being made. Fix and OK wait until it is ready." />
      {:else if item.state === 'ok'}
        <StatusMark mark="ok" glyph="✓" text={`This ${item.noun} is OK.`} />
      {:else if item.state === 'waiting'}
        {item.waitWords ??
          `This ${item.noun} is made after the ones before it, so it gets what you tell us about them.`}
      {:else if waiting}
        <b>{plural(waiting, 'note')} {waiting === 1 ? 'waits' : 'wait'}</b>. Fix remakes only this {item.noun} with
        {waiting === 1 ? 'it' : 'all of them'}.
      {:else}
        {item.okWords.none}. Or mark what is wrong first, then Fix.
      {/if}
      {#if after}{@render after()}{/if}
    </span>
    <Button
      size="lg"
      variant={fixPrimary ? 'primary' : 'secondary'}
      disabled={!canDecide}
      title={canDecide && !waiting ? 'Type or mark what to change first' : undefined}
      onclick={onfix}>Fix <kbd aria-hidden="true">F</kbd></Button
    >
    <Button
      size="lg"
      variant={canDecide && !fixPrimary ? 'primary' : 'secondary'}
      disabled={!canDecide}
      onclick={onok}>OK <kbd aria-hidden="true">Enter</kbd></Button
    >
  {/if}
</div>

<style>
  .decide {
    display: flex;
    align-items: center;
    gap: var(--s-12);
    border-top: 1px solid var(--line);
    padding-top: var(--s-12);
  }
  .says {
    margin-right: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--t14);
  }
  .says b {
    color: var(--text);
    font-weight: 600;
  }
  kbd {
    font: 600 var(--t12) / 1 var(--mono);
    border: 1px solid currentColor;
    border-radius: var(--r-sm);
    padding: var(--s-2) var(--s-4);
    margin-left: var(--s-4);
    opacity: 0.6;
  }
  @media (max-width: 1199px) {
    .decide {
      flex-wrap: wrap;
    }
    .says {
      flex: 1 0 100%;
      white-space: normal;
    }
  }
</style>
