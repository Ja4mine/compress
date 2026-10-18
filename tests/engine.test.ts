import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/core/parse';
import { showUnit, showUnitTr } from '../src/core/levels';
import { FileIO, Store } from '../src/core/store';
import { Engine } from '../src/ai/engine';
import { docBlock, ladderPrompt, parts, retrieve } from '../src/ai/prompts';
import { parseJSON } from '../src/ai/llm';
import type { CallOpts } from '../src/ai/llm';

function memIO(): FileIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: async (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/')),
    read: async (p) => files.get(p)!,
    write: async (p, d) => void files.set(p, d),
    mkdir: async () => {},
    remove: async (p) => void files.delete(p),
  };
}

const NOTE = `# Paper

## Method

We train a transformer on 10B tokens. The model has 1B parameters. Training takes three days on 64 GPUs.

Short one.

## Results

Accuracy rises to 91% on the test set. This beats the baseline by 4 points. Gains are largest on long inputs.
`;

/** A model that answers every fold and translation call by the prompt's own unit list. */
function fakeModel() {
  const calls: CallOpts[] = [];
  return {
    calls,
    model: () => 'fake-1',
    async json<T>(o: CallOpts): Promise<T> {
      calls.push(o);
      const prompt = o.messages[0].content;
      const ids = [...prompt.matchAll(/\[U(\d+)\]/g)].map((m) => Number(m[1]));
      if (o.task === 'fold') {
        return {
          section: { takeaway: 'Section line', topic: 'Section', tr_takeaway: '本节要点', tr_topic: '本节' },
          units: ids.map((n) => ({ id: `U${n}`, role: 'method', evidence: [1, 9], takeaway: `Take ${n}`, reason: `Because ${n}`, topic: `T${n}`,
            tr_takeaway: `要点${n}`, tr_reason: `理由${n}`, tr_topic: `主题${n}` })),
        } as T;
      }
      return { units: ids.map((n) => ({ id: `U${n}`, sentences: ['句一。', '句二。'] })) } as T;
    },
  };
}

test('fold writes every section once, then reads from the store', async () => {
  const doc = parse(NOTE, 'p');
  const io = memIO();
  const store = new Store(io, 'cache');
  await store.ready();
  const llm = fakeModel();
  const engine = new Engine(store, llm, () => ({ target: 'zh', concurrency: 2, glossary: '' }));
  assert.equal(engine.pending(doc).length, 2);   // Method and Results; the title section has no units
  const seen: string[] = [];
  await engine.fold(doc, engine.pending(doc), { onSection: (s) => seen.push(s.title) });
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(seen.sort(), ['Method', 'Results']);
  assert.equal(engine.pending(doc).length, 0);
  assert.ok(llm.calls[0].schema, 'the fold asks for JSON by schema');
  assert.match(llm.calls[0].messages[0].content, /tr_takeaway/, 'an English note gets Chinese lines too');

  const u = doc.sections.find((s) => s.title === 'Method')!.units[0];
  const lad = engine.unitLadder(doc, u)!;
  assert.deepEqual(lad.ev, [1], 'an evidence index past the end is dropped');
  assert.equal(showUnit(u, 2, lad, true).md, 'The model has 1B parameters. …');
  assert.equal(showUnit(u, 3, lad, true).md, 'Take 0. Because 0.');
  assert.equal(showUnit(u, 4, lad, true).md, 'Take 0');
  assert.equal(showUnitTr(u, 3, lad, null, true, true)!.md, '要点0。理由0。');
  assert.equal(showUnit(doc.units[1], 4, null, false).md, 'Short one.', 'a short unit shows whole');

  await store.flush();
  const again = new Store(io, 'cache');
  await again.ready();
  const engine2 = new Engine(again, fakeModel(), () => ({ target: 'zh', concurrency: 2, glossary: '' }));
  assert.equal(engine2.pending(doc).length, 0, 'the levels survive a reload');

  await engine.translate(doc, doc.units);
  assert.deepEqual(engine.translation(u), ['句一。', '句二。', ''], 'a short reply is padded to the sentence count');
});

test('local folding without a model', () => {
  const doc = parse(NOTE, 'p');
  const [a, b] = doc.sections[1].units;
  assert.equal(showUnit(a, 2, null, true).md, 'We train a transformer on 10B tokens. The model has 1B parameters. …');
  assert.equal(showUnit(a, 3, null, true).md, 'We train a transformer on 10B tokens. …');
  assert.equal(showUnit(a, 4, null, false).md, '', 'at level 4 only the first unit of a section speaks');
  assert.equal(showUnit(b, 4, null, false).md, 'Short one.');
});

test('prompts, parts and retrieval', () => {
  const doc = parse(NOTE, 'p');
  const p = ladderPrompt(doc, doc.sections[1], doc.sections[1].units, 'en', true);
  assert.doesNotMatch(p, /tr_takeaway/, 'no second language when the note is already in it');
  assert.match(p, /▶ Method/);
  assert.match(p, /\[U0\] paragraph\n  0: We train/);
  const many = Array.from({ length: 30 }, () => doc.units[0]);
  assert.ok(parts(many, 400).length > 1);
  assert.equal(parts(many, 400).flat().length, 30);
  assert.equal(retrieve(doc, 'what accuracy on the test set?', 3, new Set())[0].idx, 3);
  const whole = docBlock(doc, 100000, () => '', null, '');
  assert.ok(whole.whole && whole.text.includes('[P1] We train'));
  const part = docBlock(doc, 200, () => '', doc.units[2], 'accuracy');
  assert.ok(!part.whole && part.text.includes('[P3]'));
});

test('JSON in a chatty reply', () => {
  assert.deepEqual(parseJSON('<think>hmm</think>Sure!\n```json\n{"a": [1, 2,],}\n```'), { a: [1, 2] });
});
