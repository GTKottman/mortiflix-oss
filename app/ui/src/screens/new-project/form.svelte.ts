import {
  applyPreset,
  resetField,
  resetSection,
  setByPath,
  setParts,
  setValue,
  toContract,
  withoutDecided,
  DECIDE_KEYS,
  valueOf,
  type BriefParts,
} from './brief';
import type { BriefSchema, DecideLater, SchemaField, SchemaSection, Settings, Value } from './types';

// What the owner has written and chosen so far. Every change goes through here so the draft, the live brief and the
// backup hear about it once.

export class BriefForm {
  idea = $state('');
  title = $state('');
  settings = $state<Settings>({});
  decideLater = $state<DecideLater | null>(null);
  /** Paths the owner accepted from Claude's suggestions. */
  suggested = $state<string[]>([]);
  /** The owner switched "Decide later" off by hand. */
  decideLaterOff = $state(false);
  /** Which accordions are open, by section id. */
  open = $state<Record<string, boolean>>({});
  schema = $state<BriefSchema | null>(null);
  readonly #onchange: () => void;

  constructor(onchange: () => void) {
    this.#onchange = onchange;
  }

  /** Every schema field by path. */
  readonly fields = $derived<Record<string, SchemaField>>(
    Object.fromEntries((this.schema?.sections ?? []).flatMap((s) => s.fields.map((f) => [f.id, f]))),
  );

  get quick(): readonly string[] {
    return this.schema?.quick ?? [];
  }

  /** The shape the video is designed for: the first of the aspect ratios. */
  get mainShape(): string {
    const field = this.fields['delivery.aspects'];
    const shapes = field ? valueOf(field, this.settings) : null;
    return Array.isArray(shapes) && typeof shapes[0] === 'string' ? shapes[0] : '16:9';
  }

  /** The chosen length when the owner set one, else null (Auto). */
  get lengthSeconds(): number | null {
    const field = this.fields['delivery.duration'];
    const length = field ? valueOf(field, this.settings) : null;
    if (typeof length !== 'object' || length === null || Array.isArray(length)) return null;
    return length['mode'] === 'manual' && typeof length['seconds'] === 'number' && length['seconds']
      ? length['seconds']
      : null;
  }

  get manualLength(): boolean {
    const field = this.fields['delivery.duration'];
    const length = field ? valueOf(field, this.settings) : null;
    return (
      typeof length === 'object' && length !== null && !Array.isArray(length) && length['mode'] === 'manual'
    );
  }

  /** The pieces of the brief; the tray adds its source ids. */
  parts(sourceIds: string[]): BriefParts {
    return {
      idea: this.idea,
      title: this.title,
      settings: this.settings,
      decideLater: this.decideLater,
      suggested: this.suggested,
      sourceIds,
    };
  }

  contract(sourceIds: string[]): Record<string, Value> {
    return toContract(this.parts(sourceIds));
  }

  /** Puts a saved brief (draft or backup) back on screen. */
  load(parts: Omit<BriefParts, 'sourceIds'>): void {
    this.idea = parts.idea;
    this.title = parts.title;
    this.settings = parts.settings;
    this.decideLater = parts.decideLater;
    this.suggested = parts.suggested;
  }

  clear(): void {
    this.load({ idea: '', title: '', settings: {}, decideLater: null, suggested: [] });
    this.decideLaterOff = false;
  }

  setIdea(text: string): void {
    this.idea = text;
    this.#onchange();
  }

  setTitle(text: string): void {
    this.title = text;
    this.#onchange();
  }

  set(field: SchemaField, value: Value): void {
    this.#edit(field.id, setValue(this.settings, field, value));
  }

  setPart(field: SchemaField, part: string, value: Value): void {
    this.#edit(field.id, setParts(this.settings, field, { [part]: value }));
  }

  /** Several parts at once, e.g. Set a length = mode and seconds. */
  setParts(field: SchemaField, parts: { [part: string]: Value }): void {
    this.#edit(field.id, setParts(this.settings, field, parts));
  }

  reset(field: SchemaField): void {
    this.settings = resetField(this.settings, field);
    this.#onchange();
  }

  resetSection(section: SchemaSection): void {
    this.settings = resetSection(this.settings, section, this.quick);
    if (section.id === 'voice') this.decideLater = null;
    this.#onchange();
  }

  /** A conflict fix or an accepted suggestion. */
  setByPath(path: string, value: Value): void {
    this.settings = setByPath(this.settings, this.fields, path, value);
    this.#onchange();
  }

  accept(path: string, value: Value): void {
    this.settings = setByPath(this.settings, this.fields, path, value);
    if (!this.suggested.includes(path)) this.suggested = [...this.suggested, path];
    this.#onchange();
  }

  apply(preset: { [key: string]: Value }): void {
    this.settings = applyPreset(this.settings, this.fields, preset);
    const later = preset['decide_later'];
    if (typeof later === 'object' && later !== null && !Array.isArray(later))
      this.decideLater = later as DecideLater;
    else
      this.decideLater = DECIDE_KEYS.reduce(
        (next, key) =>
          this.settings['voice']?.[key] !== undefined ? withoutDecided(next, `voice.${key}`) : next,
        this.decideLater,
      );
    this.#onchange();
  }

  /** "Decide later" is on when chosen, or when nothing voice-related was set. */
  get decidingLater(): boolean {
    const none = !DECIDE_KEYS.some((k) => this.settings['voice']?.[k] !== undefined);
    const all = DECIDE_KEYS.every((k) => this.decideLater?.[k]);
    return !this.decideLaterOff && (none || all);
  }

  setDecideLater(on: boolean): void {
    this.decideLaterOff = !on;
    this.decideLater = on ? { voice: true, music: true, sound_design: true, pauses: true } : null;
    this.#onchange();
  }

  toggleOpen(section: string): void {
    this.open = { ...this.open, [section]: !this.open[section] };
  }

  #edit(path: string, settings: Settings): void {
    this.settings = settings;
    this.decideLater = withoutDecided(this.decideLater, path);
    this.#onchange();
  }
}
