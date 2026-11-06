<!-- The Fix it strip: the one place a problem shows, under the top bar (owner 2026-11-01: errors only, never
     below the fold). Hidden when nothing is wrong. One sentence, the state glyph, and one Fix it button. -->
<script lang="ts">
  import { useProblems } from '../stores/context';
  import type { Problems, StripLook } from '../stores/problems.svelte';
  import Button from './Button.svelte';

  interface Props {
    /** Another problem list (the kit's demos). Default: the app's. */
    problems?: Problems;
  }

  let { problems = useProblems() }: Props = $props();

  const GLYPH: Record<StripLook, string> = { warn: '!', bad: '✕', busy: '◌', ok: '✓' };
  const current = $derived(problems.current);
  const text = $derived(problems.done ?? current?.text ?? null);
  const others = $derived(problems.done ? 0 : problems.list.length - 1);
  const canFix = $derived(!problems.done && !!current?.fix);
  const id = $props.id();
  /** The other problems are listed under the strip ("1 of 3" opens them). */
  let showAll = $state(false);
  const rest = $derived(problems.done ? [] : problems.list.filter((p) => p !== current));
  $effect(() => {
    if (!rest.length) showAll = false;
  });
</script>

<div class="slot" aria-live="polite">
  {#if text}
    <div class="fixit {problems.look}" role={problems.look === 'bad' ? 'alert' : undefined}>
      <span class="glyph" aria-hidden="true">{GLYPH[problems.look]}</span>
      <span class="text">{text}</span>
      {#if others > 0}
        <Button
          size="sm"
          variant="text"
          aria-expanded={showAll}
          aria-controls="{id}-rest"
          onclick={() => (showAll = !showAll)}
          >{showAll ? 'Hide the others' : `1 of ${others + 1} · Show all`}</Button
        >
      {/if}
      {#if canFix && current?.also}
        <Button size="sm" variant="text" disabled={problems.fixing} onclick={() => problems.fix(true)}>
          {current.also.label ?? 'Other way'}
        </Button>
      {/if}
      {#if canFix}
        <Button size="sm" disabled={problems.fixing} onclick={() => problems.fix()}>
          {problems.fixing ? 'Fixing…' : (current?.fix?.label ?? 'Fix it')}
        </Button>
      {/if}
    </div>
    {#if showAll && rest.length}
      <ul class="rest" id="{id}-rest">
        {#each rest as other (other.id)}
          <li class={other.kind}>
            <span class="glyph" aria-hidden="true">{GLYPH[other.kind]}</span>{other.text}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .fixit {
    display: flex;
    align-items: center;
    gap: var(--s-16);
    min-height: var(--h-strip);
    padding: var(--s-4) var(--s-24);
    border-bottom: 1px solid var(--line);
    background: var(--ink);
    font-size: var(--t14);
    animation: mfx-fade var(--dur-fast) var(--ease);
  }
  .glyph {
    flex: none;
    font-weight: 600;
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .rest {
    display: grid;
    gap: var(--s-4);
    padding: var(--s-8) var(--s-24) var(--s-12) calc(var(--s-24) + var(--s-24));
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--t13);
    list-style: none;
  }
  .rest .glyph {
    margin-right: var(--s-8);
  }
  .rest .bad .glyph {
    color: var(--bad);
  }
  .rest .warn .glyph {
    color: var(--warn);
  }
  .warn {
    box-shadow: inset 3px 0 0 var(--warn);
  }
  .warn .glyph {
    color: var(--warn);
  }
  .bad {
    box-shadow: inset 3px 0 0 var(--bad);
  }
  .bad .glyph {
    color: var(--bad);
  }
  .busy .glyph {
    color: var(--busy);
  }
  .ok .glyph {
    color: var(--good);
  }
  @media (max-width: 1599px) {
    .fixit {
      padding-inline: var(--s-16);
    }
  }
</style>
