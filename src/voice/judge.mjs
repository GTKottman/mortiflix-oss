// Judging a take against the script (moved out of vo.mjs so it is testable; vo.mjs loads it from $MFX_HOME/src/voice).
// Numbers compared as words: speech to text writes "29" or "29.5" where the script says "twenty-nine" (or the other way).
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function spell(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${spell(n % 100)}` : ''}`;
  for (const [v, w] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) if (n >= v) return `${spell(Math.floor(n / v))} ${w}${n % v ? ` ${spell(n % v)}` : ''}`;
  return String(n);
}
const numbers = (s) => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/\b(\d{1,12})(?:\.(\d+))?\b/g, (_, i, d) => {
  const n = Number(i);
  // years said as two pairs ("nineteen seventy-nine")
  const whole = !d && i.length === 4 && n >= 1100 && n < 2100 && n % 100 >= 10 && !(n >= 2000 && n < 2010) ? `${spell(Math.floor(n / 100))} ${spell(n % 100)}` : spell(n);
  return d ? `${whole} point ${[...d].map((c) => ONES[Number(c)]).join(' ')}` : whole;
});
const words = (s) => numbers(String(s).toLowerCase()).replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

// How much of the script was said: matched words (longest common subsequence) and the longest run left out or added.
function compare(script, transcript) {
  const a = words(script), b = words(transcript);
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, missing = 0, extra = 0, maxMissing = 0, maxExtra = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; missing = 0; extra = 0; }
    else if (j >= b.length || (i < a.length && dp[i + 1][j] >= dp[i][j + 1])) { i++; maxMissing = Math.max(maxMissing, ++missing); extra = 0; }
    else { j++; maxExtra = Math.max(maxExtra, ++extra); missing = 0; }
  }
  const matched = dp[0][0];
  return { similarity: a.length + b.length ? Math.round((2 * matched / (a.length + b.length)) * 1000) / 1000 : 1, longest_missing: maxMissing, longest_extra: maxExtra };
}


const SYMBOLS = (s) => String(s).replace(/&/g, ' and ').replace(/(\d)\s*%/g, '$1 percent').replace(/%/g, ' percent ');

// A transcript that differs only in casing, punctuation, digits-for-words, symbols or where a name is split ("PHP 2 Shell"
// heard as "PHP2Shell") says the script's words: it passes without another paid take.
export function judge(script, text, { events = [], threshold = 0.92 } = {}) {
  const a = SYMBOLS(script), b = SYMBOLS(text);
  const c = compare(a, b);
  const glued = (s) => words(s).join('');
  const raw = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const same = glued(a) === glued(b) || raw(a) === raw(b);
  const problems = [];
  if (!same && c.similarity < threshold) problems.push(`said ${Math.round(c.similarity * 100)}% of the words right`);
  if (!same && c.longest_missing >= 3) problems.push(`${c.longest_missing} words in a row missing`);
  if (!same && c.longest_extra >= 3) problems.push(`${c.longest_extra} extra words in a row`);
  if (events?.length) problems.push(`non-speech sounds: ${events.join(', ')} (a tag became a sound effect?)`);
  return { pass: !problems.length, compare: same ? { ...c, similarity: 1, longest_missing: 0, longest_extra: 0 } : c, problems };
}
