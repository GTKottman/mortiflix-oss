<!-- Fix with the owner's own words, for one scene or for the whole script. The note goes to Mortiflix, which rewrites
     it (a scene: node.edit fix; the script: review.respond changes). Ctrl+Enter sends, Esc closes. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { useScript } from './script.svelte';

  interface Props {
    /** A scene id, or 'all' for the whole script. */
    target: string;
    /** "scene 3", "the whole script": what the note fixes, in words. */
    what: string;
    /** A line under the box about what sending does beyond the rewrite. */
    note?: string;
  }

  let { target, what, note }: Props = $props();
  const script = useScript();

  const words = $derived(script.fixWords[target] ?? '');
  const sending = $derived(script.fixSending === target);
  const id = $derived(`fix-${target}`);

  function focusOnMount(node: HTMLTextAreaElement) {
    node.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      script.closeFix();
      if (target !== 'all') script.reveal(target);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void script.sendFix();
    }
  }
</script>

<div class="fix" role="group" aria-labelledby={`${id}-label`}>
  <label id={`${id}-label`} for={id}>What should change in {what}?</label>
  <textarea
    {id}
    rows="2"
    value={words}
    disabled={sending}
    placeholder="Say it in your own words, e.g. make the ending punchier and drop the jargon"
    use:focusOnMount
    oninput={(event) => (script.fixWords = { ...script.fixWords, [target]: event.currentTarget.value })}
    {onkeydown}></textarea>
  <div class="acts">
    <Button size="sm" disabled={sending || !words.trim()} onclick={() => void script.sendFix()}
      >{sending ? 'Sending…' : 'Send fix'}</Button
    >
    <Button size="sm" variant="text" disabled={sending} onclick={() => script.closeFix()}>Cancel</Button>
    <span class="hint">Mortiflix rewrites {what} from your note · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends</span
    >
  </div>
  {#if note}<p class="note">{note}</p>{/if}
  {#if script.fixError}<p class="error" role="alert">Not sent: {script.fixError}</p>{/if}
</div>

<style>
  .fix {
    display: grid;
    gap: var(--s-8);
    min-width: 0;
  }
  label {
    color: var(--muted);
    font-size: var(--t13);
  }
  textarea {
    width: 100%;
    min-height: calc(var(--h-sm) * 2);
    padding: var(--s-8) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink);
    color: inherit;
    font: inherit;
    line-height: 1.5;
    resize: vertical;
  }
  textarea:focus-visible {
    outline: var(--focus);
    outline-offset: 1px;
  }
  .acts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
  .acts > :global(*) {
    flex-shrink: 0;
  }
  .hint {
    flex-shrink: 1;
    min-width: 0;
    color: var(--faint);
    font-size: var(--t13);
  }
  kbd {
    padding: var(--s-2) var(--s-4);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    font: 600 var(--t12) / 1 var(--mono);
  }
  .note {
    color: var(--warn);
    font-size: var(--t13);
  }
  .error {
    color: var(--warn);
    font-size: var(--t13);
  }
</style>
