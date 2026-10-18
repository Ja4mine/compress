// Writing a note's levels and translations, section by section, a few calls at a time, into the store.

import { hash } from '../core/hash';
import { SectionLadder, UnitLadder } from '../core/levels';
import { Doc, Section, Unit } from '../core/parse';
import { PROMPT_VERSION, Store } from '../core/store';
import {
  ladderPrompt, ladderSchema, LadderReply, parts, readLadder, readTranslation, sameLang, SYSTEM_FOLD, SYSTEM_TRANSLATE,
  translatePrompt, translateSchema, TranslateReply,
} from './prompts';
import type { CallOpts, Task } from './llm';

export interface Caller {
  json<T>(o: CallOpts): Promise<T>;
  model(task: Task): string;
}

export interface EngineSettings { target: string; concurrency: number; glossary: string }

export interface RunOpts {
  signal?: AbortSignal;
  progress?: (done: number, total: number) => void;
  onSection?: (s: Section) => void;
}

/** Runs tasks a few at a time; a task that fails is reported and the rest go on. */
export async function pool<T>(items: T[], limit: number, run: (x: T) => Promise<void>, signal?: AbortSignal): Promise<unknown[]> {
  const errors: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const x = items[next++];
      try {
        await run(x);
      } catch (e) {
        errors.push(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return errors;
}

export class Engine {
  constructor(private store: Store, private llm: Caller, private settings: () => EngineSettings) {}

  private keyU(doc: Doc, u: Unit) { return hash(`${PROMPT_VERSION}|L|${u.hash}|${doc.lang}|${this.settings().target}`); }
  private keyS(doc: Doc, s: Section) { return hash(`${PROMPT_VERSION}|S|${s.hash}|${doc.lang}|${this.settings().target}`); }
  private keyT(u: Unit) { return hash(`${PROMPT_VERSION}|T|${u.hash}|${u.sents.length}|${this.settings().target}`); }

  bilingual(doc: Doc) { return !sameLang(doc.lang, this.settings().target); }

  unitLadder(doc: Doc, u: Unit): UnitLadder | null { return this.store.units.get(this.keyU(doc, u)) ?? null; }
  sectionLadder(doc: Doc, s: Section): SectionLadder | null { return this.store.sections.get(this.keyS(doc, s)) ?? null; }
  translation(u: Unit): string[] | null { return this.store.tr.get(this.keyT(u)) ?? null; }

  /** Units a model writes levels for: the short ones show whole at every level. */
  private writable(s: Section) { return s.units.filter((u) => !u.short); }

  /** Whether a section has all its levels. */
  folded(doc: Doc, s: Section): boolean {
    const w = this.writable(s);
    return !w.length || (!!this.sectionLadder(doc, s) && w.every((u) => !!this.unitLadder(doc, u)));
  }

  pending(doc: Doc): Section[] { return doc.sections.filter((s) => !this.folded(doc, s)); }

  /** Forgets a section's levels, so the next fold writes them again. */
  forget(doc: Doc, sections: Section[]) {
    for (const s of sections) {
      this.store.sections.delete(this.keyS(doc, s));
      for (const u of s.units) this.store.units.delete(this.keyU(doc, u));
    }
    this.store.touch();
  }

  /** Writes the levels of the given sections (those not yet written). */
  async fold(doc: Doc, sections: Section[], o: RunOpts = {}): Promise<unknown[]> {
    const tasks = sections.filter((s) => !this.folded(doc, s)).flatMap((s) =>
      parts(this.writable(s), 4500).map((us, k) => ({ s, us, first: k === 0 })));   // (a reply stays under 4k tokens)
    const bi = this.bilingual(doc);
    const { target, concurrency } = this.settings();
    let done = 0;
    o.progress?.(0, tasks.length);
    const left = new Map<Section, number>();
    for (const t of tasks) left.set(t.s, (left.get(t.s) ?? 0) + 1);
    const errors = await pool(tasks, concurrency, async ({ s, us, first }) => {
      try {
        const reply = await this.llm.json<LadderReply>({
          task: 'fold', system: SYSTEM_FOLD, signal: o.signal, schema: ladderSchema(bi),
          messages: [{ role: 'user', content: ladderPrompt(doc, s, us, target, first) }],
        });
        const got = readLadder(reply, us, this.llm.model('fold'), bi);
        for (const u of us) {
          const lad = got.units.get(u.id);
          if (lad) this.store.units.set(this.keyU(doc, u), lad);
        }
        if (first && got.section) this.store.sections.set(this.keyS(doc, s), got.section);
        this.store.touch();
      } finally {
        o.progress?.(++done, tasks.length);
        left.set(s, left.get(s)! - 1);
        if (!left.get(s)) o.onSection?.(s);
      }
    }, o.signal);
    if (tasks.length && errors.length === tasks.length) throw errors[0];
    return errors;
  }

  /** Translates the given units (those not yet translated), a section's worth of text a call. */
  async translate(doc: Doc, units: Unit[], o: RunOpts = {}): Promise<unknown[]> {
    const todo = units.filter((u) => !this.translation(u));
    const bySec = new Map<string, Unit[]>();
    for (const u of todo) bySec.set(u.section, [...(bySec.get(u.section) ?? []), u]);
    const tasks = [...bySec.entries()].flatMap(([sid, us]) => parts(us, 4000).map((run) => ({ s: doc.sections.find((x) => x.id === sid) ?? null, run })));
    const { target, concurrency, glossary } = this.settings();
    let done = 0;
    o.progress?.(0, tasks.length);
    const errors = await pool(tasks, concurrency, async ({ s, run }) => {
      try {
        const reply = await this.llm.json<TranslateReply>({
          task: 'translate', system: SYSTEM_TRANSLATE, signal: o.signal, schema: translateSchema,
          messages: [{ role: 'user', content: translatePrompt(doc, s, run, target, glossary) }],
        });
        for (const [id, sents] of readTranslation(reply, run)) {
          const u = run.find((x) => x.id === id)!;
          this.store.tr.set(this.keyT(u), sents);
        }
        this.store.touch();
      } finally {
        o.progress?.(++done, tasks.length);
        if (s) o.onSection?.(s);
      }
    }, o.signal);
    if (tasks.length && errors.length === tasks.length) throw errors[0];
    return errors;
  }
}
