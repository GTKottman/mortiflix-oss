import { describe, expect, it } from 'vitest';
import {
  blockerFor,
  fileName,
  filmFrom,
  formatSize,
  pathFor,
  productionSummary,
  queueWords,
  specLine,
} from '../src/screens/finish/finish';
import type { FinishApi } from '../src/screens/finish/api';
import { FinalVideo } from '../src/screens/finish/final-video.svelte';
import { Problems } from '../src/lib/stores/problems.svelte';
import { plural } from '../src/lib/words';
import type { FilmInfo, FinalStatus } from '../src/screens/finish/types';

const film: FilmInfo = {
  title: 'Black October',
  width: 1920,
  height: 1080,
  fps: 30,
  lengthSec: 59.6,
  shotsTotal: 6,
  shotsMade: 6,
  counts: { shots: 6, lines: 18, music: 1, sfx: 14, captions: 27, markers: 6 },
};

describe('formatSize', () => {
  it('uses MB below a gigabyte and GB above', () => {
    expect(formatSize(84_000_000)).toBe('84 MB');
    expect(formatSize(1_240_000_000)).toBe('1.2 GB');
    expect(formatSize(10)).toBe('1 MB');
  });
});

describe('specLine', () => {
  it('joins what is known, picture size from the file first', () => {
    expect(specLine({ state: 'done', length_sec: 59.6, size: 84_000_000 }, film, null)).toBe(
      '1:00 · 1920×1080 · 30 fps · MP4 · 84 MB',
    );
    expect(specLine({ state: 'done' }, film, { width: 960, height: 540 })).toBe(
      '1:00 · 960×540 · 30 fps · MP4',
    );
  });
  it('leaves out what is not known', () => {
    expect(specLine({ state: 'done', size: 5_000_000 }, null, null)).toBe('0:00 · MP4 · 5 MB');
  });
});

describe('productionSummary', () => {
  it('counts the film in one line', () => {
    expect(productionSummary(film.counts)).toBe(
      '6 shots · 18 voice lines · 1 music piece · 14 effects · 27 captions',
    );
  });
  it('says plainly when there is no music or effects', () => {
    expect(productionSummary({ ...film.counts, music: 0, sfx: 0 })).toContain('no music · no effects');
    expect(plural(1, 'shot')).toBe('1 shot');
  });
});

describe('blockerFor', () => {
  it('names the unmade shots first, pointing at Motion', () => {
    const blocker = blockerFor({ ...film, shotsMade: 3 }, null);
    expect(blocker?.text).toBe("3 of 6 shots are not made yet, so the video can't be put together.");
    expect(blocker?.target.route).toBe('/motion');
  });
  it('says "shot is" for a single shot', () => {
    expect(blockerFor({ ...film, shotsTotal: 1, shotsMade: 0 }, null)?.text).toContain(
      '1 of 1 shot is not made',
    );
  });
  it('uses a failed check, and sends sound problems to Sound', () => {
    const blocker = blockerFor(film, [
      { key: 'sound', ok: false, items: [{ shot: 'b02', text: 'Too loud' }] },
    ]);
    expect(blocker?.text).toBe('B02: Too loud');
    expect(blocker?.target).toEqual({ route: '/sound', shot: 'b02' });
    expect(pathFor({ route: '/sound', shot: 'b02' })).toBe('/sound?shot=b02');
  });
  it('never counts a check that could not look', () => {
    expect(blockerFor(film, [{ key: 'jump', ok: false, checked: false, items: [{ text: 'x' }] }])).toBeNull();
  });
  it('is null when nothing blocks', () => {
    expect(blockerFor(film, [])).toBeNull();
    expect(blockerFor(null, null)).toBeNull();
  });
});

describe('fileName', () => {
  it('takes the last part of the path', () => {
    expect(fileName('/a/b/final.mp4')).toBe('final.mp4');
    expect(fileName(undefined)).toBe('final.mp4');
  });
});

describe('filmFrom', () => {
  it('builds the receipt from the three answers', () => {
    const made = filmFrom(
      {
        nodes: [
          { kind: 'shot', versions: [{ path: '/x.mp4' }] },
          { kind: 'shot', versions: [{}] },
          { kind: 'note' },
        ],
      },
      { length_sec: 12, shots: [{ media: { path: '/p.png' } }] },
      {
        title: 'T',
        clips: [{ kind: 'shot' }, { kind: 'line' }, { track: 'A2' }, { kind: 'sound' }],
        captions: [1, 2],
        markers: [1],
      },
    );
    expect(made).toMatchObject({ title: 'T', shotsTotal: 2, shotsMade: 1, lengthSec: 12, poster: '/p.png' });
    expect(made.counts).toEqual({ shots: 1, lines: 1, music: 1, sfx: 1, captions: 2, markers: 1 });
  });
});

describe('queueWords', () => {
  it('never says "other renders" when none are ahead', () => {
    expect(queueWords(0)).toBe('It is next in the queue.');
    expect(queueWords(1)).toBe('1 render ahead of it.');
    expect(queueWords(3)).toBe('3 renders ahead of it.');
    expect(queueWords(undefined)).toBe('Other renders are ahead of it.');
  });
});

describe('FinalVideo', () => {
  const fakeApi = (states: FinalStatus[], fail?: () => Promise<void>) => {
    let calls = 0;
    const counts = { film: 0, checks: 0 };
    const api: FinishApi = {
      status: async () => states[Math.min(calls++, states.length - 1)] ?? { state: 'none' },
      make: fail ?? (async () => undefined),
      cancel: async () => undefined,
      film: async () => {
        counts.film++;
        return film;
      },
      checks: async () => {
        counts.checks++;
        return [];
      },
      playSrc: () => '/v.mp4',
      posterSrc: () => undefined,
      openInArtCraft: async () => undefined,
    };
    return { api, counts };
  };

  it('keeps a failed Make in the strip after the status is read again', async () => {
    const problems = new Problems();
    const { api } = fakeApi([{ state: 'none' }], async () => {
      throw new Error('Busy.');
    });
    const final = new FinalVideo(api, problems, () => undefined);
    await final.make();
    await final.refresh();
    expect(problems.list.some((p) => p.id === 'finish-make')).toBe(true);
    final.dispose();
  });

  it('reads the film and checks again when a render ends', async () => {
    const { api, counts } = fakeApi([{ state: 'rendering' }, { state: 'done', file: '/v.mp4' }]);
    const final = new FinalVideo(api, new Problems(), () => undefined);
    await final.refresh();
    expect(counts.film).toBe(0);
    await final.refresh();
    expect(counts.film).toBe(1);
    expect(counts.checks).toBe(1);
    final.dispose();
  });

  it('remembers a missing stale file across a status read', async () => {
    const { api } = fakeApi([{ state: 'stale', file: '/v.mp4' }]);
    const final = new FinalVideo(api, new Problems(), () => undefined);
    await final.refresh();
    final.lost = true;
    await final.refresh();
    expect(final.lost).toBe(true);
    final.dispose();
  });
});
