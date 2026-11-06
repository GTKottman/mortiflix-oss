<!-- Note tools under the picture: Mark the frame, Speak, a typed note (Enter keeps it, Shift+Enter starts a new
     line), and the tablet pill. Notes are one-shot instructions kept until Fix. -->
<script lang="ts">
  import { useProblems } from '../stores/context';
  import { keepsNote } from '../review/keys';
  import { tabletTag } from '../review/logic';
  import { saveNote } from '../review/notes';
  import { noteBoxId, type ReviewSession } from '../review/session.svelte';
  import type { ReviewItem, ReviewService, VideoNotesStatus } from '../review/types';
  import Button from './Button.svelte';
  import { markColour } from '../review/mark-colour';
  import MarkDialog from './MarkDialog.svelte';
  import TabletPill from './TabletPill.svelte';

  interface Props {
    item: ReviewItem;
    session: ReviewSession;
    service: ReviewService;
    videoNotes: VideoNotesStatus | null;
    /** Why the tools are off, shown as the tooltip. */
    disabledWhy?: string;
    /** A note was saved: reload the piece. */
    onsaved: () => void;
  }

  let { item, session, service, videoNotes, disabledWhy = '', onsaved }: Props = $props();

  const problems = useProblems();
  const off = $derived(Boolean(disabledWhy) || !item.path || item.state === 'ok');
  const tablet = $derived(tabletTag(item.tablet, videoNotes));
  let marking = $state<{ record: boolean } | null>(null);
  /** "SF03 · Slip gag hook" -> "SF03": the note box names the piece it is for. */
  const shortName = (label: string): string => label.split(' · ')[0] ?? label;
  let saving = $state(false);

  /** Enter keeps the note; Shift+Enter is a new line; Enter while an input method composes a word is the IME's. */
  async function keep(event: KeyboardEvent) {
    if (!keepsNote(event)) return;
    event.preventDefault();
    const id = item.id;
    const text = (session.typed[id] ?? '').trim();
    if (!text || saving) return;
    saving = true;
    // out of the box at once: a Fix pressed while this saves (the lesson call takes seconds) must not send the words again
    session.typed[id] = '';
    try {
      // words only: no picture is sent (marks come from Mark the frame), so a picture that will not load never blocks a note
      await saveNote(service, { node: item.id, path: '', text }, markColour());
      problems.clear('note-save');
      onsaved();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      if (!session.typed[id]) session.typed[id] = text;
      problems.raise({
        id: 'note-save',
        kind: 'warn',
        text: `The note was not saved: ${reason}. It is still in the box.`,
      });
    }
    saving = false;
  }
</script>

<div class="tools">
  <Button
    size="sm"
    disabled={off}
    title={off ? disabledWhy : undefined}
    onclick={() => (marking = { record: false })}>✎ Mark the frame</Button
  >
  <Button size="sm" disabled={off} onclick={() => (marking = { record: true })}>● Speak</Button>
  <textarea
    id={noteBoxId(item.id)}
    class="type"
    rows="1"
    placeholder={`Note for ${shortName(item.label)}: type it, press Enter (Shift+Enter: new line) · kept until Fix`}
    aria-label={`Note for ${item.label}`}
    disabled={off || saving}
    bind:value={session.typed[item.id]}
    onkeydown={keep}
  ></textarea>
  {#if tablet}<TabletPill tag={tablet} />{/if}
</div>

{#if marking}
  <MarkDialog
    {service}
    node={item.id}
    path={item.path}
    title={`Mark what is wrong on ${item.label}`}
    record={marking.record}
    {onsaved}
    onclose={() => (marking = null)}
  />
{/if}

<style>
  .tools {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    flex-wrap: wrap;
  }
  .type {
    flex: 1;
    min-width: var(--note-field-min-w);
    min-height: var(--h-sm);
    max-height: calc(var(--h-sm) * 4);
    field-sizing: content;
    resize: none;
    padding: var(--s-4) var(--s-12);
    line-height: 1.4;
    color: inherit;
    font-family: inherit;
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: var(--ink-2);
    font-size: var(--t13);
  }
  .type:focus-visible {
    outline: none;
    border-color: var(--link);
  }
  .type:disabled {
    opacity: 0.5;
  }
</style>
