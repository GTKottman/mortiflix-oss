<!-- Sound comes after the motion is OK'd. Until then: where things stand and the way to Motion. Once it is, the one
     free step: list the sounds from the motion and the library (nothing is spent), with how long Mortiflix has been
     listing. Motion OK'd but the service not ready to list says so, with Check again. A list that came back empty says
     so instead of offering the same button as if nothing happened. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import Elapsed from '../../lib/components/Elapsed.svelte';
  import { motionDone } from './sound';
  import type { MotionProgress } from './types';
  import type { WaitingWords } from '../../lib/review/waiting';

  interface Props {
    motion: MotionProgress | null;
    /** The motion is final and the service can list the sounds. */
    ready: boolean;
    busy: string;
    /** When the listing started; 0 while not listing. */
    listingSince: number;
    /** The last listing worked and found no sounds to list. */
    listedNone: boolean;
    onlist: () => void;
    /** Asks the service again whether it can list. */
    oncheck: () => Promise<void>;
    /** A session works on this project's Sound now (it lists the sounds itself). */
    working?: boolean;
    /** The project is queued (a slot, or a drained restart): what it waits for. */
    waits?: WaitingWords | null;
    /** The service's reason it can't list yet ('' = none given). */
    why?: string;
    /** When the service was last asked. */
    checkedAt?: number;
  }

  let {
    motion,
    ready,
    busy,
    listingSince,
    listedNone,
    onlist,
    oncheck,
    working = false,
    waits = null,
    why = '',
    checkedAt = 0,
  }: Props = $props();
  const checkedText = $derived(
    checkedAt
      ? new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '',
  );

  let checking = $state(false);

  async function check() {
    checking = true;
    await oncheck();
    checking = false;
  }
</script>

<div class="gate">
  {#if listingSince}
    <h2>Mortiflix is listing the sounds…</h2>
    <p>
      <StatusMark mark="busy" text="Listing" /> for <Elapsed since={listingSince} />. Reading the motion and
      your library; nothing is spent. The sounds appear here when the list is done.
    </p>
  {:else if ready && listedNone}
    <h2>No sounds were listed</h2>
    <p>The service read the motion and found no action that needs a sound. Nothing was spent.</p>
    <div class="action">
      <Button disabled={Boolean(busy)} onclick={onlist}>{busy || 'List again'}</Button>
      <Button href={routeHref('/motion')}>Open Motion</Button>
    </div>
  {:else if ready}
    <h2>The motion is ready for sound</h2>
    <p>Free: this only reads the motion and your library. Nothing is spent.</p>
    <div class="action">
      <Button variant="primary" disabled={Boolean(busy)} onclick={onlist}>{busy || 'List the sounds'}</Button>
    </div>
  {:else if motionDone(motion) && working}
    <h2>Mortiflix is working on the sound</h2>
    <p>
      {#if motion}<b>All {motion.total} shots are OK.</b>{/if}
      <StatusMark mark="busy" text="Working" /> The sounds appear here when the list is done.
    </p>
  {:else if motionDone(motion) && waits}
    <h2>{waits.title}</h2>
    <p>
      {#if motion}<b>All {motion.total} shots are OK.</b>{/if}
      {waits.body}
    </p>
  {:else if motionDone(motion)}
    <h2>The sounds can't be listed yet</h2>
    <p>
      {#if motion}<b>All {motion.total} shots are OK.</b>{/if}
      {why ? `The service says ${why}.` : 'The service gave no reason.'}
      {#if checkedText}Last checked {checkedText}.{/if}
    </p>
    <div class="action">
      <Button disabled={checking} onclick={check}>{checking ? 'Checking…' : 'Check again'}</Button>
      <Button href={routeHref('/motion')}>Open Motion</Button>
    </div>
  {:else}
    <h2>Sound comes after the motion is OK'd</h2>
    <p>
      {#if motion}<b>{motion.ok} of {motion.total} shots OK.</b>{/if}
      The sounds go on the story's key moments once the shots are final.
    </p>
    <div class="action"><Button href={routeHref('/motion')}>Go to Motion</Button></div>
  {/if}
</div>

<style>
  .gate {
    display: grid;
    gap: var(--s-8);
    justify-items: start;
    max-width: 72ch;
    padding: var(--s-16) 0;
  }
  h2 {
    font: 600 var(--t17) / 1.3 var(--body);
  }
  p {
    color: var(--muted);
  }
  b {
    color: var(--text);
    font-weight: 600;
  }
  .action {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
    margin-top: var(--s-8);
  }
</style>
