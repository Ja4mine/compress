// A PDF's text as Markdown the reader can fold: text items (as PDF.js gives them, with positions, sizes and fonts)
// become lines, lines are put in reading order (two columns read left then right, between full-width lines),
// running headers, footers and page numbers are dropped, and lines become headings and paragraphs. What does not
// read as prose (figure labels, table cells, the author block, the references) goes into collapsed callouts: shown
// when opened, never cut into units, never sent to a model to fold.
//
// Every Markdown line remembers its page, so a paragraph can open the PDF where it is.

export interface PdfItem { s: string; x: number; y: number; w: number; size: number; font: string }
export interface PdfPage { w: number; h: number; items: PdfItem[] }

interface Line {
  page: number;
  x0: number;
  x1: number;
  y: number;
  size: number;
  font: string;
  text: string;
  row: number;       // how many segments its row of the page was split into (3 or more: a table)
  col: 0 | 1 | 2;    // full width, left column, right column
}

export interface Layout { md: string; pages: number[]; title: string }

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/;   // (with CJK punctuation)
const TERMINAL = /[.!?:。！？：;；)）"”'’]$/;
const KNOWN = /^(abstract|introduction|background|related work|preliminaries|method(s|ology)?|approach|experiments?|experimental (setup|results)|results|evaluation|discussion|analysis|conclusions?|limitations|future work|acknowledge?ments?|references|bibliography|appendix|摘要|引言|绪论|相关工作|方法|实验|结果|讨论|结论|致谢|参考文献|附录)$/i;
const REFERENCES = /^(references|bibliography|参考文献)$/i;
const NUMBERED = /^((\d+(\.\d+)*)\.?|[IVX]+\.|[A-H](\.\d+)*\.?)\s+(\S.*)$/;
const CAPTION = /^(figure|fig\.|table|algorithm|图|表)\s*[\dIVX]+[.:：]?/i;

/** Reading length: Latin words, and CJK characters two to a word (a line of Chinese is not "one word"). */
function wc(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) ?? []).length;
  const latin = (text.replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, ' ').match(/\S+/g) ?? []).length;
  return latin + Math.ceil(cjk / 2);
}

// Some PDFs' fonts map common characters to Kangxi radicals (⽂ for 文) or radical forms (⻓ for 长): NFKC mends the
// first, this table the frequent second.
const RADICALS: Record<string, string> = {
  '⻓': '长', '⻔': '门', '⻛': '风', '⻢': '马', '⻜': '飞', '⻝': '食', '⻨': '麦', '⻅': '见', '⻆': '角', '⻉': '贝',
  '⻋': '车', '⻚': '页', '⻥': '鱼', '⻦': '鸟', '⻩': '黄', '⻬': '齐', '⻮': '齿', '⻰': '龙', '⻳': '龟', '⻊': '足',
  '⻘': '青', '⻙': '韦', '⺠': '民', '⺟': '母', '⻄': '西', '⻣': '骨', '⻤': '鬼', '⻗': '雨', '⻑': '長',
};
export function mendText(s: string): string {
  // (only that block: NFKC on everything would turn full-width punctuation "\uff0c\uff1a" into ASCII)
  return s.replace(/[\u2f00-\u2fdf]/g, (c) => c.normalize('NFKC')).replace(/[\u2e80-\u2eff]/g, (c) => RADICALS[c] ?? c);
}

function mode(values: number[]): number {
  const count = new Map<number, number>();
  let best = values[0] ?? 0;
  for (const v of values) {
    const n = (count.get(v) ?? 0) + 1;
    count.set(v, n);
    if (n > (count.get(best) ?? 0)) best = v;
  }
  return best;
}

const round = (v: number, step = 0.5) => Math.round(v / step) * step;

/** Joins two pieces of text the way they would read: a space between words, none between CJK characters. */
function glue(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  if (CJK.test(a.slice(-1)) && CJK.test(b[0])) return a + b;
  return `${a} ${b}`;
}

/** Joins a line onto the paragraph before it: a word broken by a hyphen at the line's end is mended. */
function joinLine(a: string, b: string): string {
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return glue(a, b);
}

/** Text as Markdown that renders as the same text: no emphasis, math, HTML or block markers by accident. */
export function escapeMd(s: string): string {
  return s
    .replace(/([\\`*$])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/\[\[/g, '[\\[')
    .replace(/\]\(/g, ']\\(')
    .replace(/==/g, '=\\=')
    .replace(/~~/g, '~\\~')
    .replace(/%%/g, '%\\%')
    .replace(/^([#>|+-])/, '\\$1');
}

// ---------------------------------------------------------------------------------------------------------------
// items → lines

export function linesOf(page: PdfPage, p: number): Line[] {
  const items = page.items.filter((it) => it.s.trim()).map((it) => ({ ...it, s: mendText(it.s) })).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfItem[][] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    const ref = row?.[0];
    if (row && Math.abs(ref.y - it.y) <= 0.45 * Math.max(ref.size, it.size)) row.push(it);
    else rows.push([it]);
  }
  const out: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const segs: PdfItem[][] = [[row[0]]];
    const mid = page.w / 2;
    const near = page.w * 0.015;
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1];
      const end = prev.x + prev.w;
      const gap = row[i].x - end;
      const size = Math.max(prev.size, row[i].size);
      // a wide gap, or a narrower one exactly at the gutter between two columns (17pt in ACL's layout)
      const gutter = end < mid + near && row[i].x > mid - near && gap > 0.6 * size;   // (the gap spans the middle)
      // a section number keeps its title, however wide the space after it ("4    Experiments")
      const number = /^([\dIVX]+|[A-H])(\.\d+)*\.?$/.test(segs[segs.length - 1].map((x) => x.s).join('').trim()) && gap < 4 * size && !gutter;
      if ((gap > Math.max(1.3 * size, 10) || gutter) && !number) segs.push([row[i]]);
      else segs[segs.length - 1].push(row[i]);
    }
    // a row's segments on the same side of the page: a table in one column says nothing of the text in the other
    const side = (seg: PdfItem[]) => {
      const a = seg[0].x;
      const b = seg[seg.length - 1].x + seg[seg.length - 1].w;
      return b < mid + page.w * 0.03 ? 1 : a > mid - page.w * 0.03 ? 2 : 0;
    };
    const sides = segs.map(side);
    for (const [k, seg] of segs.entries()) {
      const peers = sides[k] ? sides.filter((x) => x === sides[k]).length : segs.length;
      let text = '';
      for (let i = 0; i < seg.length; i++) {
        const it = seg[i];
        const prev = seg[i - 1];
        const gap = prev ? it.x - (prev.x + prev.w) : 0;
        text = prev && gap > 0.12 * it.size ? glue(text, it.s) : text + it.s;
      }
      const chars = new Map<string, number>();
      const sizes = new Map<number, number>();
      for (const it of seg) {
        chars.set(it.font, (chars.get(it.font) ?? 0) + it.s.length);
        sizes.set(round(it.size), (sizes.get(round(it.size)) ?? 0) + it.s.length);
      }
      const top = <K,>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const last = seg[seg.length - 1];
      out.push({
        page: p, x0: seg[0].x, x1: last.x + last.w, y: seg[0].y, size: top(sizes), font: top(chars),
        text: text.replace(/\s+/g, ' ').trim(), row: peers, col: 0,
      });
    }
  }
  return out.filter((l) => l.text);
}

// ---------------------------------------------------------------------------------------------------------------
// reading order

export function columns(lines: Line[], w: number): Line[] {
  const mid = w / 2;
  const slack = w * 0.03;
  for (const l of lines) l.col = l.x1 < mid + slack ? 1 : l.x0 > mid - slack ? 2 : 0;
  const prose = (c: number) => lines.filter((l) => l.col === c && l.x1 - l.x0 > w * 0.2).length;
  if (prose(1) < 4 || prose(2) < 4) {
    for (const l of lines) l.col = 0;
    return lines;
  }
  // bands between full-width lines; in each band the left column, then the right
  const out: Line[] = [];
  let band: Line[] = [];
  const flush = () => {
    out.push(...band.filter((l) => l.col === 1), ...band.filter((l) => l.col === 2));
    band = [];
  };
  for (const l of lines) {   // (already top to bottom)
    if (l.col === 0 && l.text.length > 3) {
      flush();
      out.push(l);
    } else {
      band.push(l);
    }
  }
  flush();
  return out;
}

/** Running headers and footers: text near the top or bottom edge that comes back on other pages, and page numbers. */
function furniture(pages: PdfPage[], all: Line[][]): Set<Line> {
  const drop = new Set<Line>();
  const key = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const seen = new Map<string, number>();
  const edge = (l: Line) => l.y > pages[l.page].h * 0.92 || l.y < pages[l.page].h * 0.08;
  for (const lines of all) {
    const keys = new Set(lines.filter(edge).map((l) => key(l.text)));
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const repeats = Math.max(2, Math.ceil(pages.length * 0.3));
  for (const lines of all) {
    for (const l of lines) {
      if (!edge(l)) continue;
      if (/^(page\s*)?[#\divxlc]+(\s*(of|\/)\s*\d+)?$/i.test(l.text) || /^第\s*\d+\s*页/.test(l.text) || (seen.get(key(l.text)) ?? 0) >= repeats) drop.add(l);
    }
  }
  return drop;
}

// ---------------------------------------------------------------------------------------------------------------
// lines → Markdown

export function layout(pages: PdfPage[]): Layout {
  const perPage = pages.map((p, i) => linesOf(p, i).sort((a, b) => b.y - a.y || a.x0 - b.x0));
  const drop = furniture(pages, perPage);
  const lines = perPage.flatMap((ls, i) => columns(ls.filter((l) => !drop.has(l)), pages[i].w));
  const out: string[] = [];
  const outPages: number[] = [];
  if (!lines.length) return { md: '', pages: [], title: '' };

  // the body: the size and font most of the text is set in, and its line spacing
  const weighted: number[] = [];
  const fonts = new Map<string, number>();
  for (const l of lines) {
    for (let k = 0; k < Math.min(l.text.length, 200); k += 10) weighted.push(l.size);
  }
  const body = mode(weighted);
  for (const l of lines) if (Math.abs(l.size - body) < 0.6) fonts.set(l.font, (fonts.get(l.font) ?? 0) + l.text.length);
  const bodyFont = [...fonts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    if (a.page === b.page && a.col === b.col && Math.abs(a.size - body) < 0.6 && Math.abs(b.size - body) < 0.6 && a.y > b.y) gaps.push(round(a.y - b.y));
  }
  const spacing = mode(gaps.filter((g) => g > body * 0.8 && g < body * 2.2)) || body * 1.2;

  // each column's left edge on each page (for indents) and right edge (for a line that ends short)
  const edges = new Map<string, { left: number; right: number }>();
  for (const l of lines) {
    if (Math.abs(l.size - body) > 0.6 || wc(l.text) < 8) continue;
    const k = `${l.page}:${l.col}`;
    const e = edges.get(k) ?? { left: Infinity, right: -Infinity };
    e.left = Math.min(e.left, l.x0);
    e.right = Math.max(e.right, l.x1);
    edges.set(k, e);
  }
  const edgeOf = (l: Line) => edges.get(`${l.page}:${l.col}`) ?? { left: l.x0, right: l.x1 };

  // headings
  const headingLevel = (l: Line): number => {
    const t = l.text;
    if (t.length > 120 || /[,;，；]$/.test(t) || !/[A-Za-z]{2}|[\u3400-\u9fff]/.test(t)) return 0;   // ("E E": a figure's labels)
    const bare = t.replace(NUMBERED, '$5').trim();
    const num = NUMBERED.exec(t);
    const bigger = l.size > body * 1.12;
    const own = l.font !== bodyFont;
    const words = wc(t);
    const depth = num ? num[1].replace(/\.$/, '').split('.').length : 0;   // "3.2 Method" and "A.1 Setup" are 2 deep
    if (bigger && words <= 15 && !/\.$/.test(t)) return l.size > body * 1.6 ? 1 : depth ? Math.min(5, 1 + depth) : 2;
    if (KNOWN.test(bare) && (own || num || l.size >= body - 0.2) && words <= 4) return depth ? Math.min(5, 1 + depth) : 2;
    if (num && own && words <= 12 && !/[.。]$/.test(t) && /^[A-Z㐀-鿿]/.test(num[5])) return Math.min(5, 1 + Math.max(1, depth));
    return 0;
  };

  type Block = { kind: 'h'; level: number; text: string; page: number; size: number; line: Line }
    | { kind: 'p'; text: string; page: number; size: number }
    | { kind: 'aux'; lines: string[]; page: number }
    | { kind: 'foot'; text: string; page: number };
  const blocks: Block[] = [];
  let para: { text: string; page: number; size: number; last: Line } | null = null;
  let aux: { lines: string[]; page: number } | null = null;
  const endPara = () => {
    if (para) {
      // a footnote: smaller than the body, opening with its mark
      const foot = para.size < body - 0.6 && /^[∗*†‡§¶]|^\d{1,2}[A-Za-z㐀-鿿]/.test(para.text);
      blocks.push(foot ? { kind: 'foot', text: para.text, page: para.page } : { kind: 'p', text: para.text, page: para.page, size: para.size });
    }
    para = null;
  };
  const endAux = () => {
    if (aux) blocks.push({ kind: 'aux', lines: aux.lines, page: aux.page });
    aux = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = headingLevel(l);
    const prevBlock = blocks[blocks.length - 1];
    if (!para && !aux && prevBlock?.kind === 'h' && !h) {
      // a heading's second line: the same font and size, right below, short and not a sentence
      const hl = prevBlock.line;
      if (l.page === hl.page && l.col === hl.col && l.font === hl.font && Math.abs(l.size - hl.size) < 0.3 && hl.y - l.y < l.size * 1.8) {
        if (wc(l.text) <= 8 && !TERMINAL.test(l.text)) {
          prevBlock.text = glue(prevBlock.text, l.text);
          prevBlock.line = l;
          continue;
        }
        if (TERMINAL.test(l.text) && wc(prevBlock.text) > 8) {
          // it was a paragraph set large (a notice above the title), not a heading: it ends in a sentence
          blocks[blocks.length - 1] = { kind: 'p', text: joinLine(prevBlock.text, l.text), page: prevBlock.page, size: l.size };
          continue;
        }
      }
    }
    if (h) {
      endPara();
      endAux();
      if (prevBlock?.kind === 'h' && prevBlock.level === h && prevBlock.page === l.page && i > 0 && headingLevel(lines[i - 1]) === h
        && Math.abs(prevBlock.line.size - l.size) < 0.3 && prevBlock.line.y - l.y < l.size * 1.8 && !NUMBERED.test(l.text)) {
        prevBlock.text = glue(prevBlock.text, l.text);   // a heading set over two lines
        prevBlock.line = l;
      } else {
        blocks.push({ kind: 'h', level: h, text: l.text, page: l.page, size: l.size, line: l });
      }
      continue;
    }
    // what is not prose: table rows, equations, and short labels in sizes other than the body's
    const words = wc(l.text);
    const tokens = l.text.split(/\s+/);
    const numeric = tokens.length >= 3 && tokens.filter((t) => /^[-+±(]?[\d.,%]+[)*†]?$/.test(t)).length >= tokens.length * 0.6;
    const tabular = l.row >= 3 || (l.row === 2 && l.col === 0 && words <= 6) || numeric;
    const colWidth = pages[l.page].w * (l.col ? 0.4 : 0.75);
    const label = Math.abs(l.size - body) > 0.6 && words <= 4 && l.x1 - l.x0 < colWidth * 0.6 && !TERMINAL.test(l.text) && !CAPTION.test(l.text);
    const equation = /\(\d{1,3}\)$/.test(l.text) && /[=≤≥≈∑∏√∫]/.test(l.text) && words <= 25;
    if (tabular || label || equation) {
      // a paragraph whose sentence is not finished goes on after it (a subscript, a figure set mid-paragraph)
      if (para && TERMINAL.test(para.last.text)) endPara();
      if (!aux || aux.page !== l.page) {
        endAux();
        aux = { lines: [], page: l.page };
      }
      aux.lines.push(l.text);
      continue;
    }
    endAux();
    if (para) {
      const a = para.last;
      const e = edgeOf(l);
      const ea = edgeOf(a);
      const sameFlow = a.page === l.page && a.col === l.col;
      const gap = a.y - l.y;
      const indented = l.x0 - e.left > Math.max(0.8 * l.size, 6) && l.x0 - e.left < 6 * l.size;
      const shortEnd = a.x1 < ea.right - Math.max(0.15 * (ea.right - ea.left), 3 * a.size);
      const ended = TERMINAL.test(a.text);
      const goesOn = !ended && /^[a-z(]/.test(l.text);   // the sentence continues, whatever stood between
      let breaks: boolean;
      if (Math.abs(l.size - para.size) > 0.6) breaks = true;
      else if (CAPTION.test(l.text) && (ended || !sameFlow || gap > spacing * 1.35)) breaks = true;   // ("shown in / Table 6.")
      else if (goesOn) breaks = false;
      else if (sameFlow) breaks = gap > spacing * 1.35 || gap < 0 || (indented && ended) || (shortEnd && ended);
      else breaks = ended && (indented || shortEnd);   // a new column or page: the paragraph goes on unless it ended
      if (!breaks) {
        para.text = joinLine(para.text, l.text);
        para.last = l;
        continue;
      }
      endPara();
    }
    para = { text: l.text, page: l.page, size: l.size, last: l };
  }
  endPara();
  endAux();

  // fragments that read as nothing on their own ("dk", "QKT": pieces of a formula) join the figure text beside them
  const tidy: Block[] = [];
  for (const b of blocks) {
    const fragment = b.kind === 'p' && wc(b.text) <= 3 && !TERMINAL.test(b.text) && !CAPTION.test(b.text);
    const cur: Block = fragment ? { kind: 'aux', lines: [(b as { text: string }).text], page: b.page } : b;
    const last = tidy[tidy.length - 1];
    if (cur.kind === 'aux' && last?.kind === 'aux' && last.page === cur.page) last.lines.push(...cur.lines);
    else if (cur.kind === 'foot' && last?.kind === 'foot' && last.page === cur.page) last.text += '\n' + cur.text;
    else tidy.push(cur);
  }

  // Markdown, with the title first, the author block, figures, footnotes and references collapsed
  const push = (text: string, page: number) => {
    for (const line of text.split('\n')) {
      out.push(line);
      outPages.push(page);
    }
  };
  const callout = (head: string, rows: string[], page: number, list = false) =>
    push([head, ...rows.map((r) => `> ${list ? '- ' : ''}${escapeMd(r)}`)].join('\n') + '\n', page);
  // the title: the largest heading on the first page, above its first named section ("Abstract", "Introduction")
  let titleAt = -1;
  const named = tidy.findIndex((b) => b.kind === 'h' && KNOWN.test(b.text.replace(NUMBERED, '$5').trim()));
  tidy.forEach((b, k) => {
    if (b.kind !== 'h' || b.page !== 0 || (named >= 0 && k >= named) || b.size < body * 1.2 || wc(b.text) > 20) return;
    const best = tidy[titleAt];
    if (!best || (best.kind === 'h' && b.size > best.size + 0.3)) titleAt = k;
  });
  const title = titleAt >= 0 ? (tidy[titleAt] as { text: string }).text : '';
  // between the title and the first section: authors and affiliations (unless it is prose: a paper without headings)
  const firstSection = titleAt >= 0 ? tidy.findIndex((b, k) => k > titleAt && b.kind === 'h') : -1;
  const front = titleAt >= 0 ? tidy.slice(titleAt + 1, firstSection < 0 ? titleAt + 1 : firstSection) : [];
  const ABSTRACT = /^(abstract|摘\s*要)[\s:：.—-]*/i;
  const prose = (x: Block) => x.kind === 'p' && (wc(x.text) > 40 || ABSTRACT.test(x.text));
  const meta = new Set(front.filter((x) => !prose(x)));
  let inRefs = false;
  let refs: string[] = [];
  let refsPage = 0;
  const flushRefs = () => {
    if (refs.length) callout('> [!quote]- 参考文献', refs, refsPage, true);
    refs = [];
  };
  tidy.forEach((b, k) => {
    if (k === titleAt) {
      push(`# ${escapeMd(b.kind === 'h' ? b.text : '')}\n`, b.page);
      if (meta.size) {
        const rows = [...meta].flatMap((x) => (x.kind === 'aux' ? x.lines : x.kind === 'p' || x.kind === 'h' || x.kind === 'foot' ? [x.text] : []));
        callout('> [!info]- 作者与单位', rows, b.page);
      }
      return;
    }
    if (meta.has(b)) return;   // (in the callout above)
    if (b.kind === 'p' && ABSTRACT.test(b.text) && wc(b.text) > 12) {   // an abstract run in with its label
      push(`## ${ABSTRACT.exec(b.text)![1]}\n`, b.page);
      push(`${escapeMd(b.text.replace(ABSTRACT, ''))}\n`, b.page);
      return;
    }
    if (b.kind === 'h') {
      const bare = b.text.replace(NUMBERED, '$5').trim();
      if (inRefs) {
        if (/^(appendix|附录)/i.test(bare) || /^[A-H](\.\d+)*\.?\s/.test(b.text)) {
          flushRefs();
          inRefs = false;
        } else {
          refs.push(b.text);
          return;
        }
      }
      push(`${'#'.repeat(Math.min(6, Math.max(2, b.level)))} ${escapeMd(b.text)}\n`, b.page);
      if (REFERENCES.test(bare)) {
        inRefs = true;
        refsPage = b.page;
      }
      return;
    }
    if (inRefs) {
      if (b.kind === 'aux') refs.push(...b.lines);
      else refs.push(b.text);
      return;
    }
    if (b.kind === 'aux') return callout(`> [!example]- 图表与公式（第 ${b.page + 1} 页）`, b.lines, b.page);
    if (b.kind === 'foot') return callout('> [!note]- 脚注', b.text.split('\n'), b.page);
    push(`${escapeMd(b.text)}\n`, b.page);
  });
  flushRefs();
  // the page of each line, 1-based for the PDF viewer
  return { md: out.join('\n'), pages: outPages.map((p) => p + 1), title };
}
