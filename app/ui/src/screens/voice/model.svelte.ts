// The Voice & music screen's state and actions: what the service says, what is selected, and what happens when the
// owner approves, re-reads or listens. Components read it and call it; they hold no service logic of their own.
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { bucketCount } from '../../lib/audio/waveform';
import { isNotBuiltYet, ServiceError } from '../../lib/service/client';
import { Basket } from './basket.svelte';
import { CastStore } from './cast.svelte';
import type { VoiceService } from './mock';
import { MusicStore } from './music.svelte';
import { Player } from './player.svelte';
import { rememberSelection } from './address';
import { roleId, roleName } from './roles';

import {
  cueName,
  isBad,
  isMaking,
  issuesOf,
  lineName,
  needsYou,
  scenesOf,
  stepIssue,
  type Issue,
} from './review';
import type {
  CastMember,
  LineCheck,
  MusicPlan,
  NodeListEntry,
  PeaksAnswer,
  TakeSet,
  TakeVersion,
  VoiceCheck,
  VoiceLine,
  VoiceChoice,
  VoiceList,
  VoiceView,
} from './types';

/** Error codes that mean the call never got an answer (client.ts / bridge.mjs), not that the file has no peaks. */
const LINK_DOWN = new Set(['link_lost', 'service_down', 'service_stopped']);

const RELOAD_WAIT_MS = 600;
/** A re-read that has not shown up after this long stops showing as "Making". */
const REREAD_GIVE_UP_MS = 180_000;

/** The service has no such call yet (`unknown_type`): the screen carries on without it. Any other error is a real
    one: the screen still carries on, and `failed` gets the words so they reach the Fix it strip (an error whose text
    only contains "unknown", e.g. "unknown line", is no longer taken for "not built"). */
const optional = async <T>(work: Promise<T>, what: string, failed: string[]): Promise<T | null> => {
  try {
    return await work;
  } catch (error) {
    if (!isNotBuiltYet(error)) failed.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

/** `voice.speed.get`: the voice's Length against the length chosen on New project, and its Speed. */
export interface VoicePace {
  seconds: number | null;
  chosen_sec: number | null;
  over_sec: number | null;
  speed: number;
  speeds: number[];
}

interface SentForReread {
  path: string | null;
  duration: number | undefined;
  at: number;
}

export class VoiceModel {
  view = $state<VoiceView | null>(null);
  list = $state<VoiceList | null>(null);
  check = $state<VoiceCheck | null>(null);
  pace = $state<VoicePace | null>(null);
  loadError = $state<string | null>(null);
  selectedLine = $state<string | null>(null);
  selectedCue = $state<string | null>(null);
  issuesOpen = $state(false);
  zoom = $state(1);
  /** The cast section is open, and its "add a character" form is showing. */
  castOpen = $state(false);
  addingCharacter = $state(false);
  snap = $state(true);
  readonly takes = new SvelteMap<string, TakeSet>();
  readonly peaks = new SvelteMap<string, number[]>();
  readonly #sent = new SvelteMap<string, SentForReread>();
  readonly #peaksAsked = new SvelteSet<string>();
  /** Clips whose peaks could not be read: drawn flat with "no waveform", never with an invented shape. */
  readonly noWave = new SvelteSet<string>();
  /** Per cue, its last state: a cue made again rewrites the same file (music/<cue>.mp3), so its peaks are old. */
  readonly #cueMade = new Map<string, string>();
  /** Takes of a line that could not be read: not cached, so selecting the line asks again. */
  takesError = $state<string | null>(null);
  #nodes: SvelteMap<string, NodeListEntry> | null = null;
  #reload: ReturnType<typeof setTimeout> | undefined;

  readonly service: VoiceService;
  readonly music: MusicStore;
  readonly cast: CastStore;
  readonly basket: Basket;
  readonly player: Player;

  readonly lines = $derived(this.view?.voice ?? []);
  readonly checks = $derived(new SvelteMap((this.check?.lines ?? []).map((c) => [c.id, c])));
  readonly scenes = $derived(scenesOf(this.lines));
  /** The service's own message when ElevenLabs has no key. */
  readonly noKey = $derived(this.list?.needs_key ?? null);

  constructor(
    service: VoiceService,
    initial: { line: string | null; cue: string | null; issuesOpen: boolean; project?: string | null },
  ) {
    this.service = service;
    this.selectedLine = initial.line;
    this.selectedCue = initial.cue;
    this.issuesOpen = initial.issuesOpen;
    this.music = new MusicStore(service, (plan) => this.#planChanged(plan));
    this.cast = new CastStore(service, () => this.list?.speaker);
    this.basket = new Basket({
      service,
      lines: () => this.lines,
      noKey: () => this.noKey,
      sent: (line, id) =>
        this.#sent.set(id, { path: line?.path ?? null, duration: line?.dur_sec, at: Date.now() }),
      refresh: () => this.load(),
      project: initial.project ?? null,
      creditRate: () => this.view?.credit_rate ?? null,
    });
    this.player = new Player({
      lines: () => this.lines,
      mix: () => this.music.plan?.mix,
      selectedLine: () => this.selectedLine,
      cues: () => this.music.cues,
    });
  }

  /** What needs a look, in time order. */
  get issues(): Issue[] {
    return issuesOf(
      this.lines,
      (id) => this.checks.get(id),
      (l) => this.isMaking(l),
      this.music.cues,
    );
  }

  /** Seconds the time line stands for. */
  get length(): number {
    return Math.max(
      this.view?.length_sec ?? 0,
      this.music.plan?.total_sec ?? 0,
      ...this.lines.map((l) => l.start_sec + l.dur_sec),
      1,
    );
  }

  /** The mix on file may be older than what it is made from: the service says so (`mix_stale`), else this screen
      knows of a change since it opened. */
  get mixStale(): boolean {
    return Boolean(this.music.plan?.mix) && (this.music.plan?.mix_stale ?? this.music.mixOld);
  }

  /** The screen closed or the project changed: nothing keeps playing, the queue sends nothing more. */
  dispose(): void {
    clearTimeout(this.#reload);
    this.#reload = undefined;
    this.player.stop();
    this.basket.dispose();
  }

  // ---- reading ----

  async load(): Promise<void> {
    try {
      const heard = this.#heard();
      const [view, list] = await Promise.all([
        this.service.call<VoiceView>('voicemusic.view'),
        this.service.call<VoiceList>('voice.list'),
      ]);
      // a line with no take yet (a new sentence the script got) has no times: it sits at 0 s long, never breaks a draw
      this.view = {
        ...view,
        voice: (view.voice ?? []).map((l) => ({
          ...l,
          start_sec: l.start_sec ?? 0,
          dur_sec: l.dur_sec ?? 0,
        })),
      };
      this.list = list;
      if (heard && heard !== this.#heard()) this.music.mixOld = true;
      await this.cast.load();
      const failed: string[] = [];
      this.check = await optional(this.service.call<VoiceCheck>('voice.check'), 'The word check', failed);
      this.pace = await optional(this.service.call<VoicePace>('voice.speed.get'), 'The speed', failed);
      this.player.speed = this.pace?.speed ?? 1;
      this.loadError = failed.length ? failed.join(' · ') : null;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      return;
    }
    this.#dropFinishedRereads();
    if (this.selectedLine && !this.takes.has(this.selectedLine)) void this.readTakes(this.selectedLine);
    if (!this.music.plan && !this.music.missing) void this.music.load();
  }

  /** A change somewhere else (the service says so): read again soon, once, however many changes arrive. */
  reloadSoon(): void {
    // at most RELOAD_WAIT_MS after the first change: a stream of changes (a session's activity) never pushes it back,
    // or a line stayed "Making" after its take landed until a manual reload (Dir2, 2026-11-02)
    if (this.#reload) return;
    this.#reload = setTimeout(() => {
      this.#reload = undefined;
      void this.load();
    }, RELOAD_WAIT_MS);
  }

  forgetNodes(ids: readonly string[], all: boolean): void {
    this.#nodes = null;
    if (all) this.takes.clear();
    else for (const id of ids) this.takes.delete(id);
    for (const line of this.lines) if (all || ids.includes(line.node)) this.#forgetPeaks(line.path);
  }

  async readTakes(id: string): Promise<void> {
    try {
      if (!this.#nodes) {
        const answer = await this.service.call<{ nodes?: NodeListEntry[] }>('node.list');
        this.#nodes = new SvelteMap((answer.nodes ?? []).map((n) => [n.id, n]));
      }
      const node = this.#nodes.get(id);
      const versions = node?.versions ?? [];
      this.takes.set(id, {
        versions: versions.map((v) => ({ v: v.v, path: v.path ?? v.file ?? '' })),
        plays: versions.length ? (node?.plays ?? node?.current ?? versions.at(-1)?.v ?? null) : null,
      });
      this.takesError = null;
    } catch (error) {
      // not cached as "no takes": the next select (or a node.changed) asks again
      this.takes.delete(id);
      this.takesError = `The takes of ${this.nameOf(id)} could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Real peaks for a clip, asked once per made file; until they arrive the timeline draws the stand-in shape. If
      they cannot be read the clip is drawn flat and marked "no waveform" (`noWave`), never with an invented shape. */
  ensurePeaks(path: string | null | undefined, seconds: number, music: boolean): void {
    if (!path || this.#peaksAsked.has(path)) return;
    this.#peaksAsked.add(path);
    const buckets = bucketCount(seconds, music);
    this.service
      .call<PeaksAnswer>('audio.peaks', { path, buckets })
      .then((answer) => {
        if (answer.peaks?.length) {
          this.peaks.set(path, answer.peaks);
          this.noWave.delete(path);
        } else this.#flat(path, buckets);
      })
      .catch((error) => {
        // the link or the service was down: not "no waveform", the next view asks again
        if (error instanceof ServiceError && LINK_DOWN.has(error.code ?? '')) this.#peaksAsked.delete(path);
        else this.#flat(path, buckets);
      });
  }

  #flat(path: string, buckets: number): void {
    this.noWave.add(path);
    this.peaks.set(path, new Array<number>(buckets).fill(0));
  }

  /** A clip's file was written again (same path): its peaks are asked again. */
  #forgetPeaks(path: string | null | undefined): void {
    if (!path) return;
    this.#peaksAsked.delete(path);
    this.peaks.delete(path);
    this.noWave.delete(path);
  }

  // ---- facts about a line ----

  checkOf = (id: string): LineCheck | undefined => this.checks.get(id);
  lineById = (id: string | null): VoiceLine | undefined => this.lines.find((l) => l.node === id);
  nameOf = (id: string): string => lineName(this.lines, id);
  isBad = (line: VoiceLine): boolean => isBad(line, this.checkOf(line.node));
  needsYou = (line: VoiceLine): boolean => needsYou(line, this.checkOf(line.node));
  isMaking = (line: VoiceLine): boolean => isMaking(line, this.#sent.has(line.node));
  isSent = (id: string): boolean => this.#sent.has(id);

  /** The role that will read the line: the queued change first, then the service's. */
  roleOf = (id: string): string =>
    this.basket.lines.get(id)?.patch.role ?? this.checkOf(id)?.role ?? 'narrator';
  tagsOf = (id: string): string[] => this.basket.lines.get(id)?.patch.tags ?? this.checkOf(id)?.tags ?? [];
  textOf = (line: VoiceLine): string => this.checkOf(line.node)?.text ?? line.words;

  // ---- selection ----

  select(id: string, toggle = false): void {
    this.selectedLine = toggle && this.selectedLine === id ? null : id;
    this.selectedCue = null;
    this.#remember();
    if (this.selectedLine && !this.takes.has(this.selectedLine)) void this.readTakes(this.selectedLine);
  }

  selectCue(id: string): void {
    this.selectedCue = id;
    this.selectedLine = null;
    this.#remember();
  }

  deselect(): void {
    this.selectedLine = null;
    this.selectedCue = null;
    this.#remember();
  }

  /** Left / right along the time line. */
  step(direction: 1 | -1): void {
    if (this.selectedLine) {
      const at = this.lines.findIndex((l) => l.node === this.selectedLine);
      const next = this.lines[at + direction];
      if (next) this.select(next.node);
    } else if (this.selectedCue) {
      const at = this.music.cues.findIndex((c) => c.id === this.selectedCue);
      const next = this.music.cues[at + direction];
      if (next) this.selectCue(next.id);
    }
  }

  goToIssue(direction: 1 | -1): void {
    const issue = stepIssue(this.issues, this.selectedLine ?? this.selectedCue, direction);
    if (!issue) return;
    if (issue.kind === 'line') this.select(issue.id);
    else this.selectCue(issue.id);
  }

  // ---- changes (free) ----

  async approve(line: VoiceLine): Promise<void> {
    try {
      await this.service.call('node.edit', { node: line.node, action: 'ok' });
      await this.load();
    } catch (error) {
      this.basket.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** What "Approve all" signs off: every made line and made music segment not yet approved, and not queued for a change. */
  get approvable(): { lines: VoiceLine[]; cues: string[] } {
    return {
      lines: this.lines.filter(
        (l) => l.path && l.state !== 'approved' && !this.isMaking(l) && !this.basket.lines.has(l.node),
      ),
      cues: this.music.cues
        .filter((c) => c.path && c.state !== 'ok' && c.state !== 'stale' && !this.basket.cues.has(c.id))
        .map((c) => c.id),
    };
  }

  /** Free: the owner listened and it is good, so every made line and segment is approved at once (the same
   *  node.edit ok and music.cue.ok as the one-by-one buttons, in turn), then the screen reloads once. */
  async approveAll(): Promise<void> {
    const { lines, cues } = this.approvable;
    try {
      for (const line of lines) await this.service.call('node.edit', { node: line.node, action: 'ok' });
      for (const cue of cues) await this.service.call('music.cue.ok', { cue });
    } catch (error) {
      this.basket.error = error instanceof Error ? error.message : String(error);
    }
    await this.load();
    await this.music.load();
  }

  async setPause(id: string, seconds: number): Promise<void> {
    const value = Math.min(5, Math.max(0, Math.round(seconds * 100) / 100));
    try {
      await this.service.call('voice.line.set', { line: id, gap_after: value });
      this.music.mixOld = true;
      await this.load();
    } catch (error) {
      this.basket.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Free: the whole voice faster or slower (pitch kept); the service joins it again and says so (node.changed). */
  async setSpeed(speed: number): Promise<void> {
    try {
      this.pace = await this.service.call<VoicePace>('voice.speed.set', { speed });
      this.music.mixOld = true;
    } catch (error) {
      this.basket.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Switches the take in use. Index past the last kept take = the newest. */
  async useTake(id: string, versions: readonly TakeVersion[], index: number): Promise<void> {
    const take = versions[Math.max(0, Math.min(versions.length - 1, index))];
    try {
      await this.service.call('node.pick', {
        node: id,
        v: index >= versions.length - 1 ? null : (take?.v ?? null),
      });
      this.takes.delete(id);
      this.#nodes = null;
      this.music.mixOld = true;
      await this.load();
      await this.readTakes(id);
    } catch (error) {
      this.basket.error = error instanceof Error ? error.message : String(error);
    }
  }

  // ---- listening ----

  playSelection(): void {
    const line = this.lineById(this.selectedLine);
    if (line) this.player.playLine(line);
    else {
      const cue = this.music.cue(this.selectedCue);
      if (cue) this.player.playCue(cue);
    }
  }

  /** A line with the lines around it and the music under it. */
  previewInContext(line: VoiceLine): void {
    const at = this.lines.indexOf(line);
    const around = [this.lines[at - 1], line, this.lines[at + 1]].filter((l): l is VoiceLine => Boolean(l));
    const cue = this.music.cues.find(
      (c) => c.path && c.from_sec <= line.start_sec && c.to_sec > line.start_sec,
    );
    this.player.playWithContext(around, cue);
  }

  /** A music cue with the lines it covers. */
  previewCue(cueId: string): void {
    const cue = this.music.cue(cueId);
    if (!cue) return;
    const covered = this.lines.filter(
      (l) => l.start_sec < cue.to_sec && l.start_sec + l.dur_sec > cue.from_sec,
    );
    this.player.playWithContext(covered, cue);
  }

  /** Puts a new read of a line in the queue; its cost shows there first. */
  queueReread(id: string): void {
    void this.basket.stageTakes([id], 'new read');
  }

  /** While a line has no take, a pause change is saved but the voice is not joined again (the join waits for every
      take): "Pause saved; it's heard once Scene 8 · line 2 is recorded". Null when every line has a take. */
  get pauseWait(): string | null {
    const unread = this.lines.filter((l) => !l.path).map((l) => this.nameOf(l.node));
    return unread.length
      ? `Pause saved; it's heard once ${unread.join(', ')} ${unread.length === 1 ? 'is' : 'are'} recorded`
      : null;
  }

  /** Made lines whose take says words the script no longer has, not in the queue yet. A line never made is not here:
      its first read belongs to the voice step and its cost OK (VoiceCostOk / step.confirm_cost), not to this queue. */
  readonly changedLines = $derived(
    this.lines.filter(
      (l) => l.words_changed && Boolean(l.path) && !this.isMaking(l) && !this.basket.lines.has(l.node),
    ),
  );

  /** Every words-changed line into the queue at once: one cost, one confirm when the queue is made. */
  queueChanged(): void {
    const ids = this.changedLines.map((l) => l.node);
    if (ids.length) void this.basket.stageTakes(ids, 'words changed');
  }

  /** Whether a cue may join the queue now, or why not: the first cue is made alone and heard before the rest. */
  whyNotQueueCue(id: string): string | null {
    if (this.noKey) return this.noKey;
    const first = !this.music.anyMade && this.basket.cues.size >= 1 && !this.basket.cues.has(id);
    if (!first) return null;
    const waiting = cueName([...this.basket.cues.keys()][0] ?? '');
    return `The first music is made alone: make ${waiting} (Make the queue), hear it, then queue the rest.`;
  }

  requestNewCharacter(): void {
    this.castOpen = true;
    this.addingCharacter = true;
  }

  // ---- the cast ----

  /** Saves a new cast; false (with the service's words in the Fix it strip) when it refuses. */
  async #saveCast(
    next: readonly CastMember[],
    note: { text: string; role: string } | null,
  ): Promise<boolean> {
    try {
      await this.cast.save(next, note);
      return true;
    } catch (error) {
      this.basket.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** The made lines a role reads: the ones a change to its voice or settings means re-reading. */
  #madeLinesOf(role: string): string[] {
    return this.lines.filter((l) => l.path && this.roleOf(l.node) === role).map((l) => l.node);
  }

  async useVoice(role: string, voice: VoiceChoice): Promise<boolean> {
    const member = this.cast.member(role);
    if (!member) return false;
    const old = member.name || 'the old voice';
    const next = this.cast.members.map((m) =>
      m.role === role ? { ...m, voice_id: voice.id, name: voice.name } : m,
    );
    if (!(await this.#saveCast(next, { text: `${roleName(role)} now uses ${voice.name}`, role })))
      return false;
    const ids = this.#madeLinesOf(role);
    if (ids.length) void this.basket.stageTakes(ids, `${roleName(role)} uses ${voice.name}, not ${old}`);
    return true;
  }

  /** A setting of the voice changed: it is saved, and the role's lines are queued for a new read. */
  async changeCastSetting(member: CastMember, patch: Partial<CastMember>): Promise<void> {
    const next = this.cast.members.map((m) => (m.role === member.role ? { ...m, ...patch } : m));
    if (!(await this.#saveCast(next, null))) return;
    const ids = this.#madeLinesOf(member.role);
    if (ids.length) {
      void this.basket.stageTakes(
        ids,
        `${ids.length} line${ids.length === 1 ? '' : 's'} of ${roleName(member.role)} use the old settings`,
      );
    }
  }

  /** Clip gain is free: saved at once, applied on the next build. */
  async changeGain(member: CastMember, gain: number): Promise<void> {
    await this.#saveCast(
      this.cast.members.map((m) => (m.role === member.role ? { ...m, gain_db: gain } : m)),
      null,
    );
  }

  async addCharacter(name: string, voice: VoiceChoice): Promise<boolean> {
    const base = this.cast.members[0] ?? { role: 'narrator' };
    const role = roleId(name);
    const joined: CastMember = {
      role,
      name: voice.name,
      voice_id: voice.id,
      model: base.model,
      v4: base.v4,
      settings: { ...base.settings },
      gain_db: 0,
    };
    const label = name.trim().replace(/^./, (c) => c.toUpperCase());
    return this.#saveCast([...this.cast.members, joined], {
      text: `${label} joined the cast with ${voice.name}`,
      role,
    });
  }

  async undoCast(): Promise<void> {
    const note = this.cast.note;
    if (!note) return;
    if (!(await this.#saveCast(note.before, null))) return;
    this.cast.note = null;
    for (const [id, item] of [...this.basket.lines]) {
      if (item.kind === 'take' && this.roleOf(id) === note.role) this.basket.unstage(id);
    }
  }

  // ---- inside ----

  #planChanged(plan: MusicPlan): void {
    // a cue made again keeps its path: a new state (stale -> made, made -> ...) means a new file, so new peaks
    for (const cue of plan.cues) {
      const before = this.#cueMade.get(cue.id);
      if (before !== undefined && before !== cue.state) {
        // 'made' again after any other state = a new file at the same path; 'stale' = no longer what was mixed
        if (cue.state === 'made') this.#forgetPeaks(cue.path);
        if (cue.state === 'made' || cue.state === 'stale') this.music.mixOld = true;
      }
      this.#cueMade.set(cue.id, cue.state);
    }
    this.basket.syncCues(
      plan.cues.map((c) => c.id),
      plan.credits_per_sec_measured != null,
    );
  }

  #dropFinishedRereads(): void {
    for (const [id, sent] of [...this.#sent]) {
      const line = this.lines.find((l) => l.node === id);
      if (
        !line ||
        line.path !== sent.path ||
        line.dur_sec !== sent.duration ||
        Date.now() - sent.at > REREAD_GIVE_UP_MS
      ) {
        this.#sent.delete(id);
      }
    }
  }

  /** What the voice sounds like now, as one string (each line's take and length); null before the first load. */
  #heard(): string | null {
    return this.view ? this.lines.map((l) => `${l.node}:${l.path ?? ''}:${l.dur_sec}`).join('|') : null;
  }

  #remember(): void {
    rememberSelection(this.selectedLine, this.selectedCue);
  }
}
