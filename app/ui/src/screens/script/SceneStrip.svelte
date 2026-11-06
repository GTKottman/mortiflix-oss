<!-- One tick per scene on longer scripts: green = approved, amber = edited, outlined = selected. Click to jump. -->
<script lang="ts">
  import { useScript } from './script.svelte';
  import { isApproved, isDrafted } from './timing';

  const script = useScript();
</script>

<div class="strip" role="group" aria-label="Scenes">
  {#each script.beats as beat (beat.id)}
    <button
      type="button"
      class:edited={isDrafted(beat, script.drafts)}
      class:approved={isApproved(beat) && !isDrafted(beat, script.drafts)}
      aria-current={beat.id === script.selected ? 'true' : undefined}
      title={`Scene ${beat.no}: ${beat.name}`}
      aria-label={`Go to scene ${beat.no}: ${beat.name}`}
      onclick={() => script.reveal(beat.id)}
    ></button>
  {/each}
</div>

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-4);
  }
  button {
    all: unset;
    box-sizing: border-box;
    width: var(--tick-w);
    height: var(--s-8);
    border-radius: var(--s-2);
    background: var(--line-2);
    cursor: pointer;
  }
  .approved {
    background: var(--good);
    opacity: 0.65;
  }
  .edited {
    background: var(--warn);
  }
  button[aria-current='true'] {
    outline: 2px solid var(--text);
    outline-offset: var(--s-2);
  }
  button:focus-visible {
    outline: var(--focus);
    outline-offset: var(--focus-off);
  }
</style>
