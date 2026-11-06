<!-- Claude's rewrite options, with a plain switch saying whether a rewrite changes this scene or the whole script. -->
<script lang="ts">
  import OptionsList from '../../lib/components/OptionsList.svelte';
  import OptionsRow from '../../lib/components/OptionsRow.svelte';
  import { FIXTURE_OPTIONS } from './fixtures';
  import { useScript, type Scope } from './script.svelte';
  import ToggleGroup from '../../lib/components/ToggleGroup.svelte';

  const script = useScript();
  const scene = $derived(script.scope === 'scene' ? script.selectedBeat : null);
  const scopes = $derived<readonly { id: Scope; label: string }[]>([
    { id: 'scene', label: scene ? `This scene (${scene.no})` : 'This scene' },
    { id: 'all', label: 'Whole script' },
  ]);
</script>

<div class="rewrite">
  <span class="scope">
    Rewrite applies to
    <ToggleGroup
      small
      items={scopes}
      value={script.scope}
      label="What a rewrite changes"
      onpick={(scope) => (script.scope = scope)}
    />
  </span>
  <div class="options" data-rewrite-options>
    {#if script.isFixture}
      <OptionsList
        options={FIXTURE_OPTIONS(scene !== null)}
        targetLabel={scene ? `scene ${scene.no}` : undefined}
        run={async () => ({ does: 'Done (fixture).' })}
        answer={async () => undefined}
      />
    {:else}
      <OptionsRow
        stage="script"
        target={scene?.id}
        targetLabel={scene ? `scene ${scene.no}` : undefined}
        onrun={() => void script.load()}
      />
    {/if}
  </div>
</div>

<style>
  .rewrite {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-8) var(--s-16);
  }
  .options {
    flex: 1 1 360px;
  }
  .scope {
    display: inline-flex;
    flex-shrink: 0;
    white-space: nowrap;
    align-items: center;
    gap: var(--s-8);
    color: var(--faint);
    font-size: var(--t13);
  }
</style>
