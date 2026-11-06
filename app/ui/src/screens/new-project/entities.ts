// Link titles come from web pages, and some pages encode them twice ("&amp;mdash;"). The service decodes
// them; this is the guard for titles saved before it did, so the tray never shows a raw entity.

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
};

const ENTITY = /&(#x?[0-9a-f]+|[a-z]+[0-9]*);/gi;

function decodeOnce(text: string): string {
  return text.replace(ENTITY, (whole, name: string) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? whole;
    const hex = name[1]?.toLowerCase() === 'x';
    const code = hex ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** The title as words: named and numeric entities decoded, a doubly encoded one too. */
export function decodeTitle(text: string): string {
  const once = decodeOnce(text);
  return /&amp;/i.test(text) ? decodeOnce(once) : once;
}
