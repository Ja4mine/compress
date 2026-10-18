// The reader: a note at one of five levels, beside the note itself. Keys 1 to 5 (or ⌘/Ctrl + scroll, or a pinch)
// change the level around the paragraph under the pointer; a click opens one paragraph to its full text, a click on
// a heading its whole section. Selecting text offers a translation and questions.

import { Component, ItemView, Menu, Notice, Scope, setIcon, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type CompressPlugin from '../main';
import { readable } from '../files';
import { LangMode, LEVELS, ROLE_NAMES, showUnit, showUnitTr } from '../core/levels';
import { Doc, Raw, Section, Unit } from '../core/parse';
import { isCjkLang, LANGS } from '../ai/prompts';
import { handleLinks, renderMd } from './markdown';
import { formulasIn } from '../core/mineru';
import { hideSelBar, selBarShown, showSelBar } from './selbar';

export const READER = 'compress-reader';

const RAW_NAME: Record<Raw['kind'], string> = {
  code: '代码', math: '公式', table: '表格', image: '图片', callout: '标注', html: 'HTML', rule: '', footnote: '脚注',
};

interface Anchor { idx: number | null; sid: string | null; top: number }

export class ReaderView extends ItemView {
  file: TFile | null = null;
  doc: Doc | null = null;
  level: number;
  mode: LangMode;
  private unitOpen = new Set<string>();   // unit hashes shown at full text
  private secOpen = new Set<string>();    // section hashes shown at full text
  private rawOpen = new Set<string>();    // raw blocks shown whole
  private trOpen = new Set<string>();     // units showing their translation in original mode
  private trBusy = new Set<string>();
  private toolbar!: HTMLElement;
  private body!: HTMLElement;
  private renderOwner: Component | null = null;
  private renderSeq = 0;
  private wheelAcc = 0;
  private pointer: { x: number; y: number } | null = null;
  private pageOf: ((u: Unit) => number) | null = null;   // a PDF's paragraphs know their page
  private pdf: TFile | null = null;                         // the PDF itself, or the one a note was made from
  private sourcePath = '';                                  // where links and pictures resolve from
  private via: 'md' | 'pdfjs' | 'mineru' = 'md';
  private mdOf = new WeakMap<HTMLElement, string>();         // what each rendered text was rendered from (its formulas)
  private loading = false;
  private failed = '';
  private reloadTimer: number | null = null;
  private zoomed = false;

  constructor(leaf: WorkspaceLeaf, private plugin: CompressPlugin) {
    super(leaf);
    this.level = plugin.settings.defaultLevel;
    this.mode = plugin.settings.langMode;
    this.navigation = false;
  }

  getViewType() { return READER; }
  getIcon() { return 'layers'; }
  getDisplayText() { return this.file ? `分层：${this.file.basename}` : 'Compress 阅读器'; }

  getState(): Record<string, unknown> {
    return { file: this.file?.path ?? null, level: this.level, mode: this.mode };
  }

  async setState(state: { file?: string; level?: number; mode?: LangMode }, result: ViewStateResult): Promise<void> {
    if (state.level) this.level = state.level;
    if (state.mode) this.mode = state.mode;
    const f = state.file ? this.app.vault.getAbstractFileByPath(state.file) : null;
    if (f instanceof TFile) await this.setFile(f);
    await super.setState(state, result);
  }

  async onOpen() {
    this.contentEl.addClass('compress-reader');
    this.toolbar = this.contentEl.createDiv({ cls: 'compress-toolbar' });
    this.body = this.contentEl.createDiv({ cls: 'compress-body' });
    this.scope = new Scope(this.app.scope);
    for (const n of [1, 2, 3, 4, 5]) this.scope.register([], String(n), () => { void this.setLevel(n); return false; });
    this.scope.register([], 'l', () => { this.cycleMode(); return false; });
    this.scope.register([], 'Escape', () => { hideSelBar(); return true; });

    handleLinks(this.app, this.body, () => this.sourcePath || this.file?.path || '', this);
    this.registerDomEvent(this.body, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    this.registerDomEvent(this.body, 'mousemove', (e: MouseEvent) => { this.pointer = { x: e.clientX, y: e.clientY }; });
    this.registerDomEvent(this.body, 'mouseleave', () => { this.pointer = null; });
    this.registerDomEvent(this.body, 'mouseup', () => window.setTimeout(() => this.onSelect(), 0));
    this.registerDomEvent(this.body, 'scroll', () => hideSelBar());
    this.registerDomEvent(document, 'selectionchange', () => {
      const s = window.getSelection();
      if (selBarShown() && (!s || s.isCollapsed)) hideSelBar();
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (!this.plugin.settings.follow || !leaf || leaf === this.leaf) return;
      const v = leaf.view;
      const f = (v as unknown as { file?: TFile | null }).file ?? null;
      if ((v.getViewType() === 'markdown' || v.getViewType() === 'pdf') && readable(f) && f !== this.file) void this.setFile(f);
    }));
    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (f !== this.file) return;
      if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
      this.reloadTimer = window.setTimeout(() => void this.reload(), 800);
    }));
    this.registerEvent(this.app.vault.on('rename', (f) => { if (f === this.file) this.updateHeader(); }));
    this.registerEvent(this.app.vault.on('delete', (f) => { if (f === this.file) { this.file = null; this.doc = null; void this.render(); } }));
    this.registerEvent(this.plugin.events.on('changed', (path: unknown) => { if (path === this.file?.path) void this.render(); }));
    this.registerEvent(this.plugin.events.on('job', (path: unknown) => { if (path === this.file?.path) this.drawToolbar(); }));
    this.registerEvent(this.plugin.events.on('settings', () => void this.render()));
    this.registerEvent(this.plugin.events.on('reload', (path: unknown) => { if (path === this.file?.path) void this.reload(); }));
    this.registerEvent(this.app.metadataCache.on('changed', (f) => { if (f.path === this.sourcePath && f !== this.file) void this.reload(); }));

    // a view restored from the layout gets its note from setState right after this; a new one shows the active note
    window.setTimeout(() => {
      if (this.file) return;
      const f = this.app.workspace.getActiveFile();
      if (f && f.extension === 'md') void this.setFile(f);
      else void this.render();
    }, 50);
  }

  async onClose() {
    hideSelBar();
    this.renderOwner?.unload();
  }

  // ------------------------------------------------------------------------------------------------------------
  async setFile(f: TFile) {
    if (!readable(f)) return;
    const changed = f !== this.file;
    this.file = f;
    if (changed) {
      this.unitOpen.clear();
      this.secOpen.clear();
      this.rawOpen.clear();
      this.trOpen.clear();
    }
    this.updateHeader();
    if (changed) this.app.workspace.requestSaveLayout();
    await this.reload(changed);
  }

  private async reload(top = false) {
    if (!this.file) return;
    await this.plugin.store.ready();
    const file = this.file;
    this.failed = '';
    if (file.extension === 'pdf' && top) {   // extracting a long PDF's text takes a moment
      this.loading = true;
      this.doc = null;
      void this.render();
    }
    try {
      const loaded = await this.plugin.loadDoc(file);
      if (file !== this.file) return;
      this.doc = loaded.doc;
      this.pageOf = loaded.pageOf;
      this.pdf = loaded.pdf;
      this.sourcePath = loaded.sourcePath;
      this.via = loaded.via;
    } catch (e) {
      if (file !== this.file) return;
      this.doc = null;
      this.failed = `读取失败：${(e as Error).message}`;
    } finally {
      this.loading = false;
    }
    await this.render(top ? { idx: null, sid: null, top: 0 } : undefined);
    if (this.doc && this.plugin.settings.autoFold && this.plugin.engine.pending(this.doc).length && !this.plugin.llm.ready()) this.plugin.fold(file, this.doc);
  }

  async setLevel(n: number, anchor?: Anchor) {
    if (n < 1 || n > 5 || n === this.level) return;
    const a = anchor ?? this.anchor();
    this.level = n;
    this.zoomed = true;
    this.app.workspace.requestSaveLayout();
    await this.render(a);
  }

  cycleMode() {
    if (!this.translatable()) return;
    const order: LangMode[] = ['orig', 'both', 'tr'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % 3]);
  }

  setMode(m: LangMode) {
    this.mode = m;
    this.app.workspace.requestSaveLayout();
    void this.render(this.anchor());
  }

  /** The tab's title follows the note (WorkspaceLeaf.updateHeader is not in the public API, so it may be absent). */
  private updateHeader() {
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
  }

  private translatable() { return !!this.doc && this.plugin.engine.bilingual(this.doc); }

  // ------------------------------------------------------------------------------------------------------------
  // keeping the reader's place: the paragraph under the pointer (or at the top) stays where it was

  private anchor(): Anchor {
    const rect = this.body.getBoundingClientRect();
    let el: Element | null = null;
    if (this.pointer) el = document.elementFromPoint(this.pointer.x, this.pointer.y)?.closest('.compress-unit, .compress-section') ?? null;
    if (!el) {
      for (const c of Array.from(this.body.querySelectorAll('.compress-unit, .compress-section'))) {
        if (c.getBoundingClientRect().bottom > rect.top + 8) { el = c; break; }
      }
    }
    if (!el) return { idx: null, sid: null, top: 0 };
    const html = el as HTMLElement;
    const sec = html.closest('.compress-section') as HTMLElement | null;
    return { idx: html.dataset.idx ? Number(html.dataset.idx) : null, sid: sec?.dataset.sid ?? null, top: html.getBoundingClientRect().top - rect.top };
  }

  private restore(a: Anchor) {
    if (a.idx === null && a.sid === null) { this.body.scrollTop = 0; return; }
    let el: HTMLElement | null = null;
    if (a.idx !== null) el = this.body.querySelector(`.compress-unit[data-idx="${a.idx}"]`);
    if (!el && a.idx !== null && this.doc) {
      // hidden at this level: the nearest shown paragraph before it, else its section
      for (let i = a.idx - 1; i >= 1 && !el; i--) el = this.body.querySelector(`.compress-unit[data-idx="${i}"]`);
    }
    if (!el && a.sid) el = this.body.querySelector(`[data-sid="${a.sid}"]`);
    if (!el) return;
    const rect = this.body.getBoundingClientRect();
    this.body.scrollTop += el.getBoundingClientRect().top - rect.top - a.top;
  }

  private onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    this.wheelAcc += e.deltaY;
    if (Math.abs(this.wheelAcc) < 40) return;
    const step = this.wheelAcc > 0 ? 1 : -1;   // pinching in, or scrolling down, zooms out
    this.wheelAcc = 0;
    this.pointer = { x: e.clientX, y: e.clientY };
    void this.setLevel(Math.max(1, Math.min(5, this.level + step)));
  }

  // ------------------------------------------------------------------------------------------------------------
  drawToolbar() {
    const t = this.toolbar;
    if (!t) return;
    t.empty();
    const levels = t.createDiv({ cls: 'compress-levels' });
    for (const l of LEVELS) {
      const b = levels.createEl('button', { cls: 'compress-level', attr: { 'aria-label': `${l.n} ${l.name}：${l.hint}`, 'data-tooltip-position': 'bottom' } });
      b.createSpan({ cls: 'compress-level-n', text: String(l.n) });
      b.createSpan({ cls: 'compress-level-name', text: l.name });
      if (l.n === this.level) b.addClass('is-active');
      b.onclick = () => void this.setLevel(l.n);
    }
    if (this.translatable()) {
      const langs = t.createDiv({ cls: 'compress-langs' });
      const target = LANGS[this.plugin.settings.target]?.native ?? '译文';
      for (const [m, name] of [['orig', '原文'], ['both', '对照'], ['tr', target]] as const) {
        const b = langs.createEl('button', { text: name, attr: { 'aria-label': m === 'orig' ? '只看原文（L）' : m === 'both' ? '原文和译文对照（L）' : `只看${target}（L）` } });
        if (m === this.mode) b.addClass('is-active');
        b.onclick = () => this.setMode(m);
      }
    }
    const right = t.createDiv({ cls: 'compress-tools' });
    const job = this.file ? this.plugin.jobOf(this.file.path) : null;
    if (job) {
      const s = right.createDiv({ cls: 'compress-progress' });
      s.createSpan({ text: `${job.label} ${job.done}/${job.total || '…'}` });
      const bar = s.createDiv({ cls: 'compress-bar' }).createDiv();
      bar.style.width = `${job.total ? Math.round((job.done / job.total) * 100) : 5}%`;
      const stop = right.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '停止' } });
      setIcon(stop, 'square');
      stop.onclick = () => job.abort.abort();
    } else if (this.doc && this.plugin.engine.pending(this.doc).length) {
      const b = right.createEl('button', { cls: 'mod-cta compress-fold-btn', attr: { 'aria-label': `用 ${this.plugin.llm.model('fold') || '模型'} 为每段写出精要、要点和主题` } });
      setIcon(b.createSpan(), 'sparkles');
      b.createSpan({ text: 'AI 生成层级' });
      b.onclick = () => this.fold();
    }
    const ask = right.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '就全文提问' } });
    setIcon(ask, 'message-square');
    ask.onclick = () => { if (this.file) void this.plugin.ask({ file: this.file }); };
    const more = right.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '更多' } });
    setIcon(more, 'more-vertical');
    more.onclick = (e) => this.moreMenu(e);
  }

  private moreMenu(e: MouseEvent) {
    const m = new Menu();
    const file = this.file;
    const doc = this.doc;
    if (file && doc) {
      m.addItem((i) => i.setTitle('AI 生成层级').setIcon('sparkles').onClick(() => this.fold()));
      m.addItem((i) => i.setTitle('重新生成全部层级').setIcon('refresh-cw').onClick(() => {
        this.plugin.engine.forget(doc, doc.sections);
        this.fold();
      }));
      if (this.translatable()) m.addItem((i) => i.setTitle('翻译全文').setIcon('languages').onClick(() => this.plugin.translate(file, doc, doc.units)));
      m.addSeparator();
      if (file.extension === 'pdf') {
        m.addItem((i) => i.setTitle('打开 PDF').setIcon('file-text').onClick(() => void this.plugin.revealPdf(file, 1)));
        m.addItem((i) => i.setTitle(this.via === 'mineru' ? '用 MinerU 重新解析' : '用 MinerU 解析（公式、表格）').setIcon('sigma').onClick(() => this.plugin.mineru(file)));
        if (this.via !== 'mineru') m.addItem((i) => i.setTitle('把文字提取为笔记').setIcon('file-output').onClick(() => void this.plugin.extractPdf(file)));
      } else {
        m.addItem((i) => i.setTitle('打开原笔记').setIcon('file-text').onClick(() => void this.plugin.reveal(file, 0)));
      }
      m.addItem((i) => i.setTitle(`跟随当前笔记：${this.plugin.settings.follow ? '开' : '关'}`).setIcon('link').onClick(async () => {
        this.plugin.settings.follow = !this.plugin.settings.follow;
        await this.plugin.saveSettings();
      }));
    }
    m.showAtMouseEvent(e);
  }

  private fold() {
    if (!this.file || !this.doc) return;
    const why = this.plugin.llm.ready();
    if (why) return new Notice(why);
    this.plugin.fold(this.file, this.doc);
  }

  // ------------------------------------------------------------------------------------------------------------
  async render(anchor?: Anchor) {
    const seq = ++this.renderSeq;
    const a = anchor ?? (this.body?.childElementCount ? this.anchor() : { idx: null, sid: null, top: 0 });
    this.drawToolbar();
    const owner = new Component();
    owner.load();
    const fresh = createDiv({ cls: 'compress-page' });
    fresh.toggleClass('is-map', this.level === 5);
    fresh.toggleClass('is-zoom', this.zoomed);
    this.zoomed = false;
    const tasks: Promise<void>[] = [];
    const missingTr: Unit[] = [];

    if (!this.file || !this.doc) {
      fresh.createDiv({ cls: 'compress-empty', text: this.loading ? '正在提取 PDF 的文字…' : this.failed || '打开一篇 Markdown 笔记或 PDF，这里会显示它的分层视图。' });
    } else if (!this.doc.units.length && this.file.extension === 'pdf') {
      fresh.createDiv({ cls: 'compress-title', text: this.doc.title });
      fresh.createDiv({ cls: 'compress-empty', text: '这个 PDF 里没有可提取的文字层，可能是扫描件或图片。需要先用 OCR 工具（例如 macOS 预览的“识别文本”、ABBYY、或 MinerU）转成带文字的 PDF。' });
    } else {
      const doc = this.doc;
      fresh.createDiv({ cls: 'compress-title', text: doc.title });
      this.banner(fresh, doc);
      if (this.level === 5) this.renderMap(fresh, doc);
      else for (const s of doc.sections) this.renderSection(fresh, doc, s, owner, tasks, missingTr);
    }
    await Promise.all(tasks);
    if (seq !== this.renderSeq) { owner.unload(); return; }
    this.renderOwner?.unload();
    this.renderOwner = owner;
    this.body.empty();
    this.body.appendChild(fresh);
    this.restore(a);
    // a translated view translates what it is missing (a single paragraph's 译 button asks on its own)
    if (this.mode !== 'orig' && missingTr.length && this.file && this.doc && !this.plugin.jobOf(this.file.path) && !this.plugin.llm.ready()) {
      this.plugin.translate(this.file, this.doc, this.unitsToTranslate(this.doc, missingTr));
    }
  }

  /** In a translated view, a section's worth at a time: the sections the missing units are in. */
  private unitsToTranslate(doc: Doc, missing: Unit[]): Unit[] {
    if (this.level >= 3) return missing;
    const secs = new Set(missing.map((u) => u.section));
    return doc.units.filter((u) => secs.has(u.section));
  }

  private banner(el: HTMLElement, doc: Doc) {
    if (this.via === 'pdfjs') {
      const b = el.createDiv({ cls: 'compress-banner compress-muted' });
      b.createSpan({ text: '从 PDF 直接提取的文字：公式会变成零散符号，图表、脚注和参考文献收在折叠块里。' });
      const go = b.createEl('a', { text: '用 MinerU 解析，识别公式和表格', href: '#' });
      go.onclick = (e) => { e.preventDefault(); if (this.file) this.plugin.mineru(this.file); };
    } else if (this.via === 'mineru') {
      const b = el.createDiv({ cls: 'compress-banner compress-muted' });
      b.createSpan({ text: 'MinerU 解析的版本：公式为 LaTeX，点公式可以让 AI 讲解。' });
      const open = b.createEl('a', { text: '打开这篇笔记', href: '#' });
      open.onclick = (e) => {
        e.preventDefault();
        const f = this.app.vault.getAbstractFileByPath(this.sourcePath);
        if (f instanceof TFile) void this.app.workspace.getLeaf('tab').openFile(f);
      };
    }
    const pending = this.plugin.engine.pending(doc);
    if (!pending.length || this.level <= 1) return;
    const b = el.createDiv({ cls: 'compress-banner' });
    const why = this.plugin.llm.ready();
    if (pending.length === doc.sections.filter((s) => s.units.some((u) => !u.short)).length) {
      b.createSpan({ text: '还没有生成层级：现在看到的是本地折叠，每段只取开头的句子。' });
    } else {
      b.createSpan({ text: `还有 ${pending.length} 节没有生成层级，这些节暂用本地折叠。` });
    }
    if (why) b.createSpan({ cls: 'compress-muted', text: ` ${why}` });
  }

  private renderSection(page: HTMLElement, doc: Doc, s: Section, owner: Component, tasks: Promise<void>[], missingTr: Unit[]) {
    const el = page.createDiv({ cls: 'compress-section', attr: { 'data-sid': s.id } });
    const open = this.secOpen.has(s.hash);
    const level = open ? 1 : this.level;
    const engine = this.plugin.engine;
    const secLad = engine.sectionLadder(doc, s);
    const mode = this.translatable() ? this.mode : 'orig';
    if (s.level > 0 && !(s.level === 1 && s.title === doc.title)) {   // (the note's title is already above)
      const h = el.createDiv({ cls: `compress-heading compress-h${s.level}` });
      h.createSpan({ cls: 'compress-heading-text', text: s.title });
      if (open) h.addClass('is-open');
      h.setAttr('aria-label', open ? '收起本节' : '展开本节全文');
      h.onclick = () => {
        if (open) this.secOpen.delete(s.hash); else this.secOpen.add(s.hash);
        void this.render(this.anchorAt(null, s.id, h));
      };
      if (secLad || s.units.some((u) => !u.short)) {
        const redo = h.createEl('button', { cls: 'clickable-icon compress-heading-redo', attr: { 'aria-label': secLad ? '重新生成本节层级' : '生成本节层级' } });
        setIcon(redo, secLad ? 'refresh-cw' : 'sparkles');
        redo.onclick = (e) => {
          e.stopPropagation();
          if (!this.file) return;
          const why = this.plugin.llm.ready();
          if (why) return new Notice(why);
          engine.forget(doc, [s]);
          this.plugin.fold(this.file, doc, [s]);
        };
      }
    }
    if (secLad && level >= 3) {
      const line = el.createDiv({ cls: 'compress-secline' });
      if (mode !== 'tr' || !secLad.tr) line.createDiv({ text: secLad.orig.take });
      if (mode !== 'orig' && secLad.tr) line.createDiv({ cls: mode === 'both' ? 'compress-tr' : '', text: secLad.tr.take });
    }
    const cjk = isCjkLang(this.plugin.settings.target);
    let first = true;
    let lastIdx: number | undefined;   // the paragraph a display formula follows: its context when it is asked about
    for (const b of s.blocks) {
      if (b.t === 'raw') {
        this.renderRaw(el, b.r, level, owner, tasks, lastIdx);
        continue;
      }
      const u = b.u;
      lastIdx = u.idx;
      const eff = this.unitOpen.has(u.hash) ? 1 : level;
      const lad = engine.unitLadder(doc, u);
      const show = showUnit(u, eff, lad, first);
      const wantTr = mode !== 'orig' || this.trOpen.has(u.hash);
      const tr = wantTr ? engine.translation(u) : null;
      const trShow = wantTr ? showUnitTr(u, eff, lad, tr, first, cjk) : null;
      if (wantTr && !trShow && !this.trBusy.has(u.hash) && (eff <= 2 || !lad || u.short)) missingTr.push(u);
      if (show.md) first = false;
      if (!show.md && !trShow?.md) continue;

      const ue = el.createDiv({ cls: 'compress-unit', attr: { 'data-idx': String(u.idx) } });
      ue.toggleClass('is-written', show.written);
      ue.toggleClass('is-open', this.unitOpen.has(u.hash));
      ue.toggleClass('has-more', show.more);
      ue.createSpan({ cls: 'compress-pnum', text: `¶${u.idx}` });
      if (this.plugin.settings.showRoles && lad && (eff === 3 || eff === 4) && !u.short) {
        ue.createSpan({ cls: 'compress-role', text: ROLE_NAMES[lad.role] ?? lad.role, attr: { 'data-role': lad.role } });
      }
      const showOrig = mode !== 'tr' || !trShow;
      if (showOrig) {
        const o = ue.createDiv({ cls: 'compress-u-text' });
        this.mdOf.set(o, show.md);
        tasks.push(renderMd(this.app, show.md, o, this.sourcePath || this.file!.path, owner));
      }
      if (trShow?.md && (mode !== 'orig' || this.trOpen.has(u.hash))) {
        const t = ue.createDiv({ cls: showOrig ? 'compress-u-text compress-tr' : 'compress-u-text' });
        this.mdOf.set(t, trShow.md);
        tasks.push(renderMd(this.app, trShow.md, t, this.sourcePath || this.file!.path, owner));
      } else if (wantTr && this.trBusy.has(u.hash)) {
        ue.createDiv({ cls: 'compress-tr compress-thinking', text: '翻译中…' });
      }
      this.unitActions(ue, u);
      ue.onclick = (e) => this.onUnitClick(e, u, ue);
    }
  }

  private renderRaw(el: HTMLElement, r: Raw, level: number, owner: Component, tasks: Promise<void>[], near?: number) {
    const open = this.rawOpen.has(r.id) || level <= 2;
    if (open) {
      if (r.kind === 'rule' && level > 2) return;
      const d = el.createDiv({ cls: `compress-raw compress-raw-${r.kind}` });
      tasks.push(renderMd(this.app, r.md, d, this.sourcePath || this.file!.path, owner));
      if (r.kind === 'math') {   // a display formula: ask about it, or take its LaTeX
        const tex = r.md.trim().replace(/^\$\$|\$\$$/g, '').trim();
        const bar = d.createDiv({ cls: 'compress-actions' });
        const add = (icon: string, label: string, fn: () => void) => {
          const b = bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
          setIcon(b, icon);
          b.onclick = (e) => { e.stopPropagation(); fn(); };
        };
        add('sigma', '讲解这个公式', () => this.explainFormula(tex, near, true));
        add('copy', '复制 LaTeX', () => void navigator.clipboard.writeText(tex));
      }
      if (this.rawOpen.has(r.id) && level > 2) {
        d.addClass('is-open');
        d.onclick = (e) => {
          if ((e.target as HTMLElement).closest('a, button')) return;
          this.rawOpen.delete(r.id);
          void this.render(this.anchor());
        };
      }
      return;
    }
    if (level >= 4 || r.kind === 'rule' || r.kind === 'footnote') return;
    const chip = el.createDiv({ cls: 'compress-raw-chip' });
    const calloutTitle = r.kind === 'callout' ? /^\s*>\s*\[![^\]]+\][+-]?\s*(.*)$/.exec(r.md.split('\n')[0])?.[1]?.trim() : '';
    chip.setText(`⋯ ${calloutTitle || RAW_NAME[r.kind]}${r.kind === 'code' || r.kind === 'table' ? `（${Math.max(1, r.lines - 2)} 行）` : ''}`);
    chip.onclick = () => {
      this.rawOpen.add(r.id);
      void this.render(this.anchorAt(null, null, chip));
    };
  }

  private renderMap(page: HTMLElement, doc: Doc) {
    const engine = this.plugin.engine;
    const mode = this.translatable() ? this.mode : 'orig';
    const grid = page.createDiv({ cls: 'compress-map' });
    for (const s of doc.sections) {
      if (!s.units.length) {   // a heading over subsections: a label across the map (the note's own title is above)
        if (s.title && !(s.level === 1 && s.title === doc.title)) grid.createDiv({ cls: 'compress-map-group', text: s.title });
        continue;
      }
      const lad = engine.sectionLadder(doc, s);
      const card = grid.createDiv({ cls: 'compress-card', attr: { 'data-depth': String(Math.max(1, s.level)), 'data-sid': s.id } });
      card.createDiv({ cls: 'compress-card-title', text: s.title || '开头' });
      const pick = <T,>(o: T, t: T | undefined) => (mode === 'tr' && t ? t : o);
      if (lad) {
        const l = pick(lad.orig, lad.tr);
        card.createDiv({ cls: 'compress-card-topic', text: l.topic || l.take });
        card.createDiv({ cls: 'compress-card-take', text: l.take });
        if (mode === 'both' && lad.tr) card.createDiv({ cls: 'compress-card-take compress-tr', text: lad.tr.take });
      } else if (s.units.length) {
        const u = s.units[0];
        card.createDiv({ cls: 'compress-card-take', text: u.text.slice(u.sents[0][0], u.sents[0][1]).replace(/[*_`=]/g, '') });
      }
      const topics: string[] = [];
      for (const u of s.units) {
        const ul = engine.unitLadder(doc, u);
        const t = ul ? pick(ul.orig, ul.tr).topic : '';
        if (t && !topics.some((x) => x.toLowerCase() === t.toLowerCase()) && t !== (lad ? pick(lad.orig, lad.tr).topic : '')) topics.push(t);
      }
      if (topics.length) {
        const chips = card.createDiv({ cls: 'compress-card-topics' });
        for (const t of topics.slice(0, 8)) chips.createSpan({ text: t });
      }
      card.onclick = () => {
        this.level = 4;
        this.app.workspace.requestSaveLayout();
        void this.render({ idx: null, sid: s.id, top: 8 });
      };
    }
  }

  private unitActions(ue: HTMLElement, u: Unit) {
    const bar = ue.createDiv({ cls: 'compress-actions' });
    const add = (icon: string, label: string, fn: () => void) => {
      const b = bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.onclick = (e) => { e.stopPropagation(); fn(); };
    };
    if (this.translatable() && this.mode === 'orig') add('languages', this.trOpen.has(u.hash) ? '收起译文' : '看译文', () => this.toggleUnitTr(u));
    add('message-square', '就这段提问', () => { if (this.file) void this.plugin.ask({ file: this.file, focusIdx: u.idx }); });
    if (this.pageOf && this.pdf) {
      const page = this.pageOf(u);
      const pdf = this.pdf;
      add('file-text', `在 PDF 中定位（第 ${page} 页）`, () => void this.plugin.revealPdf(pdf, page));
    } else {
      add('file-text', '在原笔记中定位', () => { if (this.file) void this.plugin.reveal(this.file, u.line); });
    }
  }

  private async toggleUnitTr(u: Unit) {
    if (this.trOpen.has(u.hash)) {
      this.trOpen.delete(u.hash);
      return void this.render(this.anchor());
    }
    this.trOpen.add(u.hash);
    if (!this.plugin.engine.translation(u) && this.file && this.doc) {
      const why = this.plugin.llm.ready();
      if (why) { this.trOpen.delete(u.hash); return void new Notice(why); }
      this.trBusy.add(u.hash);
      void this.render(this.anchor());
      try {
        await this.plugin.engine.translate(this.doc, [u]);
      } catch (e) {
        new Notice(`翻译失败：${(e as Error).message}`);
        this.trOpen.delete(u.hash);
      } finally {
        this.trBusy.delete(u.hash);
      }
    }
    void this.render(this.anchor());
  }

  /** Asks about a formula: its LaTeX as the selection, the paragraph it is in (or follows) as the place. */
  private explainFormula(tex: string, idx: number | undefined, display: boolean) {
    if (!this.file) return;
    void this.plugin.ask({ file: this.file, focusIdx: idx, quote: display ? `$$\n${tex}\n$$` : `$${tex}$`, preset: 'formula' });
  }

  private onUnitClick(e: MouseEvent, u: Unit, ue: HTMLElement) {
    const t = e.target as HTMLElement;
    // a formula inside the paragraph: the bar for it, not the paragraph's opening
    const math = t.closest('.math') as HTMLElement | null;
    const box = math?.closest('.compress-u-text') as HTMLElement | null;
    if (math && box && ue.contains(box)) {
      const k = Array.from(box.querySelectorAll('.math')).indexOf(math);
      const tex = formulasIn(this.mdOf.get(box) ?? '')[k];
      if (tex) {
        e.stopPropagation();
        showSelBar(math.getBoundingClientRect(), [
          { icon: 'sigma', label: '讲解公式', run: () => this.explainFormula(tex, u.idx, false) },
          { icon: 'copy', label: '复制 LaTeX', run: () => void navigator.clipboard.writeText(tex) },
        ], { sticky: true });
        return;
      }
    }
    if (t.closest('a, button, input, .compress-actions, .internal-link, .external-link')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && ue.contains(sel.anchorNode)) return;
    if (this.unitOpen.has(u.hash)) this.unitOpen.delete(u.hash); else this.unitOpen.add(u.hash);
    void this.render(this.anchorAt(u.idx, null, ue));
  }

  private anchorAt(idx: number | null, sid: string | null, el: HTMLElement): Anchor {
    const sec = el.closest('.compress-section') as HTMLElement | null;
    return { idx, sid: sid ?? sec?.dataset.sid ?? null, top: el.getBoundingClientRect().top - this.body.getBoundingClientRect().top };
  }

  /** Shows a paragraph (opening it if this level hides it) and flashes it. */
  async flash(idx: number) {
    if (!this.doc) return;
    const u = this.doc.units[idx - 1];
    if (!u) return;
    if (this.level === 5) this.level = 3;
    if (!this.body.querySelector(`.compress-unit[data-idx="${idx}"]`)) this.unitOpen.add(u.hash);
    await this.render({ idx, sid: u.section, top: 80 });
    const el = this.body.querySelector(`.compress-unit[data-idx="${idx}"]`);
    if (!el) return;
    el.addClass('is-flash');
    window.setTimeout(() => el.removeClass('is-flash'), 1600);
  }

  // ------------------------------------------------------------------------------------------------------------
  // selection: translate it here, or take it to the chat

  private onSelect() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!sel || sel.isCollapsed || !text || !this.body.contains(sel.anchorNode) || !this.file) return hideSelBar();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const host = (sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest('.compress-unit') as HTMLElement | null;
    const idx = host?.dataset.idx ? Number(host.dataset.idx) : undefined;
    const file = this.file;
    const actions = [
      { icon: 'lightbulb', label: '解释', run: () => void this.plugin.ask({ file, focusIdx: idx, quote: text, preset: 'explain' }) },
      { icon: 'message-square', label: '提问', run: () => void this.plugin.ask({ file, focusIdx: idx, quote: text }) },
      { icon: 'copy', label: '复制', run: () => void navigator.clipboard.writeText(text) },
    ];
    if (this.translatable()) actions.unshift({ icon: 'languages', label: '翻译', run: () => this.plugin.translateSelection(text, rect, file, idx) });
    showSelBar(rect, actions);
  }
}
