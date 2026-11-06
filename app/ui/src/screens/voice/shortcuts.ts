// What each screen key does to the model: the keys themselves are decided by keys.ts.
import { CUE_PROMPT_FIELD, keyAction, TONE_TAG_FIELD } from './keys';
import type { VoiceModel } from './model.svelte';

/** Waits for the inspector to draw before the field is focused. */
const FOCUS_DELAY_MS = 30;

function approveSelected(model: VoiceModel) {
  const line = model.lineById(model.selectedLine);
  const cue = model.music.cue(model.selectedCue ?? null);
  if (line?.path && line.state !== 'approved') void model.approve(line);
  else if (cue?.path && cue.state !== 'ok' && cue.state !== 'stale') void model.music.approve(cue.id);
}

function focusFix(model: VoiceModel) {
  const id = model.selectedLine ? TONE_TAG_FIELD : CUE_PROMPT_FIELD;
  setTimeout(() => document.getElementById(id)?.focus(), FOCUS_DELAY_MS);
}

export function runKey(model: VoiceModel, event: KeyboardEvent): void {
  const selected = Boolean(model.selectedLine || model.selectedCue);
  const action = keyAction(event, selected);
  if (!action) return;
  event.preventDefault();
  if (action === 'approve') approveSelected(model);
  else if (action === 'fix') focusFix(model);
  else if (action === 'next') model.goToIssue(1);
  else if (action === 'play') model.playSelection();
  else if (action === 'earlier') model.step(-1);
  else if (action === 'later') model.step(1);
  else if (selected) model.deselect();
  else model.issuesOpen = false;
}
