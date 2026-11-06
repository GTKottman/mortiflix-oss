<!-- The tray's way in: paste a link and press Enter, or pick files. A link that cannot be added says why under the box. -->
<script lang="ts">
  import Button from './Button.svelte';
  import { linkProblem, type NewSource, type TraySource } from '../source-tray';

  interface Props {
    sources: readonly TraySource[];
    /** Adds a link. A link it cannot add rejects with a plain sentence. */
    onadd: (source: NewSource) => Promise<void>;
    onfiles: (files: File[]) => void;
  }

  let { sources, onadd, onfiles }: Props = $props();

  const id = $props.id();
  let link = $state('');
  let problem = $state('');
  let linkInput = $state<HTMLInputElement>();
  let picker = $state<HTMLInputElement>();

  export const focus = () => linkInput?.focus();

  async function addLink() {
    const text = link.trim();
    if (!text) return;
    const refused = linkProblem(text, sources);
    if (refused) {
      problem = refused;
      return;
    }
    problem = '';
    link = '';
    try {
      await onadd({ url: text });
    } catch (error) {
      problem = error instanceof Error ? error.message : 'That link could not be added.';
      link = text;
    }
  }

  function pick(event: Event & { currentTarget: HTMLInputElement }) {
    onfiles([...(event.currentTarget.files ?? [])]);
    event.currentTarget.value = '';
  }
</script>

<div class="add">
  <input
    bind:this={linkInput}
    bind:value={link}
    class="input"
    type="url"
    placeholder="Paste a link"
    autocomplete="off"
    aria-label="Add a link"
    aria-describedby="{id}-problem"
    aria-invalid={problem ? 'true' : 'false'}
    oninput={() => (problem = '')}
    onkeydown={(event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void addLink();
    }}
  />
  <Button onclick={() => void addLink()}>Add link</Button>
  <Button onclick={() => picker?.click()}>Upload</Button>
  <input bind:this={picker} type="file" multiple hidden onchange={pick} />
</div>
<p id="{id}-problem" class="problem" role="alert" hidden={!problem}>{problem ? `! ${problem}` : ''}</p>

<style>
  .add {
    --link-basis: 260px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
  .input {
    flex: 1 1 var(--link-basis);
    min-width: 0;
    height: var(--h);
    padding: 0 var(--s-12);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: var(--ink-2);
  }
  .input::placeholder {
    color: var(--faint);
  }
  .input:focus-visible {
    outline: none;
    border-color: var(--link);
  }
  .problem {
    color: var(--bad);
    font-size: var(--t13);
  }
</style>
