import { DataAdapter, Editor, Events, MarkdownView, Menu, normalizePath, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { CompressSettings, DEFAULT_SETTINGS, profileFor } from './providers';
import { CompressSettingTab } from './settings';
import { LLM, Stopped } from './ai/llm';
import { Engine, RunOpts } from './ai/engine';
import { isCjkLang, LANGS, selectionTranslatePrompt } from './ai/prompts';
import { Doc, parse, Section, Unit, unitByQuote } from './core/parse';
import { Layout, layout } from './core/pdflayout';
import { readPdf } from './pdf';
import { MinerUError, runCloud, runLocal, saveNote } from './mineru';
import { pagesOfLines } from './core/mineru';
import { readable } from './files';
import { hideSelBar, showSelBar } from './ui/selbar';
import { isCJK } from './core/sentences';
import { FileIO, Store } from './core/store';
import { LEVELS } from './core/levels';
import { READER, ReaderView } from './ui/reader';
import { AskOpts, CHAT, ChatView } from './ui/chat';
import { Popover } from './ui/popover';
import { throttle } from './ui/markdown';

interface Job { label: string; done: number; total: number; abort: AbortController }

interface Selected { text: string; rect: DOMRect; file: TFile; idx?: number; line?: number }

/** A note or PDF as the reader reads it. A PDF's paragraphs (or those of a note made from one) know their page;
 *  sourcePath is the file links and pictures resolve from (a PDF read through its MinerU note: the note). */
export interface Loaded { doc: Doc; pageOf: ((u: Unit) => number) | null; pdf: TFile | null; sourcePath: string; via: 'md' | 'pdfjs' | 'mineru' }


function adapterIO(a: DataAdapter): FileIO {
  return {
    exists: (p) => a.exists(p),
    read: (p) => a.read(p),
    write: (p, d) => a.write(p, d),
    mkdir: (p) => a.mkdir(p),
    remove: (p) => a.remove(p),
  };
}

export default class CompressPlugin extends Plugin {
  settings!: CompressSettings;
  llm!: LLM;
  store!: Store;
  engine!: Engine;
  readonly events = new Events();
  private jobs = new Map<string, Job>();
  private trTried = new Set<string>();   // units an automatic translation has been asked for this session
  private pdfs = new Map<string, { mtime: number; size: number; layout: Promise<Layout> }>();
  private lastSel: (Selected & { at: number }) | null = null;   // the last selection in a PDF or reading view

  async onload() {
    await this.loadSettings();
    this.llm = new LLM(() => this.settings);
    this.store = new Store(adapterIO(this.app.vault.adapter), normalizePath(`${this.manifest.dir}/cache`));
    this.engine = new Engine(this.store, this.llm, () => this.settings);
    void this.store.ready();

    this.registerView(READER, (leaf) => new ReaderView(leaf, this));
    this.registerView(CHAT, (leaf) => new ChatView(leaf, this));
    this.addSettingTab(new CompressSettingTab(this.app, this));

    this.addRibbonIcon('layers', 'Compress：分层阅读当前笔记', () => {
      const f = this.activeNote();
      if (f) void this.openReader(f); else new Notice('先打开一篇 Markdown 笔记或 PDF。');
    });

    this.addCommand({
      id: 'open-reader', name: '分层阅读当前笔记',
      checkCallback: (check) => { const f = this.activeNote(); if (!f) return false; if (!check) void this.openReader(f); return true; },
    });
    this.addCommand({
      id: 'fold-note', name: '为当前笔记生成层级（AI）',
      checkCallback: (check) => {
        const f = this.activeNote();
        if (!f) return false;
        if (!check) void this.withDoc(f, (doc) => this.fold(f, doc));
        return true;
      },
    });
    this.addCommand({
      id: 'translate-note', name: '翻译当前笔记全文',
      checkCallback: (check) => {
        const f = this.activeNote();
        if (!f) return false;
        if (!check) void this.withDoc(f, (doc) => {
          if (!this.engine.bilingual(doc)) return void new Notice('这篇笔记已经是阅读语言，不需要翻译。');
          this.translate(f, doc, doc.units, true);
        });
        return true;
      },
    });
    for (const l of LEVELS) {
      this.addCommand({
        id: `level-${l.n}`, name: `切换到层级 ${l.n}：${l.name}`,
        checkCallback: (check) => { const r = this.activeReader(); if (!r) return false; if (!check) void r.setLevel(l.n); return true; },
      });
    }
    this.addCommand({
      id: 'cycle-language', name: '切换 原文 / 对照 / 译文',
      checkCallback: (check) => { const r = this.activeReader(); if (!r) return false; if (!check) r.cycleMode(); return true; },
    });
    this.addCommand({
      id: 'translate-selection', name: '翻译选中内容',
      checkCallback: (check) => { const s = this.selection(); if (!s) return false; if (!check) void this.idxOf(s).then((idx) => this.translateSelection(s.text, s.rect, s.file, idx)); return true; },
    });
    this.addCommand({
      id: 'explain-selection', name: '解释选中内容',
      checkCallback: (check) => { const s = this.selection(); if (!s) return false; if (!check) void this.idxOf(s).then((idx) => this.ask({ file: s.file, focusIdx: idx, quote: s.text, preset: 'explain' })); return true; },
    });
    this.addCommand({
      id: 'ask-selection', name: '就选中内容提问',
      checkCallback: (check) => { const s = this.selection(); if (!s) return false; if (!check) void this.idxOf(s).then((idx) => this.ask({ file: s.file, focusIdx: idx, quote: s.text })); return true; },
    });
    this.addCommand({
      id: 'mineru-pdf', name: '用 MinerU 解析 PDF（识别公式和表格）',
      checkCallback: (check) => {
        const f = this.activeNote();
        const pdf = f?.extension === 'pdf' ? f : f ? this.sourcePdf(f) : null;
        if (!pdf) return false;
        if (!check) this.mineru(pdf);
        return true;
      },
    });
    this.addCommand({
      id: 'extract-pdf', name: '把 PDF 的文字提取为笔记',
      checkCallback: (check) => {
        const f = this.activeNote();
        if (f?.extension !== 'pdf') return false;
        if (!check) void this.extractPdf(f);
        return true;
      },
    });
    this.addCommand({
      id: 'ask-note', name: '就当前笔记提问',
      checkCallback: (check) => { const f = this.activeNote(); if (!f) return false; if (!check) void this.ask({ file: f }); return true; },
    });

    this.registerEvent(this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info) => {
      const file = info.file;
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      const text = editor.getSelection().trim();
      if (text) {
        menu.addItem((i) => i.setTitle('Compress：翻译选中内容').setIcon('languages').onClick(() => {
          const s = this.selection();
          if (s) void this.idxOf(s).then((idx) => this.translateSelection(s.text, s.rect, s.file, idx));
        }));
        menu.addItem((i) => i.setTitle('Compress：解释选中内容').setIcon('lightbulb').onClick(() => {
          void this.focusIdxAt(file, editor.getCursor('from').line).then((idx) => this.ask({ file, focusIdx: idx, quote: text, preset: 'explain' }));
        }));
        menu.addItem((i) => i.setTitle('Compress：就选中内容提问').setIcon('message-square').onClick(() => {
          void this.focusIdxAt(file, editor.getCursor('from').line).then((idx) => this.ask({ file, focusIdx: idx, quote: text }));
        }));
      }
      menu.addItem((i) => i.setTitle('Compress：分层阅读').setIcon('layers').onClick(() => void this.openReader(file)));
    }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || !readable(file)) return;
      menu.addItem((i) => i.setTitle('Compress：分层阅读').setIcon('layers').onClick(() => void this.openReader(file)));
      if (file.extension === 'pdf') {
        menu.addItem((i) => i.setTitle('Compress：用 MinerU 解析（公式、表格）').setIcon('sigma').onClick(() => this.mineru(file)));
        menu.addItem((i) => i.setTitle('Compress：提取文字为笔记').setIcon('file-output').onClick(() => void this.extractPdf(file)));
      }
    }));

    // selecting text in Obsidian's own PDF view offers the same bar as the reader; the selection is remembered, so a
    // command run from the palette (which takes the focus) still finds it
    this.registerDomEvent(document, 'selectionchange', () => this.noteSelection());
    this.registerDomEvent(document, 'mouseup', (e: MouseEvent) => window.setTimeout(() => this.pdfSelBar(e), 0));
    this.registerDomEvent(document, 'mousedown', (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.compress-selbar')) hideSelBar();
    });
  }

  onunload() {
    hideSelBar();
    for (const j of this.jobs.values()) j.abort.abort();
    void this.store.flush();
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<CompressSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}), profiles: { ...(data?.profiles ?? {}) } };
    profileFor(this.settings, this.settings.provider);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  refreshViews() {
    this.events.trigger('settings');
  }

  // ------------------------------------------------------------------------------------------------------------
  // where things are

  /** The note (or PDF) the user is looking at: the active one, or the one the active reader shows. */
  activeNote(): TFile | null {
    const r = this.app.workspace.getActiveViewOfType(ReaderView);
    if (r?.file) return r.file;
    const f = this.app.workspace.getActiveFile();
    return readable(f) ? f : null;
  }

  /** A note or PDF parsed for the reader. A PDF is read through its MinerU note when it has one, else its text is
   *  extracted here (once per version of the file). A note made from a PDF knows its pages by its page markers. */
  async loadDoc(file: TFile): Promise<Loaded> {
    await this.store.ready();
    if (file.extension !== 'pdf') {
      const text = await this.app.vault.cachedRead(file);
      const doc = parse(text, file.basename);
      const pdf = this.sourcePdf(file);
      const pages = pdf ? pagesOfLines(text) : [];
      const pageOf = pages.some((p) => p > 0) ? (u: Unit) => pages[u.line] || 1 : null;
      return { doc, pageOf, pdf, sourcePath: file.path, via: 'md' };
    }
    const note = this.mineruNote(file);
    if (note) return { ...(await this.loadDoc(note)), pdf: file, via: 'mineru' };
    const lay = await this.pdfLayout(file);
    const doc = parse(lay.md, file.basename);
    return { doc, pageOf: (u) => lay.pages[u.line] ?? 1, pdf: file, sourcePath: file.path, via: 'pdfjs' };
  }

  /** The PDF a note was made from (its compress-source property), if any. */
  sourcePdf(note: TFile): TFile | null {
    const src = this.app.metadataCache.getFileCache(note)?.frontmatter?.['compress-source'];
    if (typeof src !== 'string') return null;
    const link = src.replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0];
    const f = this.app.metadataCache.getFirstLinkpathDest(link, note.path);
    return f && f.extension === 'pdf' ? f : null;
  }

  /** The note MinerU made of a PDF, beside it. */
  mineruNote(pdf: TFile): TFile | null {
    for (const f of pdf.parent?.children ?? []) {
      if (!(f instanceof TFile) || f.extension !== 'md') continue;
      if (this.app.metadataCache.getFileCache(f)?.frontmatter?.['compress-parser'] === 'mineru' && this.sourcePdf(f) === pdf) return f;
    }
    return null;
  }

  /** Reads a PDF with MinerU (its cloud API or the local command), writes the note, and shows it in the reader. */
  mineru(pdf: TFile) {
    const s = this.settings;
    if (s.mineruMode === 'cloud' && !s.mineruToken.trim()) return void new Notice('还没有填写 MinerU Token：设置 › Compress › PDF 解析', 8000);
    const notice = new Notice('MinerU：准备中…', 0);
    void this.openReader(pdf);
    this.run(pdf, 'MinerU', async (o) => {
      try {
        const step = (done: number, total: number, label?: string) => {
          o.progress?.(done, total);
          notice.setMessage(`MinerU：${label ?? '解析中'}${total ? ` ${done}/${total} 页` : '…'}（${pdf.basename}）`);
        };
        const out = s.mineruMode === 'local' ? await runLocal(this.app, pdf, s, step, o.signal) : await runCloud(this.app, pdf, s, step, o.signal);
        const note = await saveNote(this.app, pdf, out, this.mineruNote(pdf));
        // the metadata cache reads the new note's properties a moment later: the reader reloads once it has
        await new Promise<void>((resolve) => {
          const ref = this.app.metadataCache.on('changed', (f) => { if (f === note) { this.app.metadataCache.offref(ref); resolve(); } });
          window.setTimeout(() => { this.app.metadataCache.offref(ref); resolve(); }, 3000);
        });
        new Notice(`MinerU 解析完成：${note.path}`, 6000);
        this.events.trigger('reload', pdf.path);
        return [];
      } catch (e) {
        if (e instanceof MinerUError) new Notice(e.message, 12000);
        throw e instanceof MinerUError ? new Stopped() : e;   // (said already)
      } finally {
        notice.hide();
      }
    });
  }

  pdfLayout(file: TFile): Promise<Layout> {
    const hit = this.pdfs.get(file.path);
    if (hit && hit.mtime === file.stat.mtime && hit.size === file.stat.size) return hit.layout;
    const job = readPdf(this.app, file).then(layout);
    job.catch(() => this.pdfs.delete(file.path));
    this.pdfs.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, layout: job });
    return job;
  }

  /** A PDF's text as a Markdown note beside it (its levels and translations carry over: they go by the text). */
  async extractPdf(file: TFile) {
    const notice = new Notice('正在提取 PDF 文字…', 0);
    try {
      const lay = await this.pdfLayout(file);
      if (!lay.md.trim()) return void new Notice('这个 PDF 里没有可提取的文字（可能是扫描件，需要先做 OCR）。', 8000);
      const dir = file.parent && file.parent.path !== '/' ? `${file.parent.path}/` : '';
      let path = normalizePath(`${dir}${file.basename}.md`);
      for (let n = 1; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${dir}${file.basename}（文字${n > 1 ? n : ''}）.md`);
      // page markers (invisible in Obsidian) before each page's first block: the note's paragraphs still open the PDF
      const lines = lay.md.split('\n');
      const body: string[] = [];
      let page = 0;
      lines.forEach((line, i) => {
        if (line.trim() && !lines[i - 1]?.trim() && lay.pages[i] !== page) {
          page = lay.pages[i];
          body.push(`%% page ${page} %%`, '');
        }
        body.push(line);
      });
      const note = await this.app.vault.create(path, `---\ncompress-source: "[[${file.path}]]"\ncompress-parser: pdfjs\n---\n\n${body.join('\n')}\n`);
      new Notice(`已提取到 ${note.path}`);
      await this.app.workspace.getLeaf('tab').openFile(note);
    } catch (e) {
      new Notice(`提取失败：${(e as Error).message}`, 8000);
    } finally {
      notice.hide();
    }
  }

  private activeReader(): ReaderView | null {
    return this.app.workspace.getActiveViewOfType(ReaderView) ?? this.readers()[0] ?? null;
  }

  private readers(file?: TFile): ReaderView[] {
    return this.app.workspace.getLeavesOfType(READER).map((l) => l.view).filter((v): v is ReaderView => v instanceof ReaderView && (!file || v.file === file));
  }

  private async withDoc(f: TFile, fn: (doc: Doc) => void) {
    try {
      fn((await this.loadDoc(f)).doc);
    } catch (e) {
      new Notice(`读取失败：${(e as Error).message}`);
    }
  }

  /** The paragraph number at a line of a note. */
  async focusIdxAt(file: TFile, line: number): Promise<number | undefined> {
    const { doc } = await this.loadDoc(file);
    let hit: Unit | undefined;
    for (const u of doc.units) if (u.line <= line) hit = u;
    return hit?.idx;
  }

  /** What is selected, wherever it is: the editor, reading view or the reader. */
  private selection(): Selected | null {
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (md?.file && md.getMode() === 'source') {
      const ed = md.editor;
      const text = ed.getSelection().trim();
      if (!text) return null;
      const cm = (ed as unknown as { cm?: { coordsAtPos(pos: number): { left: number; top: number; bottom: number } | null } }).cm;
      const c = cm?.coordsAtPos(ed.posToOffset(ed.getCursor('to')));
      const box = md.contentEl.getBoundingClientRect();
      const rect = c ? new DOMRect(c.left, c.top, 1, c.bottom - c.top) : new DOMRect(box.left + 40, box.top + 80, 1, 1);
      return { text, rect, file: md.file, line: ed.getCursor('from').line };
    }
    return this.domSelection() ?? (this.lastSel && Date.now() - this.lastSel.at < 60000 ? this.lastSel : null);
  }

  /** The page's selected text, in the reader, a reading view or a PDF. */
  private domSelection(): Selected | null {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    const file = this.activeNote();
    if (!sel || sel.isCollapsed || !text || !file || !sel.rangeCount) return null;
    const host = (sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest('.compress-unit') as HTMLElement | null;
    return { text, rect: sel.getRangeAt(0).getBoundingClientRect(), file, idx: host?.dataset.idx ? Number(host.dataset.idx) : undefined };
  }

  private noteSelection() {
    const s = this.domSelection();
    if (s) this.lastSel = { ...s, at: Date.now() };
  }

  /** The selection bar over text selected in Obsidian's PDF view. */
  private pdfSelBar(e: MouseEvent) {
    if (!this.settings.pdfBar || !(e.target as HTMLElement).closest?.('.workspace-leaf-content[data-type="pdf"]')) return;
    const s = this.domSelection();
    if (!s || s.file.extension !== 'pdf') return;
    const go = (fn: (idx?: number) => void) => () => void this.idxOf(s).then(fn);
    const actions = [
      { icon: 'lightbulb', label: '解释', run: go((idx) => void this.ask({ file: s.file, focusIdx: idx, quote: s.text, preset: 'explain' })) },
      { icon: 'message-square', label: '提问', run: go((idx) => void this.ask({ file: s.file, focusIdx: idx, quote: s.text })) },
    ];
    if (!isCJK(s.text) || !isCjkLang(this.settings.target)) actions.unshift({ icon: 'languages', label: '翻译', run: go((idx) => this.translateSelection(s.text, s.rect, s.file, idx)) });
    showSelBar(s.rect, actions);
  }

  /** The paragraph a selection is in: known in the reader, looked up by line in the editor. */
  private async idxOf(s: Selected): Promise<number | undefined> {
    if (s.idx !== undefined) return s.idx;
    if (s.line !== undefined) return this.focusIdxAt(s.file, s.line);
    try {
      return unitByQuote((await this.loadDoc(s.file)).doc, s.text);
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // views

  async openReader(file: TFile): Promise<ReaderView | null> {
    const open = this.readers(file)[0] ?? this.readers()[0];
    let leaf: WorkspaceLeaf;
    if (open) {
      leaf = open.leaf;
      if (open.file !== file) await open.setFile(file);
    } else {
      // beside the note when it is open in the main area, else in a new tab (never inside a sidebar)
      const src = this.app.workspace.getLeavesOfType('markdown').find((l) => (l.view as MarkdownView).file === file && l.getRoot() === this.app.workspace.rootSplit);
      leaf = src ? this.app.workspace.createLeafBySplit(src, 'vertical') : this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: READER, state: { file: file.path }, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof ReaderView ? leaf.view : null;
  }

  private async openChat(): Promise<ChatView | null> {
    let leaf = this.app.workspace.getLeavesOfType(CHAT)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('split', 'vertical');
      await leaf.setViewState({ type: CHAT, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  async ask(o: AskOpts) {
    const chat = await this.openChat();
    await chat?.prepare(o);
  }

  /** Opens a note at a line, in the editor already showing it if there is one. */
  async reveal(file: TFile, line: number) {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    const leaf = leaves.find((l) => (l.view as MarkdownView).file === file) ?? leaves[0] ?? this.app.workspace.getLeaf('tab');
    if ((leaf.view as MarkdownView).file !== file) await leaf.openFile(file);
    await this.app.workspace.revealLeaf(leaf);
    const v = leaf.view;
    if (v instanceof MarkdownView) {
      if (v.getMode() === 'source') {
        v.editor.setCursor({ line, ch: 0 });
        v.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      } else {
        leaf.setEphemeralState({ line });
      }
    }
  }

  /** Opens a PDF at a page: in the view already showing it, else beside the reader. */
  async revealPdf(file: TFile, page: number) {
    let leaf = this.app.workspace.getLeavesOfType('pdf').find((l) => (l.view as unknown as { file?: TFile }).file === file);
    if (!leaf) {
      const r = this.readers(file)[0];
      leaf = r && r.leaf.getRoot() === this.app.workspace.rootSplit ? this.app.workspace.createLeafBySplit(r.leaf, 'vertical', true) : this.app.workspace.getLeaf('tab');
    }
    await leaf.openFile(file, { active: true, eState: { subpath: `#page=${page}` } });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** A cited paragraph: flashed in a reader showing its note, else the note (or the PDF's page) opened at it. */
  revealUnit(path: string, idx: number) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const r = this.readers(f)[0];
    if (r) {
      void this.app.workspace.revealLeaf(r.leaf);
      void r.flash(idx);
      return;
    }
    void this.loadDoc(f).then(({ doc, pageOf, pdf }) => {
      const u = doc.units[idx - 1];
      if (!u) return;
      if (pageOf && pdf) void this.revealPdf(pdf, pageOf(u)); else void this.reveal(f, u.line);
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // model work, one job a note at a time, its progress shown in the reader

  jobOf(path: string): Job | null { return this.jobs.get(path) ?? null; }

  private run(file: TFile, label: string, work: (o: RunOpts) => Promise<unknown[]>) {
    const path = file.path;
    if (this.jobs.has(path)) return void new Notice('这篇笔记正在处理中，稍等或先停止。');
    const job: Job = { label, done: 0, total: 0, abort: new AbortController() };
    this.jobs.set(path, job);
    this.events.trigger('job', path);
    const changed = throttle(() => this.events.trigger('changed', path), 700);
    work({
      signal: job.abort.signal,
      progress: (done, total) => { job.done = done; job.total = total; this.events.trigger('job', path); },
      onSection: () => changed(),
    }).then((errors) => {
      const real = errors.filter((e) => !(e instanceof Stopped));
      if (real.length) new Notice(`${label}：${real.length} 个请求失败。${(real[0] as Error).message ?? ''}`, 8000);
    }).catch((e: unknown) => {
      if (!(e instanceof Stopped) && !job.abort.signal.aborted) new Notice(`${label}失败：${(e as Error).message}`, 10000);
    }).finally(() => {
      this.jobs.delete(path);
      void this.store.flush();
      this.events.trigger('job', path);
      this.events.trigger('changed', path);
    });
  }

  fold(file: TFile, doc: Doc, sections?: Section[]) {
    const why = this.llm.ready();
    if (why) return void new Notice(why);
    const todo = sections ?? this.engine.pending(doc);
    if (!todo.length) return void new Notice('这篇笔记的层级都已生成。');
    this.run(file, '生成层级', (o) => this.engine.fold(doc, todo, o));
  }

  /** Translates units; an automatic call (from the reader) asks for each unit once a session. */
  translate(file: TFile, doc: Doc, units: Unit[], explicit = false) {
    const why = this.llm.ready();
    if (why) return void new Notice(why);
    const todo = units.filter((u) => !this.engine.translation(u) && (explicit || !this.trTried.has(u.hash)));
    if (!todo.length) return;
    for (const u of todo) this.trTried.add(u.hash);
    this.run(file, '翻译', (o) => this.engine.translate(doc, todo, o));
  }

  translateSelection(text: string, rect: DOMRect, file: TFile, idx?: number) {
    const why = this.llm.ready();
    if (why) return void new Notice(why);
    const s = this.settings;
    const to = isCJK(text) && isCjkLang(s.target) ? 'en' : s.target;   // a Chinese passage is read in English
    const pop = new Popover(this.app, rect, `译文 · ${LANGS[to]?.native ?? to}`, file.path);
    let result = '';
    pop.addAction('解释', 'lightbulb', () => { pop.close(); void this.ask({ file, focusIdx: idx, quote: text, preset: 'explain' }); });
    pop.addAction('追问', 'message-square', () => { pop.close(); void this.ask({ file, focusIdx: idx, quote: text }); });
    pop.addAction('复制译文', 'copy', () => { if (result) void navigator.clipboard.writeText(result); });
    const p = selectionTranslatePrompt(text, to, file.basename, s.glossary);
    this.llm.text({ task: 'quick', system: p.system, messages: [{ role: 'user', content: p.user }], signal: pop.abort.signal, onText: (md) => pop.setMarkdown(md) })
      .then((full) => { result = full.trim(); pop.setMarkdown(result || '（模型没有返回内容）'); })
      .catch((e: unknown) => { if (!(e instanceof Stopped)) pop.setError((e as Error).message); });
  }
}
