<!-- Who plays whom: a row per character (hear it, its numbers, change its voice, open its settings) and
     "+ Add a character". Changing a voice or setting queues the character's lines for a new read; it never spends. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import AddCharacterForm from './AddCharacterForm.svelte';
  import CastSettingsForm from './CastSettingsForm.svelte';
  import VoicePicker from './VoicePicker.svelte';
  import { roleName } from './roles';
  import type { VoiceModel } from './model.svelte';

  interface Props {
    model: VoiceModel;
  }

  let { model }: Props = $props();

  let openRole = $state<string | null>(null);
  let pickingRole = $state<string | null>(null);

  const two = (value: number | undefined) => (value == null ? '—' : value.toFixed(2));
  const firstLine = (role: string) => model.lines.find((l) => l.path && model.roleOf(l.node) === role);

  async function use(role: string, voice: Parameters<typeof model.useVoice>[1]) {
    if (await model.useVoice(role, voice)) pickingRole = null;
  }
</script>

{#if !model.cast.ready}
  <EmptyState title="The cast could not load" body={model.cast.failure ?? 'The service sent no cast.'}>
    {#snippet action()}<Button size="sm" onclick={() => model.cast.load()}>Try again</Button>{/snippet}
  </EmptyState>
{:else}
  <div class="cast">
    {#if model.cast.note}
      {@const note = model.cast.note}
      <p class="note">
        <b>{note.text}</b>
        <Button size="sm" variant="text" onclick={() => model.undoCast()}>Undo</Button>
      </p>
    {/if}
    {#each model.cast.members as member (member.role)}
      {@const line = firstLine(member.role)}
      {@const name = `${roleName(member.role)}${member.name ? ` · ${member.name}` : ''}`}
      <div class="row">
        <button
          type="button"
          class="play"
          aria-label="Hear {name}"
          disabled={!line}
          onclick={() => line && model.player.playLine(line)}>▶</button
        >
        <button
          type="button"
          class="who"
          aria-expanded={openRole === member.role}
          aria-label="{name}: show its settings"
          onclick={() => (openRole = openRole === member.role ? null : member.role)}
        >
          <b>{name}</b>
          <span class="nums">
            <span>Stability <i>{two(member.settings?.stability)}</i></span>
            <span>Similarity <i>{two(member.settings?.similarity_boost)}</i></span>
            <span>Style <i>{two(member.settings?.style)}</i></span>
            <span
              ><i class:changed={member.gain_db}
                >{(member.gain_db ?? 0) > 0 ? '+' : ''}{(member.gain_db ?? 0).toFixed(1)} dB</i
              ></span
            >
          </span>
        </button>
        <Button
          size="sm"
          variant="text"
          aria-expanded={pickingRole === member.role}
          onclick={() => (pickingRole = pickingRole === member.role ? null : member.role)}
        >
          Change voice
        </Button>
      </div>
      {#if pickingRole === member.role}
        <VoicePicker {model} currentId={member.voice_id} onuse={(voice) => use(member.role, voice)} />
      {/if}
      {#if openRole === member.role}<CastSettingsForm {model} {member} />{/if}
    {/each}
    {#if model.addingCharacter}
      <AddCharacterForm {model} oncancel={() => (model.addingCharacter = false)} />
    {:else}
      <div class="add">
        <Button size="sm" variant="text" onclick={() => (model.addingCharacter = true)}
          >+ Add a character</Button
        >
      </div>
    {/if}
  </div>
{/if}

<style>
  .cast {
    display: grid;
  }
  .note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    padding: var(--s-4) 0 var(--s-8);
    color: var(--muted);
    font-size: var(--t12);
  }
  .note b {
    color: var(--text);
    font-weight: 500;
  }
  .row {
    display: grid;
    grid-template-columns: var(--h-sm) minmax(0, 1fr) auto;
    gap: var(--s-12);
    align-items: center;
    min-height: var(--h-lg);
    padding: var(--s-4) 0;
    border-top: 1px solid var(--line);
  }
  .play {
    width: var(--h-sm);
    height: var(--h-sm);
    padding-left: var(--s-2);
    border: 1px solid var(--line-2);
    border-radius: 50%;
    background: transparent;
    font-size: var(--t12);
    cursor: pointer;
  }
  .play:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .who {
    display: grid;
    gap: var(--s-2);
    min-width: 0;
    padding: var(--s-4) 0;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .who b {
    overflow: hidden;
    font-size: var(--t14);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nums {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-12);
    color: var(--muted);
    font-size: var(--t12);
    font-variant-numeric: tabular-nums;
    line-height: 1.3;
  }
  .nums span {
    white-space: nowrap;
  }
  .nums i {
    color: var(--text);
    font-style: normal;
  }
  .nums i.changed {
    color: var(--warn);
  }
  .row :global(button) {
    flex-shrink: 0;
  }
  .add {
    padding: var(--s-8) 0;
    border-top: 1px solid var(--line);
  }
</style>
