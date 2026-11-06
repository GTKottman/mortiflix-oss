// Records a spoken note from the microphone, to be saved with the marks.

const NO_MICROPHONE =
  'The microphone is not available here (the page needs https or localhost and your OK). Type the note instead.';

export class NoteRecorder {
  audio = $state<Blob | null>(null);
  /** Why the microphone could not be used, in words; empty = no problem. */
  problem = $state('');
  #recorder = $state<MediaRecorder | null>(null);
  #stream: MediaStream | null = null;
  /** Bumped by every start, stop and clear: a microphone answer that arrives after a newer one is let go at once. */
  #turn = 0;
  /** Waiting for the browser's microphone answer (the permission prompt may be open). */
  #starting = false;

  get recording(): boolean {
    return this.#recorder?.state === 'recording';
  }

  /** Starts, or stops and keeps the take. `report` (optional) says what happened; `failed` marks an error. */
  async toggle(report?: (message: string, failed: boolean) => void): Promise<void> {
    if (this.#recorder?.state === 'recording') {
      this.#recorder.stop();
      return;
    }
    // A second press while the browser is still asking for the microphone must not open a second one.
    if (this.#starting) return;
    const turn = ++this.#turn;
    this.#starting = true;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (turn !== this.#turn) {
        // stop() or clear() came while the browser was asking (e.g. the dialog closed): never start, free the mic.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const chunks: Blob[] = [];
      const next = new MediaRecorder(stream);
      next.ondataavailable = (event) => chunks.push(event.data);
      next.onstop = () => {
        this.#release();
        this.audio = new Blob(chunks, { type: next.mimeType || 'audio/webm' });
        report?.('Voice note kept. It is saved with the note.', false);
      };
      next.start();
      this.problem = '';
      this.#recorder = next;
      this.#stream = stream;
    } catch {
      // MediaRecorder can still refuse the stream: let the microphone go either way.
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (turn !== this.#turn) return;
      this.problem = NO_MICROPHONE;
      report?.(NO_MICROPHONE, true);
    } finally {
      if (turn === this.#turn) this.#starting = false;
    }
  }

  stop(): void {
    this.#cancelStart();
    if (this.#recorder?.state === 'recording') this.#recorder.stop();
  }

  /** Throws the take away (and ends a running one without keeping it). */
  clear(): void {
    this.#cancelStart();
    if (this.#recorder) this.#recorder.onstop = null;
    this.#release();
    this.audio = null;
    this.problem = '';
  }

  /** A start still waiting for the microphone is called off (its stream is stopped when it arrives). */
  #cancelStart(): void {
    if (!this.#starting) return;
    this.#turn++;
    this.#starting = false;
  }

  #release(): void {
    if (this.#recorder?.state === 'recording') this.#recorder.stop();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#recorder = null;
    this.#stream = null;
  }
}
