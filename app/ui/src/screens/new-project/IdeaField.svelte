<!-- An optional project name with Improve my brief at the right edge, then the one thing needed: what the video is
     about. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import { useNewProject } from './context';
  import TextInput from './TextInput.svelte';

  const project = useNewProject();
  const { form, live } = project;
  const id = $props.id();

  let idea = $state<HTMLTextAreaElement>();

  onMount(() => project.registerFocus('idea', () => idea?.focus()));
</script>

<div class="field">
  <div class="top">
    <div class="name">
      <label for="{id}-title">Project name</label>
      <div class="title">
        <TextInput
          id="{id}-title"
          value={form.title}
          maxlength={80}
          readonly={project.busy}
          autocomplete="off"
          placeholder="Left empty, Mortiflix names it"
          oninput={(value) => form.setTitle(value)}
        />
      </div>
    </div>
    <div class="actions">
      {#if project.restored && !project.busy}
        <Button size="sm" variant="text" onclick={() => project.blank()}>Start a blank brief</Button>
      {/if}
      <Button size="sm" disabled={live.improving || !form.idea.trim()} onclick={() => void live.improve()}
        >{live.improving ? 'Reading your brief…' : 'Improve my brief'}</Button
      >
    </div>
  </div>
  <label class="ask" for="{id}-idea">What should your video be about?</label>
  <textarea
    bind:this={idea}
    id="{id}-idea"
    class="idea"
    value={form.idea}
    readonly={project.busy}
    autocomplete="off"
    placeholder={'For example: “How heat pumps work, for homeowners deciding this year. They should leave knowing the one number to ask installers for.”'}
    oninput={(event) => form.setIdea(event.currentTarget.value)}></textarea>
</div>

<style>
  .field {
    display: grid;
    gap: var(--s-8);
  }
  label {
    color: var(--muted);
    font-size: var(--t13);
  }
  .top {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: start;
    gap: var(--s-12);
    margin-bottom: var(--s-24);
  }
  .ask {
    font-size: var(--t20);
    text-align: center;
  }
  .idea {
    --idea-min: 140px;
    width: 100%;
    min-height: var(--idea-min);
    padding: var(--s-12) var(--s-16);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: var(--ink-2);
    color: var(--text);
    font: inherit;
    font-size: var(--t16);
    line-height: 1.5;
    resize: vertical;
  }
  .idea:focus-visible {
    outline: none;
    border-color: var(--link);
  }
  .idea::placeholder {
    color: var(--faint);
  }
  .idea[readonly] {
    opacity: 0.7;
  }
  .name {
    grid-column: 2;
    display: flex;
    align-items: center;
    gap: var(--s-12);
  }
  .title {
    --box-h: var(--h-sm);
    width: var(--field-w);
    min-width: 0;
  }
  .actions {
    grid-column: 3;
    justify-self: end;
    display: flex;
    align-items: center;
    gap: var(--s-12);
    margin-top: calc(-1 * var(--s-16));
  }
  /* no room beside the name: the buttons go centered under it */
  @media (max-width: 1199px) {
    .top {
      grid-template-columns: minmax(0, 1fr);
    }
    .name,
    .actions {
      grid-column: 1;
      justify-self: center;
    }
    .name {
      flex-wrap: wrap;
      justify-content: center;
      width: 100%;
    }
    .title {
      max-width: 100%;
    }
    .actions {
      margin-top: 0;
    }
  }
  @media (max-height: 800px) {
    .idea {
      --idea-min: 110px;
    }
  }
</style>
