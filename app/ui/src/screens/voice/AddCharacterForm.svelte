<!-- Adds a character: a name, then a voice from the picker. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { roleId } from './roles';
  import VoicePicker from './VoicePicker.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { VoiceChoice } from './types';

  interface Props {
    model: VoiceModel;
    oncancel: () => void;
  }

  let { model, oncancel }: Props = $props();

  let name = $state('');
  let voice = $state<VoiceChoice | null>(null);
  let problem = $state<string | null>(null);
  let field = $state<HTMLInputElement>();

  $effect(() => field?.focus());

  async function add() {
    const id = roleId(name);
    if (!id) {
      problem = 'Give the character a name.';
      return;
    }
    if (model.cast.members.some((m) => m.role === id)) {
      problem = `${name.trim().replace(/^./, (c) => c.toUpperCase())} is already in the cast.`;
      return;
    }
    if (voice && (await model.addCharacter(name, voice))) oncancel();
  }
</script>

<div class="add">
  <label>
    <span class="lab">Name</span>
    <input
      type="text"
      placeholder="e.g. Dale"
      bind:value={name}
      bind:this={field}
      oninput={() => (problem = null)}
    />
  </label>
  <span class="hint">{voice ? `Voice: ${voice.name}` : 'Pick a voice below'}</span>
  <VoicePicker {model} currentId={voice?.id} useText="Pick" onuse={(chosen) => (voice = chosen)} />
  {#if problem}<span class="problem" role="alert">{problem}</span>{/if}
  <div class="buttons">
    <Button size="sm" disabled={!voice} title={voice ? '' : 'Pick a voice first'} onclick={add}>Add</Button>
    <Button size="sm" variant="text" onclick={oncancel}>Cancel</Button>
  </div>
  <span class="hint">Then open a line and pick this character under "Narrator and tone".</span>
</div>

<style>
  .add {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-8) 0;
    border-top: 1px solid var(--line);
  }
  label {
    display: flex;
    align-items: center;
    gap: var(--s-8);
  }
  .lab {
    color: var(--muted);
    font-size: var(--t12);
  }
  input {
    flex: 1;
    min-width: calc(var(--s-64) * 2);
    height: var(--h-sm);
    padding: 0 var(--s-8);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--ink-2);
    font-size: var(--t14);
  }
  input:focus {
    border-color: var(--link);
  }
  .hint {
    color: var(--faint);
    font-size: var(--t12);
  }
  .problem {
    color: var(--warn);
    font-size: var(--t12);
  }
  .buttons {
    display: flex;
    gap: var(--s-8);
  }
</style>
