// Sentences of a Markdown paragraph, as [start, end) offsets into it.
//
// A sentence never ends inside inline code, math, a link, a wikilink, an HTML tag or a URL. A Chinese or Japanese
// stop ends a sentence without a space after it; a Latin stop needs a space (or the end) after it, and is not an
// abbreviation ("e.g.", "Fig.", "et al.") or an initial ("J. Smith").

const PROTECT = /`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>|https?:\/\/[^\s)>\]]+|\[\^[^\]\n]+\]/g;
const ABBREV = /(?:^|[\s(\[])(?:e\.g|i\.e|E\.g|I\.e|etc|vs|cf|al|approx|resp|viz|ca|pp|fig|figs|eq|eqs|sec|ref|refs|Dr|Mr|Mrs|Ms|Prof|Fig|Figs|Eq|Eqs|Eqn|Sec|Secs|Tab|No|Nos|Vol|Ref|Refs|Ch|St|Jr|Sr|Inc|Ltd|Co|Thm|Lem|Def|Prop|Cor|Alg|Ex|App)\.$/;
const INITIAL = /(?:^|[\s(])[A-Z]\.$/;
const CLOSERS = `"'”’)]}」』）】》*_~=`;

export type Span = [number, number];

function protectedRanges(text: string): Span[] {
  const out: Span[] = [];
  PROTECT.lastIndex = 0;
  for (let m = PROTECT.exec(text); m; m = PROTECT.exec(text)) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) PROTECT.lastIndex++;
  }
  return out;
}

/** The sentences of a paragraph as offsets, each trimmed, together covering all of its text. */
export function splitSentences(text: string): Span[] {
  const ranges = protectedRanges(text);
  const out: Span[] = [];
  let start = 0;
  let r = 0;
  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push([s, e]);
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    while (r < ranges.length && ranges[r][1] <= i) r++;
    if (r < ranges.length && ranges[r][0] <= i && i < ranges[r][1]) {
      i = ranges[r][1] - 1;
      continue;
    }
    const c = text[i];
    if ('。！？'.includes(c) || (c === '…' && text[i + 1] === '…')) {
      let j = i + 1;
      while (j < text.length && (text[j] === '…' || '！？'.includes(text[j]))) j++;
      while (j < text.length && CLOSERS.includes(text[j])) j++;
      push(j);
      i = j - 1;
      continue;
    }
    if (!'.!?'.includes(c)) continue;
    let j = i + 1;
    while (j < text.length && '.!?'.includes(text[j])) j++;   // "?!", "..."
    while (j < text.length && CLOSERS.includes(text[j])) j++;
    if (j < text.length && !/\s/.test(text[j])) continue;       // "3.5", "a.b", "U.S.A"
    const head = text.slice(0, i + 1);
    if (c === '.' && (ABBREV.test(head) || INITIAL.test(head))) continue;
    // a full stop followed by a lowercase word is rarely a sentence's end ("approx. the", "p. 3")
    const next = /\S/.exec(text.slice(j));
    if (c === '.' && next && /[a-z]/.test(next[0])) continue;
    push(j);
    i = j - 1;
  }
  push(text.length);
  return out;
}

/** Closes the emphasis a cut left open: a sentence cut out of "**A. B.**" gets its other half back. */
export function balance(s: string): string {
  for (const mark of ['**', '==', '~~']) {
    const n = s.split(mark).length - 1;
    if (n % 2) s = s.startsWith(mark) ? s + mark : mark + s;
  }
  const ticks = (s.match(/`/g) ?? []).length;
  if (ticks % 2) s += '`';
  return s;
}

export const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/g;

/** Reading length: words for Latin text, characters for CJK. */
export function wordCount(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.replace(CJK, ' ').match(/[A-Za-z0-9][\w'’-]*/g) ?? []).length;
  return cjk + latin;
}

/** Whether a text is written mostly in a CJK script. */
export function isCJK(text: string): boolean {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.replace(CJK, ' ').match(/[A-Za-z]+/g) ?? []).length;
  return cjk > latin * 1.5;
}
