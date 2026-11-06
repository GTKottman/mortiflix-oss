<!-- How long? Auto (the default) or a length typed in seconds or minutes, with what that means in spoken words. -->
<script lang="ts">
  import { conflictsAt, pacingOf, scenesAbout, spokenWordsAbout } from './brief';
  import ChipChoice from './ChipChoice.svelte';
  import ConflictNote from './ConflictNote.svelte';
  import { useNewProject } from './context';
  import Note from './Note.svelte';
  import SelectBox from './SelectBox.svelte';
  import TextInput from './TextInput.svelte';

  const { form, live } = useNewProject();
  const id = $props.id();

  const durationField = $derived(form.fields['delivery.duration']);
  const pacing = $derived(pacingOf(form.fields, form.settings));

  let amount = $state('');
  let unit = $state<'s' | 'm'>('s');
  let editing = $state(false);
  let amountInput = $state<HTMLInputElement>();
  /** What is typed is outside 5 seconds to 60 minutes, so the brief keeps its last good length. */
  let outOfRange = $state(false);

  const MIN_SECONDS = 5;
  const MAX_SECONDS = 3600;

  // The length box follows the brief unless the owner is typing in it. A length the box already shows keeps
  // its unit: 60 typed as seconds stays "60 seconds", never "1 minutes".
  $effect(() => {
    if (!form.manualLength || editing) return;
    const seconds = form.lengthSeconds ?? 0;
    if (amount !== '' && Math.round(Number(amount) * (unit === 'm' ? 60 : 1)) === seconds) return;
    const whole = seconds >= 60 && seconds % 60 === 0;
    unit = whole ? 'm' : 's';
    amount = String(whole ? seconds / 60 : seconds);
  });

  function pickMode(mode: string | number) {
    if (!durationField) return;
    if (mode === 'auto') form.reset(durationField);
    else if (!form.manualLength) {
      form.setParts(durationField, { mode: 'manual', seconds: 180 });
      amountInput?.focus();
    }
  }

  function setLength() {
    const seconds = Math.round(Number(amount) * (unit === 'm' ? 60 : 1));
    outOfRange = !(seconds >= MIN_SECONDS && seconds <= MAX_SECONDS);
    if (durationField && !outOfRange) form.setParts(durationField, { mode: 'manual', seconds });
  }

  /** A new unit keeps the length: 3 minutes becomes 180 seconds, not 3 seconds. */
  function changeUnit(next: 's' | 'm') {
    const typed = Number(amount);
    if (amount !== '' && Number.isFinite(typed) && next !== unit) {
      const seconds = typed * (unit === 'm' ? 60 : 1);
      amount = String(next === 'm' ? Math.round((seconds / 60) * 100) / 100 : Math.round(seconds));
    }
    unit = next;
    setLength();
  }

  const note = $derived.by(() => {
    if (!form.manualLength) {
      return '';
    }
    const seconds = form.lengthSeconds;
    if (!seconds || outOfRange) return 'Enter a length from 5 seconds to 60 minutes.';
    return `About ${spokenWordsAbout(seconds, pacing)} spoken words at a ${pacing} pace, about ${scenesAbout(seconds)} scenes.`;
  });
</script>

<div class="field">
  <span id="{id}-length" class="label">Length</span>
  <ChipChoice
    label="Length"
    value={form.manualLength ? 'manual' : 'auto'}
    choices={[
      { value: 'auto', label: 'Auto' },
      { value: 'manual', label: 'Set a length' },
    ]}
    onpick={pickMode}
  />
  {#if form.manualLength}
    <div class="amount" role="group" aria-labelledby="{id}-length">
      <div class="number">
        <TextInput
          bind:element={amountInput}
          bind:value={amount}
          type="number"
          min={unit === 'm' ? 1 : MIN_SECONDS}
          max={unit === 'm' ? MAX_SECONDS / 60 : MAX_SECONDS}
          step="1"
          aria-label="Length"
          oninput={setLength}
          onfocus={() => (editing = true)}
          onblur={() => {
            editing = false;
            outOfRange = false;
          }}
        />
      </div>
      <div class="unit">
        <SelectBox
          value={unit}
          aria-label="Unit"
          onchange={(value) => changeUnit(value === 'm' ? 'm' : 's')}
          onfocus={() => (editing = true)}
          onblur={() => (editing = false)}
        >
          <option value="s">seconds</option>
          <option value="m">minutes</option>
        </SelectBox>
      </div>
    </div>
  {/if}
  {#if note}<Note>{note}</Note>{/if}
  {#each conflictsAt(live.conflicts, 'delivery.duration') as conflict (conflict.id)}<ConflictNote
      {conflict}
    />{/each}
</div>

<style>
  /* the small chips sit level with the middle of the drop-down beside them */
  .field {
    display: grid;
    gap: var(--s-4);
    align-content: start;
    justify-items: center;
    padding-top: var(--s-8);
    text-align: center;
  }
  .label {
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .amount {
    --number-w: 120px;
    --unit-w: 140px;
    display: flex;
    gap: var(--s-8);
  }
  .number {
    width: var(--number-w);
  }
  .unit {
    width: var(--unit-w);
  }
</style>
