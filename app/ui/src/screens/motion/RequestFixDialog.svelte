<!-- Request fix: what is sent, which version it makes, what is remade, how long, and what it costs. -->
<script lang="ts">
  import { plural } from '../../lib/words';
  import Button from '../../lib/components/Button.svelte';
  import DialogFacts from './DialogFacts.svelte';
  import DialogNoteList from './DialogNoteList.svelte';
  import MotionDialog from './MotionDialog.svelte';
  import { useMotion } from './motion.svelte';

  const motion = useMotion();

  const notes = $derived(motion.unresolved);
  const fromTablet = $derived(notes.filter((note) => note.tablet).length);
  const index = $derived(motion.index);
  // the same source as the "about N min" banner: this project's median make time per scene
  const makeS = $derived(motion.list?.make_s ?? motion.scene?.eta_s ?? null);
  const eta = $derived(
    makeS != null
      ? `About ${Math.max(1, Math.round(makeS / 60))} min`
      : 'Not known yet: no scene in this project has been timed.',
  );
  const remade = $derived(
    index + 1 < motion.total
      ? `Scene ${index + 1} only. Scenes ${index + 2}–${motion.total} stay waiting until you approve it.`
      : `Scene ${index + 1} only.`,
  );
  const rows = $derived([
    {
      term: 'Notes sent',
      detail: `${plural(notes.length, 'note')} (${fromTablet ? `${fromTablet} from the tablet` : 'all from this screen'})`,
    },
    {
      term: 'Version',
      detail: `Version ${motion.latest} stays. This makes Version ${motion.latest + 1}.`,
    },
    { term: 'Regenerates', detail: remade },
    { term: 'Wait', detail: eta },
    { term: 'Cost', detail: 'No ElevenLabs credits. It uses your Claude plan.' },
  ]);
</script>

<MotionDialog title={`Request fix: scene ${index + 1}`} onclose={() => (motion.dialog = null)}>
  <DialogFacts {rows} />
  <DialogNoteList {notes} ranges />
  {#snippet actions(close)}
    <Button onclick={close}>Cancel</Button>
    <Button
      variant="primary"
      onclick={() => {
        close();
        void motion.sendFix();
      }}>Send {plural(notes.length, 'note')}</Button
    >
  {/snippet}
</MotionDialog>
