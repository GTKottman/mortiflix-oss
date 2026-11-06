<!-- Apply a template or a saved preset to the settings, and save the current settings as a preset. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import { useProblems } from '../../lib/stores/context';
  import { useNewProject } from './context';
  import Note from './Note.svelte';
  import SelectBox from './SelectBox.svelte';
  import { TEMPLATES } from './templates';
  import TextInput from './TextInput.svelte';
  import type { Preset, Value } from './types';

  const { form, soft, client } = useNewProject();
  const problems = useProblems();

  let saved = $state<Preset[]>([]);
  let name = $state('');
  let message = $state('');
  let chosen = $state('');

  const all = $derived<Preset[]>([...TEMPLATES, ...saved]);

  onMount(() => {
    void soft.call<{ briefs?: Preset[] }>('presets.list', {}).then((reply) => {
      if (reply?.briefs) saved = reply.briefs;
    });
  });

  function apply() {
    const preset = all[Number(chosen)];
    chosen = '';
    if (!preset) return;
    form.apply(preset.brief);
    message = `Applied ${preset.name}. Your idea and sources were not touched.`;
  }

  async function save() {
    const title = name.trim();
    if (!title) return;
    const own = ['idea', 'title', 'sources', 'meta'];
    const brief: Record<string, Value> = Object.fromEntries(
      Object.entries(form.contract([])).filter(([key]) => !own.includes(key)),
    );
    try {
      const reply = await client.call<{ slug: string }>('presets.save', { name: title, brief });
      saved = [...saved.filter((p) => p.slug !== reply.slug), { slug: reply.slug, name: title, brief }];
      name = '';
      message = `Saved "${title}".`;
    } catch (error) {
      problems.raise({
        id: 'np-preset',
        kind: 'warn',
        text: `Couldn't save the preset: ${error instanceof Error ? error.message : 'failed'}`,
      });
    }
  }
</script>

<div class="presets">
  <b>Saved presets and templates</b>
  <SelectBox aria-label="Presets" bind:value={chosen} onchange={apply}>
    <option value="">Choose a preset…</option>
    {#each all as preset, at (preset.slug ?? preset.name)}
      <option value={String(at)}>{preset.name}{preset.template ? ' (template)' : ''}</option>
    {/each}
  </SelectBox>
  <div class="save">
    <div class="name">
      <TextInput
        bind:value={name}
        placeholder="Name this preset"
        aria-label="Preset name"
        autocomplete="off"
      />
    </div>
    <Button disabled={!name.trim()} onclick={() => void save()}>Save these settings as a preset</Button>
  </div>
  <Note as="span" live>{message}</Note>
</div>

<style>
  .presets {
    display: grid;
    grid-column: 1 / -1;
    gap: var(--s-8);
  }
  b {
    font-size: var(--t14);
    font-weight: 500;
  }
  .save {
    --name-basis: 200px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
  .name {
    flex: 1 1 var(--name-basis);
  }
</style>
