import type { Usage, UsageDay, UsageRange } from './types';

// Sample numbers for the token counter when the service has no `usage.get` (an older service) and for the kit.
// The panel says so in words ("Sample numbers"), so they are never mistaken for real use.

function sampleSeries(today: Date): UsageDay[] {
  const days: UsageDay[] = [];
  for (let back = 29; back >= 0; back--) {
    const date = new Date(today);
    date.setDate(today.getDate() - back);
    const wave = Math.abs(Math.sin(back * 1.7 + 0.6)) * 1_600_000 + (back % 6 === 0 ? 0 : 200_000);
    days.push({
      date: date.toISOString().slice(0, 10),
      claude_tokens: back % 9 === 4 ? 0 : Math.round(wave),
      elevenlabs_credits: back % 4 === 0 ? Math.round(wave / 4000) : 0,
    });
  }
  return days;
}

const SCALE: Record<UsageRange, number> = { today: 1, week: 6, month: 24, all: 61, project: 9 };

export function sampleUsage(range: UsageRange, project: string | null, today = new Date()): Usage {
  const k = SCALE[range];
  const claude = { input: 260 * k, output: 41_800 * k, cache_read: 1_402_000 * k, cache_write: 96_300 * k };
  return {
    range,
    project,
    totals: {
      claude: {
        ...claude,
        total: claude.input + claude.output + claude.cache_read + claude.cache_write,
        calls: 31 * k,
      },
      elevenlabs: { credits: 215 * k, calls: 6 * k },
    },
    by_project: [
      {
        key: 'black-october',
        label: 'Black October',
        claude_tokens: 921_000 * k,
        elevenlabs_credits: 140 * k,
      },
      { key: 'plex2shell', label: 'Plex2Shell', claude_tokens: 403_000 * k, elevenlabs_credits: 50 * k },
      {
        key: 'linear-algebra-2',
        label: 'Linear algebra 2',
        claude_tokens: 216_360 * k,
        elevenlabs_credits: 25 * k,
      },
    ],
    by_stage: [
      { key: 'script', label: 'Script', claude_tokens: 298_000 * k, elevenlabs_credits: 0 },
      { key: 'voice', label: 'Voice & music', claude_tokens: 41_000 * k, elevenlabs_credits: 190 * k },
      { key: 'look', label: 'Look', claude_tokens: 512_000 * k, elevenlabs_credits: 0 },
      { key: 'stills', label: 'Stills', claude_tokens: 401_000 * k, elevenlabs_credits: 0 },
      { key: 'motion', label: 'Motion', claude_tokens: 236_360 * k, elevenlabs_credits: 0 },
      { key: 'sound', label: 'Sound', claude_tokens: 52_000 * k, elevenlabs_credits: 25 * k },
    ],
    by_model: [
      { key: 'claude:opus', label: 'Opus 5.5', claude_tokens: 1_109_000 * k, elevenlabs_credits: 0 },
      { key: 'claude:sonnet', label: 'Sonnet 5', claude_tokens: 382_000 * k, elevenlabs_credits: 0 },
      { key: 'claude:haiku', label: 'Haiku 4.5', claude_tokens: 49_360 * k, elevenlabs_credits: 0 },
      { key: 'elevenlabs:v4', label: 'ElevenLabs v4', claude_tokens: 0, elevenlabs_credits: 215 * k },
    ],
    series: sampleSeries(today),
    records: {
      biggest_day: { date: '2026-10-23', claude_tokens: 6_715_932 },
      biggest_project: { key: 'black-october', label: 'Black October', claude_tokens: 10_272_703 },
      biggest_call: { at: '2026-10-24', claude_tokens: 3_556_771, model: 'Opus 5.5', stage: 'Look' },
      streak: { longest: 6, current: 2 },
    },
    elevenlabs: { remaining: 61_300, limit: 100_000, resets_at: '2026-11-18', stale: false },
    elevenlabs_why: '',
  };
}
