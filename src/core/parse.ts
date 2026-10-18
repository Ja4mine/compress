// A Markdown note as the reader sees it: sections (one per heading), and in each its blocks. A block is either a
// unit (a paragraph, a top-level list item or a quote: the things that fold) or a raw block (code, math, a table,
// an image, a callout: shown whole when zoomed in, as a placeholder or not at all when zoomed out).

import { hash } from './hash';
import { isCJK, Span, splitSentences, wordCount } from './sentences';

export type RawKind = 'code' | 'math' | 'table' | 'image' | 'callout' | 'html' | 'rule' | 'footnote';

export interface Unit {
  id: string;          // "u12"
  idx: number;         // paragraph number, from 1, in reading order: what a citation [P12] names
  kind: 'para' | 'item' | 'quote';
  md: string;          // the unit's Markdown as written (a list item with its marker and any nested items)
  text: string;        // its own prose: what is cut into sentences and sent to a model
  sents: Span[];       // offsets of its sentences in text
  marker: string;      // a list item's marker ("- ", "2. "), a quote's "> ", else ""
  line: number;        // first line in the note (0-based)
  hash: string;
  short: boolean;      // a single short sentence: every level shows it whole, no model needed
  section: string;     // id of the section it belongs to
}

export interface Raw {
  id: string;
  kind: RawKind;
  md: string;
  line: number;
  lines: number;
}

export type Block = { t: 'unit'; u: Unit } | { t: 'raw'; r: Raw };

export interface Section {
  id: string;          // "s3"
  level: number;       // heading level 1-6; 0 for the text before the first heading
  title: string;
  line: number;
  blocks: Block[];
  units: Unit[];
  hash: string;
}

export interface Doc {
  title: string;
  sections: Section[];
  units: Unit[];
  lang: 'zh' | 'ja' | 'ko' | 'en';
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const IMAGE = /^\s*(!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\))\s*$/;
const HTML = /^\s*<(div|table|details|figure|iframe|img|p|section|center|video|audio|svg|blockquote)\b/i;
const FOOTNOTE = /^\[\^[^\]]+\]:/;
const BLOCK_ID = /\s+\^[\w-]+\s*$/;

/** Words below which a one-sentence unit is shown whole at every level. */
const SHORT_WORDS = 14;

const indentOf = (s: string) => (/^\s*/.exec(s)?.[0] ?? '').replace(/\t/g, '    ').length;

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || /^\s*\$\$/.test(line) || /^\s*\|/.test(line) || /^\s*>/.test(line)
    || ITEM.test(line) || IMAGE.test(line) || RULE.test(line);
}

function plainTitle(md: string): string {
  return md.replace(BLOCK_ID, '').replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/[*_`=~]/g, '').trim();
}

export function parse(source: string, fallbackTitle: string): Doc {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  const units: Unit[] = [];
  let raws = 0;
  let sec: Section = { id: 's0', level: 0, title: '', line: 0, blocks: [], units: [], hash: '' };
  sections.push(sec);

  const addUnit = (kind: Unit['kind'], md: string, text: string, marker: string, line: number) => {
    text = text.replace(BLOCK_ID, '').trim();
    if (!text) return;
    const idx = units.length + 1;
    const sents = splitSentences(text);
    const u: Unit = {
      id: `u${idx}`, idx, kind, md, text, sents, marker, line, hash: hash(text.replace(/\s+/g, ' ')),
      short: sents.length <= 1 && wordCount(text) < SHORT_WORDS, section: sec.id,
    };
    units.push(u);
    sec.units.push(u);
    sec.blocks.push({ t: 'unit', u });
  };
  const addRaw = (kind: RawKind, from: number, to: number) => {
    const md = lines.slice(from, to).join('\n');
    if (!md.trim()) return;
    sec.blocks.push({ t: 'raw', r: { id: `r${++raws}`, kind, md, line: from, lines: to - from } });
  };

  let i = 0;
  if (lines[0]?.trim() === '---') {   // frontmatter
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (line.trim().startsWith('%%')) {   // an Obsidian comment
      const one = line.trim().length > 2 && line.trim().endsWith('%%');
      let j = i + 1;
      if (!one) while (j < lines.length && !lines[j].includes('%%')) j++;
      i = one ? i + 1 : j + 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) j++;
      addRaw('code', i, Math.min(j + 1, lines.length));
      i = j + 1;
      continue;
    }
    const head = HEADING.exec(line);
    if (head) {
      sec = { id: `s${sections.length}`, level: head[1].length, title: plainTitle(head[2]), line: i, blocks: [], units: [], hash: '' };
      sections.push(sec);
      i++;
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      const t = line.trim();
      let j = i;
      if (!(t.length > 2 && t.endsWith('$$'))) {
        j = i + 1;
        while (j < lines.length && !lines[j].includes('$$')) j++;
      }
      addRaw('math', i, Math.min(j + 1, lines.length));
      i = j + 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      addRaw('table', i, j);
      i = j;
      continue;
    }
    if (/^\s*>/.test(line)) {
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) j++;
      if (/^\s*>\s*\[!/.test(line)) {
        addRaw('callout', i, j);
      } else {
        const body = lines.slice(i, j).map((l) => l.replace(/^\s*>\s?/, ''));
        addUnit('quote', lines.slice(i, j).join('\n'), body.join('\n'), '> ', i);
      }
      i = j;
      continue;
    }
    if (RULE.test(line)) { addRaw('rule', i, i + 1); i++; continue; }
    if (IMAGE.test(line)) { addRaw('image', i, i + 1); i++; continue; }
    if (FOOTNOTE.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && /^\s{2,}/.test(lines[j])) j++;
      addRaw('footnote', i, j);
      i = j;
      continue;
    }
    if (HTML.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim()) j++;
      addRaw('html', i, j);
      i = j;
      continue;
    }
    if (ITEM.test(line)) {
      // the list: items, their continuation lines, and blank lines between them
      const base = indentOf(line);
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) {
          const next = lines.slice(j + 1).find((x) => x.trim());
          if (next !== undefined && (ITEM.test(next) && indentOf(next) >= base || indentOf(next) > base)) { j++; continue; }
          break;
        }
        if (FENCE.test(l) && indentOf(l) <= base || HEADING.test(l)) break;
        if (ITEM.test(l) || indentOf(l) > base || !startsBlock(l)) { j++; continue; }
        break;
      }
      // its top-level items, each a unit; nested items stay in the item's Markdown but not in its text
      let k = i;
      while (k < j) {
        const m = ITEM.exec(lines[k]);
        let e = k + 1;
        while (e < j && !(ITEM.test(lines[e]) && indentOf(lines[e]) <= base)) e++;
        if (m) {
          const marker = m[2] + ' ';
          const first = lines[k].slice(m[0].length).replace(/^\[.\]\s+/, '');
          const own = [first];
          for (let x = k + 1; x < e; x++) {
            if (!lines[x].trim() || ITEM.test(lines[x]) || FENCE.test(lines[x])) break;
            own.push(lines[x].trim());
          }
          const md = lines.slice(k, e).map((l) => l.slice(Math.min(base, indentOf(l)))).join('\n').replace(/\n+$/, '');
          addUnit('item', md, own.join('\n'), marker, k);
        }
        k = e;
      }
      i = j;
      continue;
    }
    // a paragraph
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !startsBlock(lines[j]) && !HTML.test(lines[j])) j++;
    const md = lines.slice(i, j).join('\n');
    addUnit('para', md, md, '', i);
    i = j;
  }

  const kept = sections.filter((s) => s.level > 0 || s.blocks.length);
  for (const s of kept) s.hash = hash(s.title + '\n' + s.units.map((u) => u.hash).join(','));
  let title = fallbackTitle;
  const h1 = kept.filter((s) => s.level === 1);
  if (h1.length === 1 && kept.indexOf(h1[0]) <= 1) title = h1[0].title || fallbackTitle;
  const all = units.map((u) => u.text).join('\n');
  const lang = /[぀-ヿ]/.test(all) && isCJK(all) ? 'ja' : /[가-힯]/.test(all) && isCJK(all) ? 'ko' : isCJK(all) ? 'zh' : 'en';
  return { title, sections: kept, units, lang };
}

/** A unit's sentences by index, as Markdown: neighbours joined as written, gaps marked with " … ". */
export function sentencesOf(u: Unit, idxs: number[]): string {
  const runs: string[] = [];
  const sorted = [...new Set(idxs)].filter((n) => n >= 0 && n < u.sents.length).sort((a, b) => a - b);
  let k = 0;
  while (k < sorted.length) {
    let e = k;
    while (e + 1 < sorted.length && sorted[e + 1] === sorted[e] + 1) e++;
    runs.push(u.text.slice(u.sents[sorted[k]][0], u.sents[sorted[e]][1]));
    k = e + 1;
  }
  return runs.join(' … ');
}

/** A unit's sentences as plain strings (newlines folded), for prompts. */
export function sentenceList(u: Unit): string[] {
  return u.sents.map(([s, e]) => u.text.slice(s, e).replace(/\s*\n\s*/g, ' '));
}

/** The paragraph a quoted passage comes from (a selection in a PDF view: line breaks and hyphens forgiven). */
export function unitByQuote(doc: Doc, quote: string): number | undefined {
  const norm = (s: string) => s.replace(/\\(.)/g, '$1').replace(/([A-Za-z])-\s+/g, '$1').replace(/\s+/g, '').toLowerCase();
  const q = norm(quote).slice(0, 60);
  if (q.length < 4) return undefined;
  return doc.units.find((u) => norm(u.text).includes(q))?.idx;
}
