<!-- The scene's narration as one paragraph. Each line is a button: click, Enter, Space, F2 or F opens the editor
     on that line. The keys are handled here so Enter never reaches the screen's "Enter = OK" shortcut. -->
<script lang="ts">
  import { useScript } from './script.svelte';
  import type { Beat } from './types';
  import { wordsNow } from './timing';

  interface Props {
    beat: Beat;
    compact?: boolean;
  }

  let { beat, compact = false }: Props = $props();
  const script = useScript();

  const firstWords = (text: string) => text.split(/\s+/).slice(0, 6).join(' ');
  const OPEN_KEYS = ['Enter', ' ', 'F2', 'e', 'E'];

  function onkey(event: KeyboardEvent, lineId: string) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // F is Fix everywhere on this screen; Enter, Space, F2 and E open the words.
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      script.openFix(beat.id);
      return;
    }
    if (!OPEN_KEYS.includes(event.key)) return;
    event.preventDefault();
    script.startEdit(beat, lineId);
  }

  /** Lines whose voice take says other words than the script now (the scene was rewritten). */
  const reread = $derived(beat.lines.filter((l) => l.words_changed));
  const rereadCredits = $derived(reread.reduce((sum, l) => sum + l.words.length, 0));
</script>

<p class="lines" class:compact>
  {#each beat.lines as line, k (line.id)}
    {@const words = wordsNow(line.id, line.words, script.drafts)}
    {@const gap = k < beat.lines.length - 1 ? ' ' : ''}
    {#if line.read_only}
      <span class="ln ro" title="Still being written">{words}</span>{gap}
    {:else}
      <span
        class="ln"
        class:changed={line.words_changed}
        role="button"
        tabindex="0"
        title="Click to change this line"
        aria-label={`Edit line: ${firstWords(words)}`}
        onclick={() => script.startEdit(beat, line.id)}
        onkeydown={(event) => onkey(event, line.id)}>{words}</span
      >{gap}
    {/if}
  {:else}
    <span class="none">No narration in this scene yet.</span>
  {/each}
</p>
{#if reread.length && !compact}
  <p class="reread">
    {reread.length === 1 ? '1 line' : `${reread.length} lines`} changed since the voice was recorded: re-read needed{script.voicePaid
      ? ` (about ${rereadCredits.toLocaleString('en-US')} ElevenLabs credits, asked before it runs)`
      : ''}
  </p>
{/if}

<style>
  .lines {
    max-width: 70ch;
    font-size: var(--t16);
    line-height: 1.6;
  }
  .ln {
    border-radius: var(--r-sm);
    cursor: text;
  }
  .ln.changed {
    text-decoration: underline dashed var(--warn);
    text-underline-offset: 4px;
  }
  .reread {
    color: var(--warn);
    font-size: var(--t13);
  }
  .ln:hover {
    background: var(--ink-3);
  }
  .ro {
    color: var(--muted);
    cursor: default;
  }
  .none {
    color: var(--muted);
  }
  .ro:hover {
    background: none;
  }
  .ln:focus-visible {
    outline: var(--focus);
    outline-offset: var(--s-2);
  }
  .compact {
    overflow: hidden;
    color: var(--muted);
    font-size: var(--t15);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
