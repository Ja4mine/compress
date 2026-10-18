// A PDF read by MinerU, as a note the reader folds: formulas as LaTeX, tables as HTML, figures as pictures, and every
// block's page kept as a marker ("%% page 3 %%", invisible in Obsidian) so a paragraph can open the PDF where it is.
//
// MinerU's output differs by where it ran and its version. The cloud API's zip has full.md (Markdown) and
// content_list.json (a block a line, with its page); MinerU 4's command line writes structured_content.json (pages of
// blocks: type, content, level, bbox; the fields TextFold's pdfdoc.py reads). So: the Markdown when there is one, its
// pages found by matching its blocks to the JSON's; the JSON turned into Markdown when there is not. Every field is
// read as optional: a format that changes loses pages, not the text.
//
// Following TextFold (textfold/pdfdoc.py, Apache 2.0): headings get their depth from their numbering (MinerU gives
// them all one level), running heads and page numbers are dropped, the references become a list.

const DROP = new Set(['header', 'footer', 'page_number', 'aside_text', 'page_header', 'page_footer']);
const REFS = /^\s*(?:\d+\.?\s*)?(?:references|bibliography|literature|works cited|参考文献)\s*$/i;
const KNOWN = /^(abstract|introduction|background|related work|method(s|ology)?|experiments?|results|discussion|conclusions?|limitations|acknowledge?ments?|appendix|摘要|引言|方法|实验|结果|讨论|结论|致谢|附录)$/i;
const NUMBER = /^\s*((?:\d+|[A-Z]|[IVX]+)(?:\.\d+)*)[.)]?\s+\S/;

/** A heading's depth from its numbering: "3" is 1, "3.2" or "A.1" 2, "3.2.1" 3; unnumbered, 1. */
export function depthOf(title: string): number {
  const m = NUMBER.exec(title);
  return m ? Math.min(4, m[1].split('.').length) : 1;
}

const squash = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\$+/g, '').replace(/\\[a-zA-Z]+/g, '').replace(/[\s\W_]+/g, '').toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// MinerU's JSON, whichever shape, as blocks with pages

export interface MBlock {
  type: string;
  text: string;            // the block's text (LaTeX for an equation, HTML for a table)
  page: number;            // from 1
  level?: number;          // a heading's
  image?: string;          // the picture's path in the output
  caption?: string;
}

const str = (x: unknown): string => (typeof x === 'string' ? x : Array.isArray(x) ? x.filter((y) => typeof y === 'string').join(' ') : '');
const captionOf = (b: Record<string, unknown>): string => {
  const parts: string[] = [];
  for (const k of ['captions', 'image_caption', 'table_caption', 'img_caption']) {
    const v = b[k];
    if (Array.isArray(v)) for (const c of v) parts.push(typeof c === 'string' ? c : str((c as Record<string, unknown>)?.content));
    else if (typeof v === 'string') parts.push(v);
  }
  return parts.filter(Boolean).join(' ').trim();
};

function block(b: Record<string, unknown>, page: number): MBlock | null {
  const type = str(b.type) || 'text';
  if (DROP.has(type)) return null;
  const text = str(b.content) || str(b.text) || str(b.table_body) || str(b.code_body) || str(b.list_items) || str(b.html);
  const image = str(b.image_source) || str(b.img_path) || str(b.image_path);
  const level = typeof b.level === 'number' ? b.level : typeof b.text_level === 'number' ? b.text_level : undefined;
  return { type, text: text.trim(), page, level, image: image || undefined, caption: captionOf(b) || undefined };
}

/** MinerU's JSON (structured_content.json, or content_list.json flat or by page) as blocks; null when it is neither. */
export function blocksFromJson(json: unknown): MBlock[] | null {
  const out: MBlock[] = [];
  const obj = json as Record<string, unknown>;
  if (obj && typeof obj === 'object' && Array.isArray(obj.pages)) {   // structured_content.json
    obj.pages.forEach((p: Record<string, unknown>, n: number) => {
      const page = (typeof p?.page_idx === 'number' ? p.page_idx : n) + 1;
      for (const b of (Array.isArray(p?.blocks) ? p.blocks : []) as Record<string, unknown>[]) {
        const x = block(b, page);
        if (x) out.push(x);
      }
    });
    return out;
  }
  if (Array.isArray(json)) {   // content_list.json: a list of blocks, or a list of pages of blocks
    json.forEach((item: unknown, n: number) => {
      const list = Array.isArray(item) ? item : [item];
      for (const b of list as Record<string, unknown>[]) {
        if (!b || typeof b !== 'object') continue;
        const page = (typeof b.page_idx === 'number' ? b.page_idx : Array.isArray(item) ? n : 0) + 1;
        const x = block(b, page);
        if (x) out.push(x);
      }
    });
    return out.length ? out : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// blocks → Markdown (when MinerU wrote no Markdown of its own)

export function blocksToMarkdown(blocks: MBlock[], image: (path: string) => string): string {
  const out: string[] = [];
  let page = 0;
  let inRefs = false;
  let titleDone = false;
  for (const b of blocks) {
    if (b.page !== page) {
      page = b.page;
      out.push(`%% page ${page} %%`);
    }
    const t = b.text;
    switch (b.type) {
      case 'doc_title':
      case 'title':
        if (!titleDone) {
          out.push(`# ${t.replace(/\s+/g, ' ')}`);
          titleDone = true;
        } else out.push(`## ${t.replace(/\s+/g, ' ')}`);
        break;
      case 'paragraph_title':
        if (!t) break;
        inRefs = REFS.test(t);
        out.push(`${'#'.repeat(1 + depthOf(t))} ${t.replace(/\s+/g, ' ')}`);
        break;
      case 'equation':
      case 'interline_equation':
        if (t) out.push(`$$\n${t.replace(/^\$+|\$+$/g, '').trim()}\n$$`);
        else if (b.image) out.push(image(b.image));
        break;
      case 'image':
        if (b.image) out.push(image(b.image));
        if (b.caption) out.push(b.caption);
        break;
      case 'table':
        if (b.caption) out.push(b.caption);
        if (t.startsWith('<')) out.push(t.replace(/\n+/g, ' '));
        else if (t) out.push(t);
        else if (b.image) out.push(image(b.image));
        break;
      case 'code':
        if (t) out.push('```\n' + t + '\n```');
        break;
      case 'page_footnote':
        if (t) out.push(`> [!note]- 脚注\n> ${t.replace(/\n+/g, ' ')}`);
        break;
      case 'ref_text':
        if (t) out.push(`- ${t.replace(/\s+/g, ' ')}`);
        break;
      default:   // text, list and anything newer
        if (!t) break;
        if (b.level && b.level > 0 && t.length < 160) {
          inRefs = REFS.test(t);
          out.push(`${'#'.repeat(1 + Math.max(depthOf(t), b.level))} ${t.replace(/\s+/g, ' ')}`);
        } else if (inRefs) {
          for (const line of t.split('\n')) if (line.trim()) out.push(`- ${line.trim().replace(/^[-•]\s*/, '')}`);
        } else {
          out.push(t);
        }
    }
  }
  return out.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// MinerU's Markdown, made the reader's

/** Headings re-levelled by numbering (MinerU sets them all at one level); the first, unnumbered, is the title. */
export function relevel(md: string): string {
  let first = true;
  return md.split('\n').map((line) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) return line;
    const title = m[2].trim();
    if (first) {
      first = false;
      if (!NUMBER.test(title) && !KNOWN.test(title) && !REFS.test(title)) return `# ${title}`;
    }
    return `${'#'.repeat(1 + depthOf(title))} ${title}`;
  }).join('\n');
}

/** Pictures as links into the vault: ![](images/x.jpg) and <img src="images/x.jpg"> → ![[vault/path/x.jpg]]. */
export function relinkImages(md: string, image: (path: string) => string): string {
  return md
    .replace(/!\[[^\]]*\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g, (all, p: string) => (/^(https?:|data:)/.test(p) ? all : image(decodeURI(p))))
    .replace(/<img\s+[^>]*src="([^"]+)"[^>]*>/g, (all, p: string) => (/^(https?:|data:)/.test(p) ? all : image(decodeURI(p))));
}

/** The references (everything after a "References" heading, up to the next heading) collapsed into one callout:
 *  they are not prose to fold, and should not cost a model call each. */
export function collapseReferences(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let refs: string[] | null = null;
  const flush = () => {
    if (refs && refs.length) out.push('> [!quote]- 参考文献', ...refs.map((r) => `> - ${r.replace(/^[-*•]\s+/, '')}`), '');
    refs = null;
  };
  for (const line of lines) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(line);
      if (REFS.test(h[1].trim())) refs = [];
      continue;
    }
    if (refs) {
      if (line.trim() && !/^%%.*%%$/.test(line.trim())) refs.push(line.trim());
      continue;
    }
    out.push(line);
  }
  flush();
  return out.join('\n');
}

/** Page markers for Markdown whose blocks are matched to MinerU's blocks with pages (by the start of their text). */
export function addPageMarkers(md: string, blocks: MBlock[]): string {
  const keys = blocks.map((b) => ({ k: squash(b.text).slice(0, 40), page: b.page })).filter((x) => x.k.length >= 6);
  const parts = md.split(/\n{2,}/);
  let cursor = 0;
  let page = 0;
  const out: string[] = [];
  for (const part of parts) {
    const k = squash(part).slice(0, 40);
    if (k.length >= 6) {
      // the next block, at or after the last match, whose text starts the same way
      for (let j = cursor; j < Math.min(keys.length, cursor + 60); j++) {
        if (keys[j].k.startsWith(k.slice(0, 24)) || k.startsWith(keys[j].k.slice(0, 24))) {
          cursor = j + 1;
          if (keys[j].page !== page) {
            page = keys[j].page;
            out.push(`%% page ${page} %%`);
          }
          break;
        }
      }
    }
    out.push(part);
  }
  return out.join('\n\n');
}

/** The page of every line of a note with page markers (0 before the first marker). */
export function pagesOfLines(md: string): number[] {
  let page = 0;
  return md.split('\n').map((line) => {
    const m = /^\s*%%\s*page\s+(\d+)\s*%%\s*$/.exec(line);
    if (m) page = Number(m[1]);
    return page;
  });
}

/** MinerU's output (its Markdown or its JSON, and the JSON's blocks) as the reader's note body. */
export function noteFromMinerU(out: { md?: string; json?: unknown }, image: (path: string) => string): string {
  const blocks = out.json !== undefined ? blocksFromJson(out.json) : null;
  let md: string;
  if (out.md && out.md.trim()) {
    md = relevel(relinkImages(out.md.replace(/\r\n?/g, '\n'), image));
    if (blocks?.length) md = addPageMarkers(md, blocks);
  } else if (blocks?.length) {
    md = relevel(blocksToMarkdown(blocks, image));
  } else {
    throw new Error('MinerU 没有输出可读的内容');
  }
  return collapseReferences(md).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** The LaTeX formulas in Markdown, in order: $$…$$ and $…$ (an escaped \$ is not one). */
export function formulasIn(md: string): string[] {
  const out: string[] = [];
  const re = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g;
  for (let m = re.exec(md); m; m = re.exec(md)) out.push((m[1] ?? m[2] ?? '').trim());
  return out;
}
