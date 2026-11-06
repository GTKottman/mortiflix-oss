<!-- A Script-stage step (the brief, or the script before any scene shows) waits for the owner's OK: what Claude wrote,
     each question with its choices, the suggested answer and room for the owner's own answer, then OK (the screen's
     gradient button) or Fix, which sends this version back with the typed words (review.respond). -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import DoneNote from '../../lib/components/DoneNote.svelte';
  import type { StepState } from '../../lib/service/types';
  import { withoutKey, type BriefQuestion } from './brief';
  import { versionKey, type BriefStore } from './brief.svelte';

  interface Props {
    brief: BriefStore;
    step: StepState;
  }

  let { brief, step }: Props = $props();

  let fixing = $state(false);
  let words = $state('');
  /** Questions where the owner is typing an own answer. */
  let own = $state<Record<string, boolean>>({});

  const isBrief = $derived(step.key === 'brief');
  const what = $derived(isBrief ? 'brief' : step.name.toLowerCase());
  const okSent = $derived(brief.okSentFor === versionKey(step));
  const busy = $derived(brief.sending !== null);

  function pick(question: BriefQuestion, choice: string) {
    own[question.id] = false;
    brief.picked[question.id] = choice;
  }

  function openOwn(question: BriefQuestion) {
    own[question.id] = true;
    brief.picked = withoutKey(brief.picked, question.id);
  }

  function typeAnswer(question: BriefQuestion, text: string) {
    if (text.trim()) brief.picked[question.id] = text.trim();
    else brief.picked = withoutKey(brief.picked, question.id);
  }

  async function sendFix() {
    if (await brief.fix(step, words)) {
      fixing = false;
      words = '';
    }
  }
</script>

<section class="brief" aria-labelledby="brief-title">
  <h2 id="brief-title">The {what} is waiting for your OK</h2>
  <p class="lead">
    {isBrief
      ? 'Mortiflix wrote this from your idea. The script starts once you say OK.'
      : `Mortiflix wrote the ${what}. The next stage starts once you say OK.`}
  </p>

  {#if brief.loadError}
    <p class="error" role="alert">Couldn't read the {what}: {brief.loadError}</p>
  {:else if !brief.loaded}
    <p class="lead" role="status">Reading the {what}…</p>
  {:else if brief.note}
    <p class="note">{brief.note}</p>
  {/if}

  {#if brief.questions.length > 0}
    <h3>Questions, with the answer Mortiflix will use</h3>
    <ol class="questions">
      {#each brief.questions as question (question.id)}
        {@const answer = brief.picked[question.id] ?? question.default}
        <li>
          <b>{question.text}</b>
          <div class="choices" role="group" aria-label={question.text}>
            {#each question.choices ?? [] as choice (choice)}
              <Button
                size="sm"
                variant="secondary"
                pressed={!own[question.id] && answer === choice}
                disabled={busy || okSent}
                onclick={() => pick(question, choice)}
                >{choice}{choice === question.default ? ' (suggested)' : ''}</Button
              >
            {/each}
            {#if !question.choices && question.default}
              <Button
                size="sm"
                variant="secondary"
                pressed={!own[question.id]}
                disabled={busy || okSent}
                onclick={() => pick(question, question.default ?? '')}>Suggested: {question.default}</Button
              >
            {/if}
            <Button
              size="sm"
              variant="secondary"
              pressed={own[question.id] === true}
              disabled={busy || okSent}
              onclick={() => openOwn(question)}>Own answer</Button
            >
          </div>
          {#if own[question.id]}
            <input
              type="text"
              aria-label={`Your answer: ${question.text}`}
              placeholder={question.default ? `Empty = ${question.default}` : 'Type your answer'}
              disabled={busy || okSent}
              oninput={(event) => typeAnswer(question, event.currentTarget.value)}
            />
          {:else if answer == null}
            <span class="missing">Needs your answer: pick Own answer and type it.</span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  {#if fixing}
    <label class="fix">
      <span class="kicker">What should change?</span>
      <textarea bind:value={words} rows="3" placeholder="Say it in your own words"></textarea>
      <span class="hint">Sends this {what} back with your words. Mortiflix writes a new one.</span>
    </label>
  {/if}
  <div class="actions">
    {#if fixing}
      <Button variant="primary" disabled={!words.trim() || busy} onclick={sendFix}
        >{brief.sending === 'fix' ? 'Sending…' : 'Send back'}</Button
      >
      <Button variant="text" disabled={busy} onclick={() => (fixing = false)}>Cancel</Button>
    {:else}
      <Button variant="primary" disabled={!brief.canOk || busy || okSent} onclick={() => brief.ok(step)}
        >{brief.sending === 'ok' ? 'Sending…' : 'OK'}</Button
      >
      <Button variant="secondary" disabled={busy || okSent} onclick={() => (fixing = true)}>Fix</Button>
    {/if}
  </div>
  {#if okSent}<p class="lead" role="status">OK sent. Mortiflix goes on by itself now.</p>{/if}
  {#if brief.error}<p class="error" role="alert">Not sent: {brief.error}</p>{/if}
  {#if brief.fixSent}<DoneNote text="Sent back with your words" ondone={() => (brief.fixSent = false)} />{/if}
</section>

<style>
  .brief {
    display: grid;
    gap: var(--s-12);
    max-width: var(--reading);
    padding: var(--s-16) 0 var(--s-16) var(--s-16);
    border-left: 2px solid var(--busy);
  }
  h2 {
    font: 600 var(--t17) / 1.3 var(--body);
  }
  h3,
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
    white-space: nowrap;
  }
  h3 {
    margin-top: var(--s-8);
  }
  .lead,
  .hint {
    color: var(--muted);
  }
  .hint {
    font-size: var(--t13);
  }
  .note {
    white-space: pre-wrap;
    line-height: 1.6;
  }
  .questions {
    display: grid;
    gap: var(--s-16);
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    gap: var(--s-8);
  }
  .choices,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
  .actions {
    margin-top: var(--s-8);
  }
  .missing {
    color: var(--warn);
  }
  .fix {
    display: grid;
    gap: var(--s-4);
  }
  input,
  textarea {
    padding: var(--s-8) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink);
    color: var(--text);
    font: 400 var(--t16) / 1.6 var(--body);
  }
  textarea {
    resize: vertical;
  }
  input:focus,
  textarea:focus {
    border-color: var(--text);
    outline: var(--focus);
  }
  .error {
    color: var(--warn);
  }
</style>
