import { describe, expect, it } from 'vitest';
import { compactCount, countLabel, fullCount, share, shortDate } from '../src/lib/usage/format';
import { mergeByLabel, modelName, normalizeUsage, projectNameFromId } from '../src/lib/usage/normalize';
import { sampleUsage } from '../src/lib/usage/sample';

describe('usage formatting', () => {
  it('fits the coin in at most 4 characters', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [940, '940'],
      [1_234, '1.2k'],
      [9_949, '9.9k'],
      [12_400, '12k'],
      [999_499, '999k'],
      [1_240_000, '1.2M'],
      [48_000_000, '48M'],
      [2_100_000_000, '2.1B'],
    ];
    for (const [n, text] of cases) {
      expect(compactCount(n)).toBe(text);
      expect(compactCount(n).length).toBeLessThanOrEqual(4);
    }
  });

  it('writes full counts, plurals, dates and shares', () => {
    expect(fullCount(48210.4)).toBe('48,210');
    expect(countLabel(1, 'day')).toBe('1 day');
    expect(countLabel(6, 'day')).toBe('6 days');
    expect(shortDate('2026-11-02')).toBe('2 Nov 2026');
    expect(shortDate('2026-10-14T09:12:00Z', { year: false })).toBe('14 Oct');
    expect(shortDate('soon')).toBe('');
    expect(share(5, 10)).toBe(0.5);
    expect(share(5, 0)).toBe(0);
  });
});

const claude = (input: number, output: number, cache_read: number, cache_write: number) => ({
  calls: 1,
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: cache_read,
  cache_write_tokens: cache_write,
  total_tokens: input + output + cache_read + cache_write,
  rows: 1,
});
const group = (tokens: number, credits = 0) => ({
  claude: claude(0, tokens, 0, 0),
  elevenlabs: { calls: 0, credits, rows: 0 },
});

describe('normalizeUsage', () => {
  it('fills every hole of an empty answer', () => {
    const usage = normalizeUsage({}, 'today', null);
    expect(usage.totals.claude).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total: 0,
      calls: 0,
    });
    expect(usage.by_stage).toEqual([]);
    expect(usage.elevenlabs).toBeNull();
    expect(usage.records).toEqual({
      biggest_day: null,
      biggest_project: null,
      biggest_call: null,
      streak: { longest: 0, current: 0 },
    });
  });

  it('reads the service answer and names what it can', () => {
    const id = '261023-black-october-the-cves-hitting-t-fa2f';
    const usage = normalizeUsage(
      {
        totals: {
          claude: claude(322, 151_216, 9_394_272, 726_893),
          elevenlabs: { calls: 30, credits: 1437 },
        },
        by_project: [{ project: id, ...group(10_272_703, 1437) }],
        by_stage: [
          { stage: 'voice', ...group(5, 1437) },
          { stage: null, ...group(9) },
        ],
        by_model: [{ provider: 'claude', kind: 'session', model: 'claude-opus-5-5', ...group(42) }],
        series: [{ date: '2026-11-02', ...group(7, 2) }],
        records: {
          biggest_day: { claude: { date: '2026-10-23', ...group(6_715_932) } },
          biggest_project: { claude: { project: id, ...group(10_272_703) } },
          biggest_call: {
            claude: {
              at: '2026-10-24T16:06:47Z',
              model: 'claude-opus-5-5',
              stage: null,
              ...claude(64, 41_239, 3_352_085, 163_383),
            },
          },
          longest_streak: { days: 2, from: '2026-10-23', to: '2026-10-24', current: 0 },
        },
        elevenlabs_balance: null,
        elevenlabs_balance_why: 'no ElevenLabs API key is saved (Settings › Keys)',
      },
      'all',
      null,
      { projects: new Map([[id, 'Black October']]), stages: new Map([['voice', 'Voice & music']]) },
    );
    expect(usage.totals.claude.total).toBe(10_272_703);
    expect(usage.totals.claude.cache_read).toBe(9_394_272);
    expect(usage.totals.elevenlabs.credits).toBe(1437);
    expect(usage.by_project[0]).toEqual({
      key: id,
      label: 'Black October',
      claude_tokens: 10_272_703,
      elevenlabs_credits: 1437,
    });
    expect(usage.by_stage.map((s) => s.label)).toEqual(['Voice & music', 'No stage']);
    expect(usage.by_model[0]?.label).toBe('Opus 5.5');
    expect(usage.series).toEqual([{ date: '2026-11-02', claude_tokens: 7, elevenlabs_credits: 2 }]);
    expect(usage.records.biggest_day).toEqual({ date: '2026-10-23', claude_tokens: 6_715_932 });
    expect(usage.records.biggest_project?.label).toBe('Black October');
    expect(usage.records.biggest_call).toEqual({
      at: '2026-10-24T16:06:47Z',
      claude_tokens: 3_556_771,
      model: 'Opus 5.5',
      stage: '',
    });
    expect(usage.records.streak).toEqual({ longest: 2, current: 0 });
    expect(usage.elevenlabs_why).toMatch(/no ElevenLabs API key/);
  });

  it('reads the ElevenLabs balance', () => {
    const usage = normalizeUsage(
      {
        elevenlabs_balance: { remaining: 600, limit: 1000, used: 400, resets_at: '2026-11-18', stale: true },
      },
      'today',
      null,
    );
    expect(usage.elevenlabs).toEqual({ remaining: 600, limit: 1000, resets_at: '2026-11-18', stale: true });
  });

  it('names models and projects without a title', () => {
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelName('eleven_v4')).toBe('ElevenLabs v4');
    expect(modelName('gpt-x')).toBe('gpt-x');
    expect(projectNameFromId('261023-black-october-fa2f')).toBe('Black october');
  });

  it('sample numbers add up', () => {
    const sample = sampleUsage('month', null, new Date('2026-11-02T12:00:00Z'));
    const c = sample.totals.claude;
    expect(c.total).toBe(c.input + c.output + c.cache_read + c.cache_write);
    expect(sample.series).toHaveLength(30);
    expect(sample.series.at(-1)?.date).toBe('2026-11-02');
  });
});

describe('stage rows in the token dropdown', () => {
  it('read as words and one row per stage name', () => {
    const rows = mergeByLabel([
      { key: 'voiceMusic', label: 'Voice & music', claude_tokens: 21000, elevenlabs_credits: 0 },
      { key: 'script', label: 'Script', claude_tokens: 255000, elevenlabs_credits: 0 },
      { key: 'voice', label: 'Voice & music', claude_tokens: 0, elevenlabs_credits: 1400 },
    ]);
    expect(rows).toEqual([
      { key: 'voiceMusic', label: 'Voice & music', claude_tokens: 21000, elevenlabs_credits: 1400 },
      { key: 'script', label: 'Script', claude_tokens: 255000, elevenlabs_credits: 0 },
    ]);
  });
});
