<!-- The top of a "Mark the frame" window: kicker and title, and Cancel, which turns into "Throw away this note?"
     when there is something to lose. -->
<script lang="ts">
  import Button from './Button.svelte';

  interface Props {
    kicker: string;
    title: string;
    /** The id the window names itself by (aria-labelledby). */
    titleId: string;
    /** Cancel was pressed with unsaved work: ask before throwing it away. */
    asking: boolean;
    oncancel: () => void;
    onthrow: () => void;
    onkeep: () => void;
  }

  let { kicker, title, titleId, asking, oncancel, onthrow, onkeep }: Props = $props();
</script>

<header>
  <div>
    <p class="kicker">{kicker}</p>
    <h2 id={titleId}>{title}</h2>
  </div>
  {#if asking}
    <span class="ask" role="group" aria-label="Throw away this note?">
      Throw away this note?
      <Button size="sm" variant="danger" onclick={onthrow}>Throw away</Button>
      <Button size="sm" onclick={onkeep}>Keep editing</Button>
    </span>
  {:else}
    <Button variant="text" onclick={oncancel}>Cancel</Button>
  {/if}
</header>

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-16);
  }
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  h2 {
    font: 600 var(--t17) / 1.3 var(--body);
  }
  header > div {
    min-width: 0;
  }
  .ask {
    display: inline-flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    padding: var(--s-4) var(--s-8);
    border: 1px solid var(--warn);
    border-radius: var(--r);
  }
</style>
