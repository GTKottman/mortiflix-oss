// The token counter's data, as the panel uses it. The service's `usage.get` answer (src/svc/ledger.mjs,
// docs/service-protocol.md "Usage ledger") is turned into this by normalize.ts.
// Owner 2026-11-02: no money anywhere. Claude is counted in tokens, ElevenLabs in credits.

/** The dropdown's tabs. 'project' = all time for the open project. */
export type UsageRange = 'today' | 'week' | 'month' | 'all' | 'project';

export interface ClaudeTokens {
  /** Fresh input only. */
  input: number;
  output: number;
  /** Claude re-reading text it has already seen; usually most of the total. */
  cache_read: number;
  cache_write: number;
  total: number;
  calls: number;
}

export interface UsageTotals {
  claude: ClaudeTokens;
  elevenlabs: { credits: number; calls: number };
}

/** One row of by_project / by_stage / by_model. */
export interface UsageGroup {
  key: string;
  label: string;
  claude_tokens: number;
  elevenlabs_credits: number;
}

/** One day of the 30-day series. `date` is YYYY-MM-DD. */
export interface UsageDay {
  date: string;
  claude_tokens: number;
  elevenlabs_credits: number;
}

/** High scores, all time. Each is null until there is something to count. */
export interface UsageRecords {
  biggest_day: { date: string; claude_tokens: number } | null;
  biggest_project: { key: string; label: string; claude_tokens: number } | null;
  biggest_call: { at: string; claude_tokens: number; model: string; stage: string } | null;
  streak: { longest: number; current: number };
}

export interface ElevenLabsBalance {
  remaining: number;
  limit: number;
  resets_at: string;
  /** The last check failed; these are the last known numbers. */
  stale: boolean;
}

export interface Usage {
  range: UsageRange;
  project: string | null;
  totals: UsageTotals;
  by_project: UsageGroup[];
  by_stage: UsageGroup[];
  by_model: UsageGroup[];
  series: UsageDay[];
  records: UsageRecords;
  elevenlabs: ElevenLabsBalance | null;
  /** Why the balance is unknown, in the service's words. */
  elevenlabs_why: string;
}

/** Where the numbers came from: the service, or sample numbers while `usage.get` is not there. */
export type UsageSource = 'service' | 'sample';
