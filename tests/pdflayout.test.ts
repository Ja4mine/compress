import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeMd, layout, mendText, PdfItem, PdfPage } from '../src/core/pdflayout';
import { parse, unitByQuote } from '../src/core/parse';

/** A page from lines of text: [x, y, text, size?, font?]. Each line is one item about 5pt a character wide. */
function page(rows: [number, number, string, number?, string?][], w = 600, h = 800): PdfPage {
  const items: PdfItem[] = rows.map(([x, y, s, size = 10, font = 'body']) => ({ s, x, y, w: s.length * size * 0.5, size, font }));
  return { w, h, items };
}

const L = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.';

test('two columns read left, then right; full-width lines break the bands', () => {
  const rows: [number, number, string, number?, string?][] = [[150, 760, 'A Study of Folding Text', 18, 'bold']];
  const left = ['Left one starts the left column of', 'text and goes on down the column', 'until it ends here at last. Then', 'the left column keeps on going', 'with more words in its lines here.'];
  const right = ['Right one starts the right column', 'of text and also goes downward', 'until it ends here at the bottom', 'of the page with some more words', 'and a final sentence to close.'];
  left.forEach((t, i) => rows.push([50, 700 - i * 12, t]));
  right.forEach((t, i) => rows.push([320, 700 - i * 12, t]));
  const out = layout([page(rows)]);
  assert.equal(out.title, 'A Study of Folding Text');
  const md = out.md;
  assert.ok(md.indexOf('Left one') < md.indexOf('Right one'), 'left column first');
  assert.ok(md.indexOf('more words in its lines here.') < md.indexOf('Right one'), 'the whole left column before the right');
  assert.match(md, /Left one starts the left column of text and goes on/, 'lines of a column join into one paragraph');
});

test('a narrow gutter still separates the columns', () => {
  const rows: [number, number, string, number?, string?][] = [];
  for (let i = 0; i < 6; i++) {
    rows.push([72, 700 - i * 12, 'left words in a column line here', 10]);
    rows.push([72 + 'left words in a column line here'.length * 5 + 17, 700 - i * 12, 'right words in the other column', 10]);
  }
  const md = layout([page(rows, 595)]).md;
  assert.ok(!/here right words/.test(md), 'a 17pt gutter splits the row');
});

test('headings, hyphens, paragraphs, running headers and page numbers', () => {
  const p1 = page([
    [50, 780, 'Journal of Testing, Vol. 3'],
    [50, 700, '1 Introduction', 12, 'bold'],
    [50, 680, 'We fold text into levels so that read-'],
    [50, 668, 'ers can zoom. This is the first paragraph.'],
    [60, 648, 'A second paragraph starts with an indent after a gap'],
    [50, 636, 'and ends here.'],
    [290, 30, '1'],
  ]);
  const p2 = page([
    [50, 780, 'Journal of Testing, Vol. 3'],
    [50, 700, '2.1 Method Details', 11, 'bold'],
    [50, 680, 'The method is simple and works well in practice, and this line runs on'],
    [50, 668, 'to a short end.'],
    [290, 30, '2'],
  ]);
  const p3 = page([[50, 780, 'Journal of Testing, Vol. 3'], [50, 700, 'Last page text that ends here.'], [290, 30, '3']]);
  const out = layout([p1, p2, p3]);
  assert.doesNotMatch(out.md, /Journal of Testing/, 'a running header is dropped');
  assert.doesNotMatch(out.md, /^\d$/m, 'page numbers are dropped');
  assert.match(out.md, /^## 1 Introduction$/m);
  assert.match(out.md, /^### 2\.1 Method Details$/m);
  assert.match(out.md, /so that readers can zoom\./, 'a hyphen at a line end is mended');
  const doc = parse(out.md, 'x');
  assert.equal(doc.units.length, 4);
  assert.equal(out.pages[doc.units[2].line], 2, 'each line knows its page');
});

test('a section number keeps its title across a wide space', () => {
  const md = layout([page([[50, 700, '4', 12, 'bold'], [72, 700, 'Experiments', 12, 'bold'], [50, 680, L]])]).md;
  assert.match(md, /^## 4 Experiments$/m);
});

test('figure labels, equations, footnotes and references go into callouts', () => {
  const md = layout([page([
    [50, 700, '1 Introduction', 12, 'bold'],
    [50, 680, L],
    [100, 600, 'Encoder', 7], [300, 600, 'Decoder', 7],
    [50, 560, 'Figure 1: The model.'],
    [150, 520, 'y = f(x) + b (1)'],
    [50, 60, '∗Equal contribution.', 8],
  ]), page([
    [50, 700, 'References', 12, 'bold'],
    [50, 680, '[1] A. Author. A paper. 2020.'],
  ])]).md;
  assert.match(md, /> \[!example\]- 图表与公式（第 1 页）\n> Encoder/);
  assert.match(md, /> \[!quote\]- 参考文献\n> - \[1\] A\. Author/);
  assert.match(md, /> \[!note\]- 脚注/);
  assert.match(md, /^Figure 1: The model\.$/m, 'a caption stays a paragraph');
  const doc = parse(md, 'x');
  assert.ok(doc.units.every((u) => !/Encoder|Author|Equal contribution/.test(u.text)), 'none of them become units');
});

test('Chinese: lines join without spaces, radicals are mended, punctuation kept', () => {
  assert.equal(mendText('本⽂研究⻓⽂档，'), '本文研究长文档，');
  const md = layout([page([
    [50, 700, '1 引言', 12, 'bold'],
    [50, 680, '阅读学术论文时，读者常常需要先了解全文的大意，'],
    [50, 668, '再决定把时间花在哪一节上。'],
  ])]).md;
  assert.match(md, /大意，再决定/);
  assert.match(md, /^## 1 引言$/m);
});

test('Markdown in PDF text is escaped, and a selection finds its paragraph', () => {
  assert.equal(escapeMd('costs $5 and *stars* <b> [[x]]'), 'costs \\$5 and \\*stars\\* &lt;b> [\\[x]]');
  assert.equal(escapeMd('# not a heading'), '\\# not a heading');
  const doc = parse(layout([page([[50, 700, 'Intro', 12, 'bold'], [50, 680, 'We fold text into levels so that read-'], [50, 668, 'ers can zoom in and out.']])]).md, 'x');
  assert.equal(unitByQuote(doc, 'so that read-\ners can zoom'), 1);
  assert.equal(unitByQuote(doc, 'nothing like this'), undefined);
});
