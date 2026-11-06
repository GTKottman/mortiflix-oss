// Plain, short numbers for the token counter. Owner 2026-11-02: no money, tokens and credits only.

const whole = new Intl.NumberFormat('en-US');
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** The coin's count: at most 4 characters, e.g. 940, 12k, 1.2M. */
export function compactCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 9_950) return `${oneDecimal.format(n / 1000)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  if (n < 9_950_000) return `${oneDecimal.format(n / 1_000_000)}M`;
  if (n < 999_500_000) return `${Math.round(n / 1_000_000)}M`;
  return `${oneDecimal.format(n / 1_000_000_000)}B`;
}

/** Full count with separators: 48,210. */
export const fullCount = (n: number): string => whole.format(Math.round(n));

/** 1234, 'token' -> "1,234 tokens". */
export const countLabel = (n: number, word: string): string => `${fullCount(n)} ${word}${n === 1 ? '' : 's'}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-02" or an ISO time -> "2 Nov 2026" (the app's date style). Unknown -> ''. */
export function shortDate(value: string, { year = true }: { year?: boolean } = {}): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return '';
  const [, y, m, d] = match;
  const month = MONTHS[Number(m) - 1];
  if (!month) return '';
  return `${Number(d)} ${month}${year ? ` ${y}` : ''}`;
}

/** Share of the largest value, 0-1, for a bar's length. */
export const share = (value: number, largest: number): number => (largest > 0 ? value / largest : 0);
