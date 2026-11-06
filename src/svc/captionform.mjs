// Captions in the script's written form, not the voice's spoken spelling (2026-11-02, d4fd final: "Character A I has
// over twenty million monthly users", "losing eight to nine million a month"). Names the voice spells out go back to
// their written form (svc/stills.mjs writtenForms: "Character A I" -> "Character.AI", "A I" -> "AI"), and numbers are set
// as an editor would: 10 and up in digits, money as "$8–9 million", dates as "October 12". One to nine stay words
// unless a scale follows ("two million" -> "2 million"). The words keep their timing: only the text changes.
import { toWritten } from './stills.mjs';

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const UNIT_RE = Object.keys(UNITS).join('|'), TENS_RE = Object.keys(TENS).join('|');
// "twenty", "twenty-one", "twenty one", "nine", "a hundred and five" (hundreds kept simple)
const NUM = `(?:(?:${UNIT_RE})\\s+hundred(?:\\s+and)?[\\s-]+)?(?:(?:${TENS_RE})(?:[\\s-](?:${Object.keys(UNITS).slice(1, 10).join('|')}))?|${UNIT_RE})|(?:${UNIT_RE})\\s+hundred`;
export function wordsToNumber(s) {
  let cur = 0;
  for (const w of String(s).toLowerCase().split(/[\s-]+/).filter((x) => x && x !== 'and')) {
    if (w in UNITS) cur += UNITS[w]; else if (w in TENS) cur += TENS[w]; else if (w === 'hundred') cur = (cur || 1) * 100; else return null;
  }
  return cur;
}
const SCALE = 'million|billion|thousand|trillion';

// the amounts the script shows as money on screen ("$8–9M", "$20M"): a spoken "eight to nine million" is set "$8–9 million"
export function moneyHints(scriptText = '') {
  const out = new Set();
  for (const m of String(scriptText).matchAll(/\$\s?(\d+(?:[.,]\d+)?)(?:\s?[–-]\s?(\d+(?:[.,]\d+)?))?/g)) out.add(m[2] ? `${m[1]}–${m[2]}` : m[1]);
  return out;
}

export function captionText(text, forms = [], money = new Set()) {
  let t = toWritten(String(text), forms);
  // "eight to nine million dollars" -> "$8–9 million"; "twenty-million-dollar" -> "$20 million"; "twenty million dollars" -> "$20 million"
  t = t.replace(new RegExp(`\\b(${NUM})\\s+to\\s+(${NUM})[\\s-]+(${SCALE})[\\s-]+dollars?\\b`, 'gi'), (m, a, b, sc) => `$${wordsToNumber(a)}–${wordsToNumber(b)} ${sc.toLowerCase()}`);
  t = t.replace(new RegExp(`\\b(${NUM})[\\s-]+(${SCALE})[\\s-]+dollars?\\b`, 'gi'), (m, a, sc) => `$${wordsToNumber(a)} ${sc.toLowerCase()}`);
  const $ = (n) => (money.has(n) ? `$${n}` : n);
  t = t.replace(new RegExp(`\\b(${NUM})\\s+to\\s+(${NUM})\\s+(${SCALE})\\b`, 'gi'), (m, a, b, sc) => `${$(`${wordsToNumber(a)}–${wordsToNumber(b)}`)} ${sc.toLowerCase()}`);
  t = t.replace(new RegExp(`\\b(${NUM})[\\s-]+(${SCALE})\\b`, 'gi'), (m, a, sc) => `${wordsToNumber(a)} ${sc.toLowerCase()}`); // a single amount is money only when said so ("dollars", above): "$20M" is also "20M+ users"
  // dates: "October twelfth" -> "October 12"
  t = t.replace(new RegExp(`\\b(${MONTHS})\\s+(?:the\\s+)?(${Object.keys(ORD).join('|')})\\b`, 'g'), (m, mo, o) => `${mo} ${ORD[o.toLowerCase()]}`);
  // the rest: 10 and up in digits ("Forty attorneys general" -> "40 attorneys general")
  t = t.replace(new RegExp(`\\b(${NUM})\\b`, 'gi'), (m) => { const n = wordsToNumber(m); return n !== null && n >= 10 ? String(n) : m; });
  return t;
}
