<!-- The tone tags of a line, e.g. [wry] [sighs]: remove one with ×, add one and press Enter. A change needs a new read. -->
<script lang="ts">
  import { TONE_TAG_FIELD } from './keys';

  interface Props {
    tags: readonly string[];
    disabled: boolean;
    onchange: (tags: string[]) => void;
  }

  let { tags, disabled, onchange }: Props = $props();
  let draft = $state('');

  function add() {
    const tag = draft.trim().replace(/[[\]]/g, '');
    if (!tag) return;
    draft = '';
    if (!tags.includes(tag)) onchange([...tags, tag]);
  }
</script>

<div class="tags">
  {#each tags as tag, n (n)}
    <em>
      [{tag}]
      {#if !disabled}
        <button
          type="button"
          aria-label="Remove tag {tag}"
          onclick={() => onchange(tags.filter((_, i) => i !== n))}>×</button
        >
      {/if}
    </em>
  {/each}
  <input
    id={TONE_TAG_FIELD}
    placeholder="+ tag"
    aria-label="Add a tone tag"
    {disabled}
    bind:value={draft}
    onkeydown={(event) => event.key === 'Enter' && add()}
  />
</div>

<style>
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-4);
  }
  em {
    padding: var(--s-4) var(--s-8);
    border: 1px dashed var(--line-2);
    border-radius: var(--s-4);
    background: var(--ink-4);
    color: var(--muted);
    font-size: var(--t14);
    font-style: normal;
    white-space: nowrap;
  }
  em button {
    margin-left: var(--s-4);
    padding: 0;
    border: 0;
    background: none;
    color: var(--faint);
    cursor: pointer;
  }
  input {
    width: calc(var(--s-64) + var(--s-48));
    height: var(--h-sm);
    padding: 0 var(--s-8);
    border: 1px dashed var(--line-2);
    border-radius: var(--s-4);
    background: transparent;
    font-size: var(--t13);
  }
  input:focus {
    border-color: var(--link);
  }
</style>
