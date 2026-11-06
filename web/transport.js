// Playing the cut with the music (doc 19 §4). Without the sound engine the clock is an <audio> element playing the last
// render; the Monitor's video follows it, never leads: two <video> elements (A plays the current shot, B is readied
// 300 ms before the next cut and swapped in on the cut), each frame checked with requestVideoFrameCallback and nudged.

// What to do about one frame's error (seconds; positive = the picture is ahead of the sound). Pure, so it's tested.
//   under 10 ms (or within the frame on screen): play at 1; up to 120 ms: nudge the rate (0.95–1.05, catches up in about
//   a second); over: seek. `hold` is half a frame: a frame shown anywhere inside its own duration is on time.
export function syncAction(error, hold = 0) {
  const a = Math.abs(error);
  if (a < Math.max(0.010, hold)) return { rate: 1 };
  if (a <= 0.120) return { rate: Math.min(1.05, Math.max(0.95, 1 - error)) };
  return { seek: true };
}

// The clock: "heard time now" from the audio element. currentTime moves in steps, so only readings taken just after it
// moved count (a stale one would say the sound is earlier than it is); of those, the smallest offset (arrival − media
// time) in the last 2 s wins: the reading with the least delay. Before the sound has moved at all, the media time is
// the answer.
export function audioClock(audio) {
  let samples = [];
  let last = null;
  return {
    reset() { samples = []; last = null; },
    now() {
      const t = performance.now();
      const ct = audio.currentTime;
      if (audio.paused) { samples = []; last = null; return ct; }
      if (last !== null && ct !== last) samples.push([t, t - ct * 1000]);
      last = ct;
      while (samples.length > 1 && samples[0][0] < t - 2000) samples.shift();
      if (!samples.length) return ct;
      const off = Math.min(...samples.map((x) => x[1]));
      return Math.max(0, (t - off) / 1000);
    },
  };
}

// The clock the picture follows: the last render (an <audio> element) when there's no sound engine.
export function audioSource(h, audioUrl) {
  const audio = h('audio', { src: audioUrl, preload: 'auto' });
  const clock = audioClock(audio);
  const ended = new Set();
  audio.addEventListener('ended', () => ended.forEach((f) => f()));
  return {
    kind: 'render',
    get playing() { return !audio.paused; },
    now: () => clock.now(),
    position: () => audio.currentTime,
    async play(at = null) { if (at !== null) audio.currentTime = Math.max(0, at); clock.reset(); await audio.play(); },
    stop() { audio.pause(); },
    seek(t) { audio.currentTime = Math.max(0, t); clock.reset(); },
    onEnded: (f) => ended.add(f),
    destroy() { audio.pause(); audio.removeAttribute('src'); },
    audio,
  };
}

// The sound engine's clock (doc 19 §4): its clock events say which song second the listener hears; the smallest
// (arrival − heard) of the last 2 s is the least-delayed reading, and between events "now" runs on from it. The song's
// bar 1 is offsetSec into the video; avOffsetMs moves the picture for screens and speakers with their own delay.
export function engineSource({ api, project, offsetSec = 0, avOffsetMs = () => 0, subscribe }) {
  let samples = [];
  let playing = false;
  let last = 0;
  let started = false;
  const ended = new Set();
  const unsub = subscribe('daw-clock', (m) => {
    if (m.project && m.project !== project) return;
    const t = performance.now();
    if (Boolean(m.playing) !== playing) samples = [];
    playing = Boolean(m.playing);
    last = Number(m.seconds) || 0;
    if (playing) {
      samples.push([t, t - last * 1000]);
      while (samples.length > 1 && samples[0][0] < t - 2000) samples.shift();
    }
  });
  const songNow = () => {
    if (!playing || !samples.length) return last;
    const off = Math.min(...samples.map((x) => x[1]));
    return Math.max(0, (performance.now() - off) / 1000);
  };
  const cmd = (name, args = {}) => api('/api/daw/command', { method: 'POST', body: { cmd: name, args } });
  const ensure = async () => { if (!started) { await api('/api/daw/start', { method: 'POST', body: { project } }); started = true; } };
  return {
    kind: 'engine',
    get playing() { return playing; },
    now: () => songNow() + offsetSec + avOffsetMs() / 1000,
    position: () => songNow() + offsetSec,
    async play(at = null) { await ensure(); samples = []; await cmd('transport.play', at === null ? {} : { seconds: Math.max(0, at - offsetSec) }); playing = true; },
    async stop() { await cmd('transport.stop').catch(() => {}); playing = false; },
    async seek(t) { await ensure(); samples = []; await cmd('transport.seek', { seconds: Math.max(0, t - offsetSec) }); last = Math.max(0, t - offsetSec); },
    onEnded: (f) => ended.add(f),
    destroy() { unsub(); },
  };
}

const LEAD = 1.0;          // seconds before a cut that the next shot is readied (a seek can take that long)

// shots: [{ id, from, to, src, srcFrom }] on the video's time axis. source: audioSource or engineSource (audioUrl: the
// last render, for an audio source made here).
export function createTransport({ h, audioUrl = null, source = null, shots, fps = 30, onTime = () => {}, onState = () => {} }) {
  const frame = 1 / fps;
  const src = source || audioSource(h, audioUrl);
  const audio = src.audio || null;
  const clock = { now: () => src.now() };
  const vids = [0, 1].map(() => h('video', { class: 'tp-video', muted: true, playsinline: true, preload: 'auto' }));
  for (const v of vids) { v.muted = true; }
  const stage = h('div', { class: 'tp-stage' }, ...vids);
  let active = 0;           // which video shows
  let shotIdx = -1;         // the shot in the active video
  let raf = 0;
  const stats = [];         // frame errors while playing (seconds), for the drift test
  const trace = [];         // [heard time, error, rate, shot] per frame, for the same
  const shotAt = (t) => shots.findIndex((s) => t >= s.from && t < s.to);
  // the next shot carries straight on in the same file (cut from one render, in order): no swap needed
  const continues = (i) => { const a = shots[i]; const b = shots[i + 1]; return a && b && a.src === b.src && Math.abs(b.srcFrom - (a.srcFrom + (a.to - a.from))) < 0.002; };

  function load(v, i, t) {
    const s = shots[i];
    if (!s) return;
    // t may be before the shot starts (a readied video running up to its cut): fine while the file has frames there
    const want = Math.max(0, s.srcFrom + (t - s.from));
    if (!v.src.endsWith(s.src)) v.src = s.src;
    v.__shot = i;
    if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want;
  }
  function show(i) {
    vids[active].classList.remove('on');
    active = i;
    vids[active].classList.add('on');
  }

  // each frame: compare its middle (a frame is on screen for its whole duration) with the clock at the moment it's
  // displayed. The shown video is logged and nudged; a readied one running ahead of its cut is nudged too.
  function watch(v) {
    if (!v.requestVideoFrameCallback) return;
    v.requestVideoFrameCallback((now, meta) => {
      const s = shots[v.__shot];
      if (src.playing && s && !v.paused && (v.__shot === shotIdx || v.__shot === shotIdx + 1)) {
        const pictureAt = s.from + (meta.mediaTime + frame / 2 - s.srcFrom);
        const heardAt = clock.now() + (meta.expectedDisplayTime - performance.now()) / 1000;
        const error = pictureAt - heardAt;
        const shown = v === vids[active] && v.__shot === shotIdx;
        if (shown) {
          stats.push(error);
          trace.push([heardAt, error, v.playbackRate, shotIdx]);
          if (stats.length > 4000) { stats.shift(); trace.shift(); }
        }
        // the frame on screen covers its whole duration: inside half a frame, it is the right picture (no chasing)
        const act = syncAction(error, frame / 2);
        // a rate change restarts the browser's own timing, so it's only made when it matters (> 0.003 apart)
        if (act.seek) load(v, v.__shot, heardAt + 0.05);
        else if (Math.abs(v.playbackRate - act.rate) > 0.003 || (act.rate === 1 && v.playbackRate !== 1)) v.playbackRate = act.rate;
      }
      watch(v);
    });
  }
  vids.forEach(watch);

  function tick() {
    const t = clock.now();
    onTime(t);
    const i = shotAt(t);
    if (i !== shotIdx && i >= 0) {
      if (i === shotIdx + 1 && continues(shotIdx)) {
        vids[active].__shot = i;              // the same video plays on through the cut
      } else {
        // the cut: show the readied video if it holds this shot, else load it now
        const other = 1 - active;
        if (vids[other].__shot === i) { show(other); } else load(vids[active], i, t);
        vids[active].play().catch(() => {});
        vids[1 - active].pause();
      }
      shotIdx = i;
    }
    // 300 ms before the next cut, ready the hidden video: running up to the cut when its file has the frames before
    // the shot (the same render), else waiting at the shot's first frame
    const next = shots[shotIdx + 1];
    if (next && !continues(shotIdx) && next.from - t < LEAD && vids[1 - active].__shot !== shotIdx + 1) {
      const v = vids[1 - active];
      const lead = next.from - t;
      v.playbackRate = 1;
      if (next.srcFrom - lead >= 0) { load(v, shotIdx + 1, t); v.play().catch(() => {}); } else { load(v, shotIdx + 1, next.from); v.pause(); }
    }
    if (src.playing) raf = requestAnimationFrame(tick);
  }

  async function play(from = null) {
    stats.length = 0; trace.length = 0;
    const t = from !== null ? from : src.position();
    const i = Math.max(0, shotAt(t));
    load(vids[active], i, t);
    vids[active].classList.add('on');
    shotIdx = i;
    await vids[active].play().catch(() => {});   // the picture first: it takes longer to start than the sound
    await src.play(from);
    onState(true);
    raf = requestAnimationFrame(tick);
  }
  async function stop() {
    await src.stop();
    cancelAnimationFrame(raf);
    for (const v of vids) { v.pause(); v.playbackRate = 1; }
    onState(false);
    onTime(src.position());
  }
  async function seek(t) {
    const playing = src.playing;
    await src.seek(t);
    const i = Math.max(0, shotAt(t));
    shotIdx = -1;
    load(vids[active], i, t);
    onTime(t);
    if (playing) tick();
  }
  src.onEnded(() => stop());

  return { stage, audio, source: src, play, stop, seek, get playing() { return src.playing; }, now: () => src.now(), stats, trace, destroy() { cancelAnimationFrame(raf); if (src.playing) src.stop(); src.destroy(); for (const v of vids) { v.pause(); v.removeAttribute('src'); } } };
}
