<!-- "Use this look" (look.use): the frame on view becomes the look in use. Asked without `confirm` first; when shots
     were made in another look the service lists them and nothing changes until the owner confirms (each is then
     remade in this look, versions kept). -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import type { Caller } from '../../lib/stage-tools.svelte';
  import { useService } from '../../lib/stores/context';
  import { plural } from '../../lib/words';

  interface Props {
    frame: string;
    /** The frame's name, as the screen shows it. */
    name: string;
    onclose: () => void;
    /** Default: the service. */
    service?: Caller;
  }

  let { frame, name, onclose, service }: Props = $props();

  interface Shot {
    id: string;
    label?: string;
    title?: string;
  }
  interface UseAnswer {
    needs_confirm?: boolean;
    changed?: boolean;
    remake?: Shot[];
    remaking?: { node: string }[];
  }

  const fallback = useService();
  // svelte-ignore state_referenced_locally
  const client: Caller = service ?? fallback;
  let asking = $state<Shot[] | null>(null);
  let said = $state('');
  let failed = $state('');
  let busy = $state(false);

  onMount(() => void use(false));

  async function use(confirm: boolean) {
    busy = true;
    failed = '';
    try {
      const answer = await client.call<UseAnswer>('look.use', {
        frame,
        ...(confirm ? { confirm: true } : {}),
      });
      if (answer.needs_confirm) asking = answer.remake ?? [];
      else {
        asking = null;
        const remade = answer.remaking?.length ?? 0;
        said = answer.changed
          ? `${name} is the look in use now.${remade ? ` Remaking ${plural(remade, 'shot')} in it.` : ''}`
          : `${name} is already the look in use.`;
      }
    } catch (error) {
      failed = error instanceof Error ? error.message : 'unknown error';
    }
    busy = false;
  }
</script>

<div class="use">
  {#if failed}
    <p class="bad" role="alert">Not changed: {failed}</p>
  {:else if asking}
    <p>
      {plural(asking.length, 'shot')}
      {asking.length === 1 ? 'was' : 'were'} made in another look. Using
      <b>{name}</b> remakes {asking.length === 1 ? 'it' : 'each'} in this look (older versions are kept).
    </p>
    <ul>
      {#each asking as shot (shot.id)}<li>
          {shot.label ?? shot.id}{shot.title ? ` · ${shot.title}` : ''}
        </li>{/each}
    </ul>
    <div class="row">
      <Button variant="primary" disabled={busy} onclick={() => use(true)}
        >{busy ? 'Saving…' : `Use ${name} and remake them`}</Button
      >
      <Button variant="text" onclick={onclose}>Keep the look in use</Button>
    </div>
  {:else if said}
    <StatusMark size="md" mark="ok" text={said} />
  {:else}
    <StatusMark mark="busy" text="Checking what changes…" />
  {/if}
</div>

<style>
  .use {
    display: grid;
    gap: var(--s-12);
    max-width: var(--reading);
  }
  ul {
    display: grid;
    gap: var(--s-4);
    padding-left: var(--s-16);
  }
  .row {
    display: flex;
    gap: var(--s-12);
    align-items: center;
  }
  .row :global(button) {
    white-space: nowrap;
    flex-shrink: 0;
  }
  .bad {
    color: var(--bad);
  }
</style>
