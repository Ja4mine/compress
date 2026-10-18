// The five levels, and what a unit shows at each.
//
// Same split as TextFold's ladder, for the same reason: a model told only to delete words paraphrases anyway, and
// pure deletion leaves the short levels meaningless. So the two long levels are the author's words and the three
// short ones are written:
//   1 全文 Full      the unit as written
//   2 摘句 Key       1 to 3 of its sentences, verbatim, picked by the model as the evidence for its point
//   3 精要 Brief     takeaway + one sentence of reason (written)
//   4 要点 Takeaway  one headline sentence (written)
//   5 主题 Topic     a few words a unit; the note becomes a map of section cards
// Without a model's ladder a unit folds locally, as TextFold's Claude Code mod folds a reply: its first sentences.

import { Section, sentencesOf, Unit } from './parse';
import { balance } from './sentences';

export const LEVELS = [
  { n: 1, name: '全文', hint: '原文，作者的每一个字' },
  { n: 2, name: '摘句', hint: '每段 1–3 句原句，一字不改（作者的话）' },
  { n: 3, name: '精要', hint: '每段的要点和理由（AI 撰写，依据是摘句）' },
  { n: 4, name: '要点', hint: '每段一行（AI 撰写）' },
  { n: 5, name: '主题', hint: '整篇变成一张章节地图（AI 撰写）' },
] as const;

export const ROLES = ['context', 'gap', 'claim', 'method', 'setup', 'result', 'analysis', 'limitation'] as const;
export const ROLE_NAMES: Record<string, string> = {
  context: '背景', gap: '不足', claim: '主张', method: '方法', setup: '设置', result: '结果', analysis: '分析', limitation: '局限',
};

export interface Lines { take: string; reason: string; topic: string }

export interface UnitLadder {
  role: string;
  ev: number[];        // evidence: the sentences level 2 shows
  orig: Lines;         // in the note's language
  tr?: Lines;          // in the reading language, when it differs
  model: string;
}

export interface SectionLadder {
  orig: { take: string; topic: string };
  tr?: { take: string; topic: string };
  model: string;
}

/** How a unit is shown in the reader's language mode. */
export type LangMode = 'orig' | 'both' | 'tr';

export interface UnitShow {
  md: string;          // Markdown to render, "" when hidden
  written: boolean;    // a model's words, not the author's
  more: boolean;       // this level hides some of the unit
}

const prefixed = (u: Unit, text: string) => (u.kind === 'quote' ? text.split('\n').map((l) => '> ' + l).join('\n') : u.marker + text);

export function joinSentences(sents: string[], cjk: boolean): string {
  return sents.filter(Boolean).join(cjk ? '' : ' ');
}

/** A unit at a level, from the original text and its ladder (null: fold locally). */
export function showUnit(u: Unit, level: number, lad: UnitLadder | null, firstInSection: boolean): UnitShow {
  const n = u.sents.length;
  if (level <= 1 || u.short) return { md: u.md, written: false, more: false };
  if (level === 2) {
    const ev = lad ? lad.ev : n >= 3 ? [0, 1] : [0];
    const ids = ev.filter((k) => k < n);
    const text = balance(sentencesOf(u, ids.length ? ids : [0]));
    return { md: prefixed(u, text + (ids.length < n ? ' …' : '')), written: false, more: ids.length < n };
  }
  if (lad && lad.orig.take) {
    const text = level === 3 ? brief(lad.orig.take, lad.orig.reason) : lad.orig.take;
    return { md: prefixed(u, text), written: true, more: true };
  }
  // local: the first sentence; at level 4 only a section's first unit speaks for it
  if (level >= 4 && !firstInSection) return { md: '', written: false, more: true };
  return { md: prefixed(u, balance(sentencesOf(u, [0])) + (n > 1 ? ' …' : '')), written: false, more: n > 1 };
}

/** The same, in the reading language: from the unit's sentence-aligned translation and the ladder's written lines. */
export function showUnitTr(u: Unit, level: number, lad: UnitLadder | null, tr: string[] | null, firstInSection: boolean, cjk: boolean): UnitShow | null {
  const n = u.sents.length;
  if (level <= 1 || u.short) {
    return tr ? { md: prefixed(u, joinSentences(tr, cjk)), written: false, more: false } : null;
  }
  if (level === 2) {
    if (!tr) return null;
    const ev = (lad ? lad.ev : n >= 3 ? [0, 1] : [0]).filter((k) => k < tr.length);
    const ids = ev.length ? ev : [0];
    return { md: prefixed(u, joinSentences(ids.map((k) => tr[k]), cjk) + (ids.length < n ? ' …' : '')), written: false, more: ids.length < n };
  }
  if (lad && lad.tr && lad.tr.take) {
    const text = level === 3 ? brief(lad.tr.take, lad.tr.reason) : lad.tr.take;
    return { md: prefixed(u, text), written: true, more: true };
  }
  if (lad && lad.orig.take) return null;
  if (level >= 4 && !firstInSection) return { md: '', written: false, more: true };
  return tr ? { md: prefixed(u, (tr[0] ?? '') + (n > 1 ? ' …' : '')), written: false, more: n > 1 } : null;
}

const CJK_TEXT = /[㐀-鿿぀-ヿ]/;

/** Takeaway and reason as one Brief: the takeaway closed with a stop, the reason after it. */
export function brief(take: string, reason: string): string {
  if (!reason) return take;
  const cjk = CJK_TEXT.test(take);
  const stop = (s: string) => (/[.!?。！？…:：]$/.test(s.trim()) ? '' : cjk ? '。' : '.');
  return `${take}${stop(take)}${cjk ? '' : ' '}${reason}${stop(reason)}`;
}

/** Whether every unit a section needs written has a ladder from a model. */
export function sectionDone(s: Section, units: (u: Unit) => UnitLadder | null, sec: SectionLadder | null): boolean {
  return !!sec && s.units.every((u) => u.short || !!units(u));
}
