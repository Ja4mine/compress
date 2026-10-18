import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, sentencesOf } from '../src/core/parse';

const NOTE = `---
tags: [paper]
---
# Attention Is All You Need

## Abstract

The dominant sequence transduction models are based on complex recurrent networks. We propose the Transformer, based solely on attention. It is faster to train.

## 1 Introduction

Recurrent models factor computation along positions. This precludes parallelization.
- First contribution: a new architecture that is simple. It drops recurrence.
- Second contribution
  - nested detail. More.
1. Ordered item one is here.

> A quote that says something. And more.

> [!note] Callout
> my own note

\`\`\`python
x = 1. y = 2
\`\`\`

$$
E = mc^2
$$

| a | b |
|---|---|
| 1 | 2 |

![[figure.png]]

%% hidden comment %%
Last paragraph. ^block1
`;

test('sections, units and raw blocks', () => {
  const d = parse(NOTE, 'file');
  assert.equal(d.title, 'Attention Is All You Need');
  assert.equal(d.lang, 'en');
  assert.deepEqual(d.sections.map((s) => s.title), ['Attention Is All You Need', 'Abstract', '1 Introduction']);
  const intro = d.sections[2];
  const kinds = intro.blocks.map((b) => (b.t === 'unit' ? b.u.kind : b.r.kind));
  assert.deepEqual(kinds, ['para', 'item', 'item', 'item', 'quote', 'callout', 'code', 'math', 'table', 'image', 'para']);
  const items = intro.units.filter((u) => u.kind === 'item');
  assert.equal(items[0].text, 'First contribution: a new architecture that is simple. It drops recurrence.');
  assert.equal(items[1].text, 'Second contribution');
  assert.match(items[1].md, /nested detail/);
  assert.equal(items[2].marker, '1. ');
  assert.equal(d.units.at(-1)!.text, 'Last paragraph.');
  assert.deepEqual(d.units.map((u) => u.idx), d.units.map((_, i) => i + 1));
});

test('excerpts join neighbours and mark gaps', () => {
  const d = parse(NOTE, 'file');
  const abs = d.sections[1].units[0];
  assert.equal(abs.sents.length, 3);
  assert.equal(sentencesOf(abs, [0, 1]), 'The dominant sequence transduction models are based on complex recurrent networks. We propose the Transformer, based solely on attention.');
  assert.equal(sentencesOf(abs, [0, 2]), 'The dominant sequence transduction models are based on complex recurrent networks. … It is faster to train.');
});

test('a Chinese note', () => {
  const d = parse('# 标题\n\n这是第一段。它有两句话。\n\n## 第二节\n\n短段。', 'x');
  assert.equal(d.lang, 'zh');
  assert.equal(d.units[0].sents.length, 2);
  assert.ok(d.units[1].short);
});

test('text before the first heading is its own section', () => {
  const d = parse('Opening words here. More.\n\n## A\n\nBody text.', 'x');
  assert.equal(d.sections[0].level, 0);
  assert.equal(d.sections[0].units.length, 1);
  assert.equal(d.title, 'x');
});
