import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, isCJK, splitSentences, wordCount } from '../src/core/sentences';

const cut = (t: string) => splitSentences(t).map(([s, e]) => t.slice(s, e));

test('Latin sentences, abbreviations and decimals', () => {
  assert.deepEqual(cut('We use e.g. dropout at 0.5 rate. It works well! Does it scale? Yes.'),
    ['We use e.g. dropout at 0.5 rate.', 'It works well!', 'Does it scale?', 'Yes.']);
  assert.deepEqual(cut('As shown in Fig. 3, the loss falls. See Smith et al. for details.'),
    ['As shown in Fig. 3, the loss falls.', 'See Smith et al. for details.']);
  assert.deepEqual(cut('J. Smith wrote it. Then we left.'), ['J. Smith wrote it.', 'Then we left.']);
});

test('nothing is cut inside code, math or links', () => {
  assert.deepEqual(cut('Call `a. b` first. Then $x. y$ holds. Read [a. b](http://x.y/z. w) now.'),
    ['Call `a. b` first.', 'Then $x. y$ holds.', 'Read [a. b](http://x.y/z. w) now.']);
  assert.deepEqual(cut('See [[Note. A]] here. Done.'), ['See [[Note. A]] here.', 'Done.']);
});

test('CJK stops need no space; closing quotes stay with the sentence', () => {
  assert.deepEqual(cut('这是第一句。这是第二句！“第三句？”最后'), ['这是第一句。', '这是第二句！', '“第三句？”', '最后']);
});

test('bold across a cut is closed', () => {
  assert.equal(balance('**Our method works.'), '**Our method works.**');
  assert.equal(balance('It is fast.**'), '**It is fast.**');
});

test('word counts and script', () => {
  assert.equal(wordCount('Hello world, 你好'), 4);
  assert.ok(isCJK('这是一段中文，带一点 English。'));
  assert.ok(!isCJK('This is English with 一点中文.'));
});
