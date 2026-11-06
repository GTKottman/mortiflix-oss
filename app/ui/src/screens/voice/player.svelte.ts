// Everything that makes sound on the Voice & music screen: one line, the whole voice (or the made mix), a line with
// the lines around it and the music under them, a music cue alone, and A/B takes. One thing plays at a time.
import { fileUrl } from '../../lib/files';
import type { MusicCue, VoiceLine } from './types';

export interface PlayerSource {
  lines: () => readonly VoiceLine[];
  /** The music mixed under the whole voice, once it has been made. */
  mix: () => string | null | undefined;
  selectedLine: () => string | null;
  /** The music cues along the voice: what plays under a line heard on its own (owner 2026-11-03: hear the music
   *  while the voice goes). */
  cues: () => readonly MusicCue[];
}

/** A second of the line before and the line after, when looping a line with "± 1 s". */
const ROLL_SECONDS = 1;
const GAP_BETWEEN_LINES_MS = 150;

/** Music under speech at its ducking (the cue's duck_db, −12 dB when unset), as the context preview always played it. */
const duckScale = (cue: MusicCue): number => Math.pow(10, (cue.duck_db ?? -12) / 20) * 2;

export class Player {
  /** The playhead, in seconds of the whole voice. */
  time = $state(0);
  /** The line being heard, if any. */
  playingLine = $state<string | null>(null);
  /** Seconds into that line: lights the word being said. */
  lineTime = $state(0);
  /** Anything at all is playing. */
  active = $state(false);
  loop = $state(false);
  roll = $state(false);
  volume = $state(1);
  /** The voice's Speed (voice.speed.get): line clips are 1x takes, so they play at it, pitch kept; times stay the timeline's. */
  speed = $state(1);

  readonly #source: PlayerSource;
  #line: HTMLAudioElement | null = null;
  #mix: HTMLAudioElement | null = null;
  #under: HTMLAudioElement | null = null;
  /** The music under a context preview plays at the volume times this (its ducking). */
  #underScale = 1;
  /** Voice played line by line keeps the cue music under it in step (not in a context preview, which brings its own). */
  #underFollows = false;
  #underCue: string | null = null;
  #queue: VoiceLine[] | null = null;

  constructor(source: PlayerSource) {
    this.#source = source;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    for (const audio of [this.#line, this.#mix]) if (audio) audio.volume = volume;
    if (this.#under) this.#under.volume = Math.min(1, volume * this.#underScale);
  }

  stop(): void {
    for (const audio of [this.#under, this.#line, this.#mix]) audio?.pause();
    this.#under = this.#line = this.#mix = null;
    this.#underCue = null;
    this.#queue = null;
    this.playingLine = null;
    this.active = false;
  }

  /** Plays one line; a second call on the same line stops it. `from` starts that many seconds in. */
  playLine(line: VoiceLine, from?: number): void {
    const wanted = this.#source.selectedLine() === line.node;
    if (this.loop && this.roll && wanted && from == null && this.playingLine !== line.node) {
      this.#playRolling(line);
      return;
    }
    const same = this.playingLine === line.node && from == null;
    this.stop();
    if (same || !line.path) return;
    const audio = this.#start(line.path);
    this.#line = audio;
    this.playingLine = line.node;
    audio.onended = () => {
      this.stop();
      if (this.loop && this.#source.selectedLine() === line.node) this.playLine(line);
    };
    audio.ontimeupdate = () => this.#follow(line, audio.currentTime);
    if (from) audio.currentTime = from * this.speed;
    this.#underAt(line.start_sec + (from ?? 0));
    this.#play(audio);
  }

  /** The whole voice: the made mix when there is one, else every line in turn. */
  playAll(): void {
    if (this.active) return this.stop();
    const mix = this.#source.mix();
    if (mix) {
      const audio = this.#start(mix, false);
      this.#mix = audio;
      audio.ontimeupdate = () => (this.time = audio.currentTime);
      audio.onended = () => this.stop();
      this.#play(audio);
      return;
    }
    this.stop();
    this.#playQueue(this.#source.lines().filter((l) => l.path));
  }

  /** A line with the lines around it, and the cue's music under them. */
  playWithContext(lines: readonly VoiceLine[], cue?: MusicCue): void {
    this.stop();
    if (cue?.path) {
      const under = this.#start(cue.path, false);
      this.#underScale = duckScale(cue);
      under.volume = Math.min(1, this.volume * this.#underScale);
      this.#under = under;
      this.#play(under);
    }
    this.#playQueue(lines.filter((l) => l.path), false);
  }

  /** A music cue on its own. */
  playCue(cue: MusicCue): void {
    this.stop();
    if (!cue.path) return;
    this.#mix = this.#start(cue.path, false);
    this.#mix.onended = () => this.stop();
    this.#play(this.#mix);
  }

  /** One take of a line, or two in a row (A then B). */
  playTakes(...paths: string[]): void {
    this.stop();
    const [first, ...rest] = paths;
    if (!first) return;
    const audio = this.#start(first);
    this.#line = audio;
    audio.onended = () => (rest.length ? this.playTakes(...rest) : this.stop());
    this.#play(audio);
  }

  /** Starts from this second of the whole voice. */
  seek(seconds: number): void {
    if (this.#mix) {
      this.#mix.currentTime = seconds;
      return;
    }
    const lines = this.#source.lines();
    const line =
      lines.find((l) => seconds >= l.start_sec && seconds < l.start_sec + l.dur_sec) ??
      lines.find((l) => l.start_sec > seconds);
    if (line) this.playLine(line, Math.max(0, seconds - line.start_sec));
  }

  /** The music under the voice from this second of the timeline: the cue there, from the right point, at its ducked
   *  volume, then the next cue when it ends. Nothing when no cue there is made. */
  #underAt(seconds: number): void {
    const cues = this.#source.cues().filter((c) => c.path);
    const cue = cues.find((c) => seconds >= c.from_sec && seconds < c.to_sec);
    if (!cue?.path) return;
    const offset = seconds - cue.from_sec;
    if (this.#under && this.#underCue === cue.id && Math.abs(this.#under.currentTime - offset) < 0.4) return;
    this.#under?.pause();
    const under = this.#start(cue.path, false);
    this.#underScale = duckScale(cue);
    under.volume = Math.min(1, this.volume * this.#underScale);
    under.currentTime = offset;
    under.onended = () => {
      if (this.#under === under) this.#underAt(cue.to_sec + 0.01);
    };
    this.#under = under;
    this.#underCue = cue.id;
    under.play().catch(() => undefined);
  }

  #start(path: string, voice = true): HTMLAudioElement {
    const audio = new Audio(fileUrl(path));
    audio.volume = this.volume;
    if (voice && this.speed !== 1) audio.playbackRate = this.speed;
    return audio;
  }

  #play(audio: HTMLAudioElement): void {
    this.active = true;
    audio.play().catch(() => this.stop());
  }

  #follow(line: VoiceLine, clipSeconds: number): void {
    const seconds = clipSeconds / this.speed;
    this.lineTime = seconds;
    this.time = line.start_sec + seconds;
  }

  #playQueue(lines: readonly VoiceLine[], music = true): void {
    this.#underFollows = music;
    this.#queue = lines.slice();
    this.active = true;
    this.#playNext();
  }

  #playNext(): void {
    const line = this.#queue?.shift();
    if (!line) return this.stop();
    const audio = this.#start(line.path ?? '');
    this.#line = audio;
    this.playingLine = line.node;
    if (this.#underFollows) this.#underAt(line.start_sec);
    audio.onended = () => setTimeout(() => this.#playNext(), GAP_BETWEEN_LINES_MS);
    audio.ontimeupdate = () => this.#follow(line, audio.currentTime);
    this.#play(audio);
  }

  /** Loop with a second of lead-in (end of the line before) and lead-out (start of the line after). */
  #playRolling(line: VoiceLine): void {
    const lines = this.#source.lines();
    const at = lines.indexOf(line);
    const before = lines[at - 1];
    const after = lines[at + 1];
    const parts: { line: VoiceLine; from?: number; to?: number }[] = [];
    if (before?.path) parts.push({ line: before, from: Math.max(0, before.dur_sec - ROLL_SECONDS) });
    parts.push({ line });
    if (after?.path) parts.push({ line: after, to: ROLL_SECONDS });
    this.stop();
    let next = 0;
    const run = () => {
      const part = parts[next++];
      if (!part) {
        if (this.loop && this.#source.selectedLine() === line.node) {
          next = 0;
          return run();
        }
        return this.stop();
      }
      const audio = this.#start(part.line.path ?? '');
      this.#line = audio;
      this.playingLine = part.line.node;
      if (part.from) audio.currentTime = part.from * this.speed;
      audio.ontimeupdate = () => {
        this.#follow(part.line, audio.currentTime);
        if (part.to && audio.currentTime >= part.to * this.speed) {
          audio.pause();
          audio.onended?.(new Event('ended'));
        }
      };
      audio.onended = () => {
        audio.onended = null;
        run();
      };
      this.#play(audio);
    };
    run();
  }
}
