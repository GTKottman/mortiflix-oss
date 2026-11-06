<!-- The words of a line with their timing: click a word to hear from it. A dashed word was heard but is not in the
     script; a struck-through one is in the script but was not heard. -->
<script lang="ts">
  import type { LineCheck, VoiceLine } from './types';
  import type { VoiceModel } from './model.svelte';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
    check: LineCheck | undefined;
  }

  let { model, line, check }: Props = $props();
  const words = $derived(check?.words ?? []);
  const hearing = $derived(model.player.playingLine === line.node);
  const bare = $derived(
    model
      .textOf(line)
      .replace(/\[[^\]]*\]/g, '')
      .trim(),
  );
</script>

<div class="words">
  {#if !words.length}
    <span class="hint"
      >{check?.checked === false ? 'No word timings yet. They appear once the line is read.' : bare}</span
    >
  {/if}
  {#each words as word, n (n)}
    <button
      type="button"
      class:extra={word.extra}
      class:now={hearing && model.player.lineTime >= word.start && model.player.lineTime < word.end}
      title="{word.extra ? 'heard, not in the script · ' : ''}{word.start.toFixed(2)} s"
      onclick={() => model.player.playLine(line, word.start)}
    >
      {word.extra ? '+' : ''}{word.text.replace(/^\+/, '')}
    </button>
  {/each}
  <!-- by place: the same word can be missing twice ("a partly positive and a partly negative": each_key_duplicate, Dir3) -->
  {#each check?.missing ?? [] as word, n (n)}
    <span class="missing" title="in the script, not heard">{word}</span>
  {/each}
</div>

<style>
  .words {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-4);
  }
  button,
  .missing {
    padding: var(--s-4) var(--s-8);
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: var(--ink-4);
    font: var(--t14) / 1.2 var(--body);
  }
  button {
    cursor: pointer;
  }
  button:hover {
    border-color: var(--line-2);
  }
  .now {
    background: var(--text);
    color: var(--ink);
  }
  .extra,
  .missing {
    border: 1px dashed var(--warn);
    background: transparent;
    color: var(--warn);
  }
  .missing {
    text-decoration: line-through;
  }
  .hint {
    color: var(--muted);
    font-size: var(--t14);
  }
</style>
