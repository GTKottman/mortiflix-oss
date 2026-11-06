<!-- Approve: always asked first. The next scene is usually already made or being made ahead, so the owner goes straight
     on; after many notes since it was started they choose whether it is remade with them (they wait). With notes that were
     never sent it says what approving does with them. showModal() focuses the first button (MDN <dialog>: "focus is set
     on the first nested focusable element"), and that is always the safe one, so a stray Enter never approves. -->
<script lang="ts">
  import { plural } from '../../lib/words';
  import Button from '../../lib/components/Button.svelte';
  import DialogNoteList from './DialogNoteList.svelte';
  import DialogRemark from './DialogRemark.svelte';
  import MotionDialog from './MotionDialog.svelte';
  import { useMotion } from './motion.svelte';

  const motion = useMotion();

  const notes = $derived(motion.unresolved);
  const one = $derived(notes.length === 1);
  const undecided = $derived(motion.lessonsUndecided);
  const last = $derived(motion.index + 1 >= motion.total);
  const next = $derived(motion.nextScene);
  const number = $derived(motion.index + 2);
  const after = $derived.by(() => {
    if (last) return `Approving keeps Version ${motion.latest}. This is the last scene: nothing new is made.`;
    if (next?.made)
      return `Approving keeps Version ${motion.latest}, and scene ${number} is ready for you now.`;
    if (next)
      return `Approving keeps Version ${motion.latest}. Scene ${number} is being made and shows here when it is ready.`;
    return `Approving keeps Version ${motion.latest}, then scene ${number} is made with your approved lessons. That uses your Claude plan.`;
  });
</script>

<MotionDialog
  title={notes.length
    ? `Approve scene ${motion.index + 1} with unresolved notes?`
    : `Approve scene ${motion.index + 1}?`}
  onclose={() => (motion.dialog = null)}
>
  {#if notes.length}
    <DialogRemark tone="warn">
      {plural(notes.length, 'note')}
      {one ? 'has' : 'have'} not been sent for a fix. Approving keeps Version {motion.latest}, the newest, and
      keeps
      {one ? 'it' : 'them'} on file but does not change the scene.
    </DialogRemark>
    <DialogNoteList {notes} />
  {/if}
  <DialogRemark tone="quiet">{after}</DialogRemark>
  {#if next?.ask}
    <DialogRemark tone="warn">
      Scene {number} was started before your last {plural(next.notes, 'note')}. You can keep it, or remake it
      with the rules from your notes. Remaking uses your Claude plan and you wait for it.
    </DialogRemark>
  {/if}
  {#if undecided}
    <DialogRemark tone="quiet">
      {plural(undecided, 'suggested lesson')}
      {undecided === 1 ? 'is' : 'are'} still undecided and will not be used until you approve
      {undecided === 1 ? 'it' : 'them'}.
    </DialogRemark>
  {/if}
  {#snippet actions(close)}
    {#if notes.length}
      <Button
        onclick={() => {
          close();
          motion.tab = 'notes';
        }}>Review notes</Button
      >
    {:else}
      <Button onclick={close}>Cancel</Button>
    {/if}
    {#if next?.ask}
      <Button
        onclick={() => {
          close();
          void motion.approve(true);
        }}>Remake scene {number}</Button
      >
    {/if}
    <Button
      variant="primary"
      onclick={() => {
        close();
        void motion.approve();
      }}
      >{next?.ask
        ? `Keep scene ${number}`
        : notes.length
          ? 'Approve anyway'
          : `Approve scene ${motion.index + 1}`}</Button
    >
  {/snippet}
</MotionDialog>
