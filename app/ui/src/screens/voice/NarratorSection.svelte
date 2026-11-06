<!-- Who reads the line and in what tone. A change needs a new read (paid), so it goes to the queue. -->
<script lang="ts">
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import Hint from './Hint.svelte';
  import { roleName } from './roles';
  import ToneTags from './ToneTags.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
  }

  const TAG_EXAMPLES = '[exhausted] [flat] [sighs] [whispers] [laughs]';

  let { model, line }: Props = $props();

  const id = $derived(line.node);
  const role = $derived(model.roleOf(id));
  const locked = $derived(!model.cast.ready);

  function chooseRole(event: Event & { currentTarget: HTMLSelectElement }) {
    const value = event.currentTarget.value;
    if (value === '+new') {
      event.currentTarget.value = role;
      model.requestNewCharacter();
    } else model.basket.stage(id, { role: value });
  }
</script>

<InspectorSection title="Narrator and tone">
  {#if model.cast.ready}
    <select aria-label="Who says this line" onchange={chooseRole}>
      {#each model.cast.members as member (member.role)}
        <option value={member.role} selected={member.role === role}
          >{roleName(member.role)}{member.name ? ` · ${member.name}` : ''}</option
        >
      {/each}
      <option value="+new">+ Add a character…</option>
    </select>
  {/if}
  <ToneTags tags={model.tagsOf(id)} disabled={locked} onchange={(tags) => model.basket.stage(id, { tags })} />
  <Hint>
    {locked ? 'The cast could not load, so tags and voice are off (see Voices and cast below). ' : ''}Tone
    tags colour how it is read, for example {TAG_EXAMPLES}. A change needs a new read (paid).
  </Hint>
</InspectorSection>

<style>
  select {
    height: var(--h);
    max-width: 100%;
    padding: 0 var(--s-8);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--ink-4);
    font-size: var(--t14);
  }
  select:disabled {
    opacity: 0.5;
  }
</style>
