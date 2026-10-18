import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  addPageMarkers, blocksFromJson, blocksToMarkdown, collapseReferences, formulasIn, noteFromMinerU, pagesOfLines, relevel, relinkImages,
} from '../src/core/mineru';
import { runCloud, runCommand, unpack } from '../src/mineru';
import { parse } from '../src/core/parse';
import { DEFAULT_SETTINGS } from '../src/providers';

const FULL_MD = `# Attention Is All You Need

# Abstract

The dominant sequence transduction models are based on complex recurrent networks.

# 3 Model Architecture

# 3.2 Attention

We compute the attention as $\\mathrm{softmax}(QK^T/\\sqrt{d_k})V$ for queries $Q$.

$$
\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V
$$

![](images/fig1.jpg)

Figure 1: The Transformer.

# References

[1] Jimmy Lei Ba. Layer normalization. 2016.

[2] Dzmitry Bahdanau. Neural machine translation. 2014.
`;

const CONTENT_LIST = [
  { type: 'text', text: 'Attention Is All You Need', text_level: 1, page_idx: 0 },
  { type: 'text', text: 'The dominant sequence transduction models are based on complex recurrent networks.', page_idx: 0 },
  { type: 'text', text: '3 Model Architecture', text_level: 1, page_idx: 2 },
  { type: 'text', text: 'We compute the attention as $\\mathrm{softmax}(QK^T/\\sqrt{d_k})V$ for queries $Q$.', page_idx: 3 },
  { type: 'equation', text: '$$\\mathrm{Attention}(Q,K,V)=...$$', text_format: 'latex', page_idx: 3 },
  { type: 'image', img_path: 'images/fig1.jpg', image_caption: ['Figure 1: The Transformer.'], page_idx: 3 },
  { type: 'text', text: '[1] Jimmy Lei Ba. Layer normalization. 2016.', page_idx: 11 },
];

test('MinerU Markdown: headings by numbering, pictures into the vault, references collapsed, pages marked', () => {
  const note = noteFromMinerU({ md: FULL_MD, json: CONTENT_LIST }, (p) => `![[Papers/x.assets/${p.replace('/', '_')}]]`);
  assert.match(note, /^# Attention Is All You Need$/m);
  assert.match(note, /^## Abstract$/m);
  assert.match(note, /^## 3 Model Architecture$/m);
  assert.match(note, /^### 3\.2 Attention$/m);
  assert.match(note, /!\[\[Papers\/x\.assets\/images_fig1\.jpg\]\]/);
  assert.match(note, /> \[!quote\]- 参考文献\n> - \[1\] Jimmy Lei Ba/);
  assert.match(note, /%% page 4 %%\n\nWe compute the attention/);
  const doc = parse(note, 'x');
  assert.equal(doc.title, 'Attention Is All You Need');
  assert.ok(doc.units.every((u) => !/Jimmy/.test(u.text)), 'references are not units');
  const pages = pagesOfLines(note);
  const u = doc.units.find((x) => /We compute/.test(x.text))!;
  assert.equal(pages[u.line], 4);
  const math = doc.sections.flatMap((s) => s.blocks).find((b) => b.t === 'raw' && b.r.kind === 'math');
  assert.ok(math, 'a display formula is a raw math block');
});

test('structured_content.json (MinerU 4 locally) becomes Markdown with pages', () => {
  const sc = { pages: [
    { page_idx: 0, blocks: [{ type: 'doc_title', content: 'A Paper' }, { type: 'header', content: 'Running head' }, { type: 'paragraph_title', content: '1 Introduction' }, { type: 'text', content: 'Intro text here.' }] },
    { page_idx: 1, blocks: [{ type: 'equation', content: '$$E=mc^2$$' }, { type: 'image', image_source: 'images/a.png', captions: [{ content: 'Figure 2: A figure.' }] }, { type: 'page_number', content: '2' }] },
  ] };
  const blocks = blocksFromJson(sc)!;
  assert.equal(blocks.length, 5, 'the running head and page number are dropped');
  const md = blocksToMarkdown(blocks, (p) => `![[${p}]]`);
  assert.match(md, /^# A Paper$/m);
  assert.match(md, /^## 1 Introduction$/m);
  assert.match(md, /%% page 2 %%\n\n\$\$\nE=mc\^2\n\$\$/);
  assert.match(md, /!\[\[images\/a\.png\]\]\n\nFigure 2: A figure\./);
  assert.ok(blocksFromJson([[{ type: 'text', text: 'x' }]])![0].page === 1, 'content_list by page');
});

test('helpers: relevel, relink, references, markers, formulas', () => {
  assert.equal(relevel('# Title\n\n# 2.1 Data\n\n# References'), '# Title\n\n### 2.1 Data\n\n## References');
  assert.equal(relinkImages('a ![](images/x.jpg) b <img src="images/y.png" alt="">', (p) => `[${p}]`), 'a [images/x.jpg] b [images/y.png]');
  assert.equal(collapseReferences('## References\n\n- a\n- b\n\n## Appendix\n\ntext'), '## References\n> [!quote]- 参考文献\n> - a\n> - b\n\n## Appendix\n\ntext');
  assert.equal(addPageMarkers('Hello world again.\n\nSecond block of text.', [{ type: 'text', text: 'Hello world again.', page: 1 }, { type: 'text', text: 'Second block of text.', page: 2 }]),
    '%% page 1 %%\n\nHello world again.\n\n%% page 2 %%\n\nSecond block of text.');
  assert.deepEqual(formulasIn('cost \\$5, $a+b$ and $$\nx^2\n$$ then $c$'), ['a+b', 'x^2', 'c']);
});

function zip(): Uint8Array {
  return zipSync({
    'abc/full.md': strToU8(FULL_MD),
    'abc/content_list.json': strToU8(JSON.stringify(CONTENT_LIST)),
    'abc/images/fig1.jpg': new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]),
  });
}

test('the result zip: Markdown, JSON and pictures relative to the Markdown', () => {
  const out = unpack(zip());
  assert.match(out.md!, /Attention Is All You Need/);
  assert.ok(Array.isArray(out.json));
  assert.deepEqual([...out.images.keys()], ['images/fig1.jpg']);
});

test('the cloud API: upload address, upload, polling, zip', async () => {
  const seen: string[] = [];
  let polls = 0;
  let uploaded = 0;
  const server = createServer((req, res) => {
    let body: Buffer[] = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/api/v4/file-urls/batch') {
        assert.equal(req.headers.authorization, 'Bearer tok');
        const j = JSON.parse(Buffer.concat(body).toString());
        assert.equal(j.model_version, 'vlm');
        assert.equal(j.files[0].name, 'paper.pdf');
        res.end(JSON.stringify({ code: 0, msg: 'ok', data: { batch_id: 'b1', file_urls: [`http://127.0.0.1:${port}/upload/paper.pdf`] } }));
      } else if (req.url?.startsWith('/upload/')) {
        uploaded = Buffer.concat(body).length;
        res.end('');
      } else if (req.url === '/api/v4/extract-results/batch/b1') {
        polls++;
        const done = polls >= 2;
        res.end(JSON.stringify({ code: 0, data: { batch_id: 'b1', extract_result: [done
          ? { state: 'done', full_zip_url: `http://127.0.0.1:${port}/result.zip` }
          : { state: 'running', extract_progress: { extracted_pages: 3, total_pages: 12 } }] } }));
      } else if (req.url === '/result.zip') {
        res.end(Buffer.from(zip()));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const app = { vault: { readBinary: async () => new Uint8Array([37, 80, 68, 70, 1, 2, 3]).buffer } };
    const steps: string[] = [];
    const out = await runCloud(app as never, { name: 'paper.pdf' } as never, { ...DEFAULT_SETTINGS, mineruToken: 'tok', mineruApi: `http://127.0.0.1:${port}` },
      (d, t, label) => steps.push(`${label} ${d}/${t}`));
    assert.equal(uploaded, 7, 'the PDF was uploaded');
    assert.match(out.md!, /Attention/);
    assert.ok(steps.includes('解析中 3/12'), steps.join(','));
    assert.deepEqual(seen.slice(0, 2), ['POST /api/v4/file-urls/batch', 'PUT /upload/paper.pdf']);
  } finally {
    server.close();
  }
});

test('the cloud API: a refused token is reported in plain words', async () => {
  const server = createServer((req, res) => { res.statusCode = 401; res.end(JSON.stringify({ code: 'A0202', msg: 'token error' })); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const app = { vault: { readBinary: async () => new ArrayBuffer(4) } };
    await assert.rejects(runCloud(app as never, { name: 'p.pdf' } as never, { ...DEFAULT_SETTINGS, mineruToken: 'bad', mineruApi: `http://127.0.0.1:${port}` }, () => {}), /Token 无效/);
  } finally {
    server.close();
  }
});

test('the local command: mineru-kit parse … -o result.zip, its progress read, its zip unpacked', async () => {
  (globalThis as unknown as { window: unknown }).window = { require: createRequire(import.meta.url) };
  const dir = mkdtempSync(join(tmpdir(), 'compress-test-'));
  const fixture = join(dir, 'fixture.zip');
  writeFileSync(fixture, zip());
  const fake = join(dir, 'mineru-kit');
  writeFileSync(fake, `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\necho "Two Step Extraction:  50%|#####     | 1/2" 1>&2\ncp "${fixture}" "$out"\n`);
  chmodSync(fake, 0o755);
  const steps: string[] = [];
  const out = await runCommand(fake, '/tmp/x.pdf', 'advanced', (d, t) => steps.push(`${d}/${t}`));
  assert.match(out.md!, /Attention/);
  assert.deepEqual(steps, ['1/2']);
  await assert.rejects(runCommand(join(dir, 'missing-command'), '/tmp/x.pdf', 'advanced', () => {}), /找不到命令/);
});
