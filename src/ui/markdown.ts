import { App, Component, Keymap, MarkdownRenderer } from 'obsidian';

/** Renders Markdown into an element (emptied first), the way the note itself renders it. */
export async function renderMd(app: App, md: string, el: HTMLElement, sourcePath: string, owner: Component): Promise<void> {
  el.empty();
  await MarkdownRenderer.render(app, md, el, sourcePath, owner);
}

/** Rendered [[links]] open their note (a custom view gets no link handling of its own). */
export function handleLinks(app: App, el: HTMLElement, sourcePath: () => string, owner: Component): void {
  owner.registerDomEvent(el, 'click', (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a.internal-link');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('data-href') ?? a.getAttribute('href');
    if (href) void app.workspace.openLinkText(href, sourcePath(), Keymap.isModEvent(e));
  });
}

const CITE = /\[((?:P\d+)(?:\s*[,，、;；–-]\s*P?\d+)*)\]/g;

/** Turns an answer's [P12] citations into links that call `go` with the paragraph number. */
export function linkCitations(el: HTMLElement, go: (idx: number) => void): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.parentElement?.closest('code, pre, a') ?? null) === null && /\[P\d+/.test(n.nodeValue ?? '')) hits.push(n as Text);
  }
  for (const node of hits) {
    const text = node.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let pos = 0;
    CITE.lastIndex = 0;
    for (let m = CITE.exec(text); m; m = CITE.exec(text)) {
      frag.append(text.slice(pos, m.index));
      for (const num of m[1].match(/\d+/g) ?? []) {
        const a = frag.createEl('a', { cls: 'compress-cite', text: `¶${num}`, attr: { 'aria-label': `跳到第 ${num} 段` } });
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          go(Number(num));
        });
      }
      pos = m.index + m[0].length;
    }
    frag.append(text.slice(pos));
    node.replaceWith(frag);
  }
}

/** Calls fn at most every `ms`, always ending with the last call. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let args: A | null = null;
  return (...a: A) => {
    args = a;
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn(...a);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...(args as A));
      }, wait);
    }
  };
}

/** Runs an async render one at a time; calls that arrive meanwhile collapse into the latest. */
export function coalesce(fn: (md: string) => Promise<void>): (md: string) => void {
  let running = false;
  let next: string | null = null;
  const go = (md: string) => {
    if (running) { next = md; return; }
    running = true;
    void fn(md).finally(() => {
      running = false;
      if (next !== null) {
        const n = next;
        next = null;
        go(n);
      }
    });
  };
  return go;
}
