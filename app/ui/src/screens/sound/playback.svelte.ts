import { gainFromDb } from './sound';

// Plays one shot: its picture, the narration under it and the kept sounds on one clock, with a playhead.

export interface PlayPlan {
  /** The shot's length in seconds. */
  span: number;
  /** Where the shot starts on the film's clock. */
  from: number;
  /** The narration file's address. */
  narration?: string;
  /** The shot's clip, muted: it is only the picture. */
  video?: HTMLVideoElement | null;
  /** Where in the clip the shot starts. */
  videoFrom: number;
  /** Sounds to play: seconds into the shot, address, gain in dB. */
  sounds: { at: number; url: string; gainDb: number }[];
}

const END_SLACK = 0.05;
const STARTED_SLACK = 0.05;

export class ShotPlayback {
  playing = $state(false);
  /** The playhead: seconds into the shot. */
  offset = $state(0);
  #startedAt = 0;
  /** The playhead when this run started: the clock counts from here. */
  #startOffset = 0;
  #frame = 0;
  #timers: ReturnType<typeof setTimeout>[] = [];
  #narration: HTMLAudioElement | null = null;
  #sounds: HTMLAudioElement[] = [];
  #video: HTMLVideoElement | null = null;

  /** Play or pause. A shot that reached its end plays again from the start. */
  toggle(plan: PlayPlan): void {
    if (this.playing) {
      const at = this.#now();
      this.#halt();
      this.offset = at;
    } else this.start(plan, this.offset >= plan.span - END_SLACK ? 0 : this.offset);
  }

  start(plan: PlayPlan, offset: number): void {
    this.#halt();
    this.offset = offset;
    this.#startOffset = offset;
    this.#startedAt = performance.now();
    this.playing = true;
    this.#video = plan.video ?? null;
    if (plan.narration) {
      this.#narration = new Audio(plan.narration);
      this.#narration.currentTime = plan.from + offset;
      void this.#narration.play().catch(() => undefined);
    }
    if (this.#video) {
      this.#video.currentTime = plan.videoFrom + offset;
      void this.#video.play().catch(() => undefined);
    }
    for (const sound of plan.sounds) {
      const wait = sound.at - offset;
      if (wait < -STARTED_SLACK) continue;
      this.#timers.push(setTimeout(() => this.#playSound(sound.url, sound.gainDb), Math.max(0, wait) * 1000));
    }
    const tick = () => {
      if (!this.playing) return;
      const at = this.#now();
      this.offset = Math.min(at, plan.span);
      if (at >= plan.span) {
        this.#halt();
        this.offset = 0;
        return;
      }
      this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
  }

  /** Moves the playhead; keeps playing from there if it was playing. */
  seek(plan: PlayPlan, offset: number): void {
    this.offset = offset;
    if (this.playing) this.start(plan, offset);
    else if (plan.video) plan.video.currentTime = plan.videoFrom + offset;
  }

  /** Plays one sound on its own. */
  playOne(url: string): void {
    this.#halt();
    this.#sounds.push(new Audio(url));
    void this.#sounds[0]?.play().catch(() => undefined);
  }

  /** Stops everything and goes back to the start. */
  stop(): void {
    this.#halt();
    this.offset = 0;
  }

  #now(): number {
    return this.#startOffset + (performance.now() - this.#startedAt) / 1000;
  }

  #playSound(url: string, gainDb: number): void {
    const audio = new Audio(url);
    audio.volume = gainFromDb(gainDb);
    this.#sounds.push(audio);
    void audio.play().catch(() => undefined);
  }

  #halt(): void {
    this.playing = false;
    cancelAnimationFrame(this.#frame);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    this.#narration?.pause();
    this.#narration = null;
    for (const audio of this.#sounds) audio.pause();
    this.#sounds = [];
    this.#video?.pause();
  }
}
