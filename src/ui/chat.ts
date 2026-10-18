// The chat beside the reader: questions about a selection, a paragraph or the whole note, answered from the note
// with its paragraphs cited ([P12] → a link back to ¶12), and follow-ups in the same conversation.

import { Component, ItemView, Notice, normalizePath, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import type CompressPlugin from '../main';
import { sentencesOf } from '../core/parse';
import { askSystem, askTurn, docBlock, LANGS } from '../ai/prompts';
import { Stopped } from '../ai/llm';
import { coalesce, handleLinks, linkCitations, renderMd } from './markdown';

export const CHAT = 'compress-chat';

export type PresetId = 'formula' | 'explain' | 'translate' | 'simplify' | 'example' | 'role' | 'gist' | 'structure' | 'next';

interface Preset { label: string; icon: string; q: (what: string, lang: string) => string; scope: 'part' | 'whole' | 'formula' }

export const PRESETS: Record<PresetId, Preset> = {
  formula: { label: '讲解公式', icon: 'sigma', scope: 'formula', q: () => '请讲解这个公式：逐个说明每个符号代表什么（尽量用文中的定义，并注明出处段落），整个式子在计算什么、直观含义是什么、在文中起什么作用；如果它依赖某些假设或由前面的式子推出，也简要说明。' },
  explain: { label: '解释', icon: 'lightbulb', scope: 'part', q: (w) => `请解释${w}：它是什么意思？在这里起什么作用？涉及的专业概念请用通俗的话说明。` },
  translate: { label: '翻译并讲解', icon: 'languages', scope: 'part', q: (w, l) => `请把${w}翻译成${l}，再解释其中不好懂的术语或表达。` },
  simplify: { label: '说简单点', icon: 'feather', scope: 'part', q: (w) => `请用更简单的话把${w}重新讲一遍，像讲给刚入门的人听。` },
  example: { label: '举个例子', icon: 'list', scope: 'part', q: (w) => `请举一个具体的例子，帮我理解${w}。` },
  role: { label: '在文中的作用', icon: 'git-branch', scope: 'part', q: (w) => `${w}在全文的论证里起什么作用？和前后文是什么关系？` },
  gist: { label: '核心观点', icon: 'target', scope: 'whole', q: () => '这篇文章的核心观点和主要贡献是什么？' },
  structure: { label: '论证结构', icon: 'git-branch', scope: 'whole', q: () => '这篇文章的论证结构是怎样的？每一部分起什么作用？' },
  next: { label: '值得追问', icon: 'help-circle', scope: 'whole', q: () => '读这篇文章时，最值得追问的三个问题是什么？请说明理由。' },
};

export interface AskOpts { file: TFile; focusIdx?: number; quote?: string; preset?: PresetId; question?: string }

interface Turn { q: string; quote?: string; idx?: number; sent: string; a: string; model: string; error?: string }

interface Conv { path: string; title: string; system: string | null; whole: boolean; turns: Turn[] }

export class ChatView extends ItemView {
  private conv: Conv | null = null;
  private pending: { idx?: number; quote?: string } = {};
  private busy: AbortController | null = null;
  private log!: HTMLElement;
  private head!: HTMLElement;
  private ctx!: HTMLElement;
  private presets!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private owners: Component[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: CompressPlugin) {
    super(leaf);
  }

  getViewType() { return CHAT; }
  getIcon() { return 'message-square'; }
  getDisplayText() { return 'Compress 问答'; }

  async onOpen() {
    const root = this.contentEl;
    root.addClass('compress-chat');
    this.head = root.createDiv({ cls: 'compress-chat-head' });
    this.log = root.createDiv({ cls: 'compress-chat-log' });
    handleLinks(this.app, this.log, () => this.conv?.path ?? '', this);
    const foot = root.createDiv({ cls: 'compress-chat-foot' });
    this.ctx = foot.createDiv({ cls: 'compress-chat-ctx' });
    this.presets = foot.createDiv({ cls: 'compress-chat-presets' });
    const row = foot.createDiv({ cls: 'compress-chat-input' });
    this.input = row.createEl('textarea', { attr: { rows: '2', placeholder: '问点什么…（Enter 发送，Shift+Enter 换行）' } });
    this.sendBtn = row.createEl('button', { cls: 'mod-cta' });
    this.sendBtn.onclick = () => (this.busy ? this.busy.abort() : void this.send(this.input.value));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.busy) void this.send(this.input.value);
      }
    });
    this.draw();
  }

  async onClose() {
    this.busy?.abort();
    for (const o of this.owners) o.unload();
  }

  /** Sets the conversation's note and what the next question is about; asks at once when a question is given. */
  async prepare(o: AskOpts) {
    if (!this.conv || this.conv.path !== o.file.path) this.reset(o.file);
    this.pending = { idx: o.focusIdx, quote: o.quote?.trim() || undefined };
    this.draw();
    const q = o.question ?? (o.preset ? this.presetQuestion(o.preset) : '');
    if (q) await this.send(q);
    else window.setTimeout(() => this.input.focus(), 50);
  }

  private reset(file: TFile) {
    this.busy?.abort();
    for (const o of this.owners) o.unload();
    this.owners = [];
    this.conv = { path: file.path, title: file.basename, system: null, whole: false, turns: [] };
    this.pending = {};
  }

  private presetQuestion(id: PresetId): string {
    const what = this.pending.quote ? '选中的内容' : this.pending.idx ? `第 ${this.pending.idx} 段` : '这篇文章';
    return PRESETS[id].q(what, LANGS[this.plugin.settings.target]?.native ?? '中文');
  }

  // ------------------------------------------------------------------------------------------------------------
  private draw() {
    this.drawHead();
    this.drawContext();
    this.drawLog();
    this.sendBtn.empty();
    setIcon(this.sendBtn, this.busy ? 'square' : 'send');
    this.sendBtn.setAttr('aria-label', this.busy ? '停止' : '发送');
  }

  private drawHead() {
    const h = this.head;
    h.empty();
    const title = h.createDiv({ cls: 'compress-chat-title' });
    title.setText(this.conv ? this.conv.title : 'Compress 问答');
    if (this.conv) {
      title.addClass('is-link');
      title.setAttr('aria-label', '分层阅读这篇笔记');
      title.onclick = () => { const f = this.file(); if (f) void this.plugin.openReader(f); };
    }
    const btn = (icon: string, label: string, fn: () => void) => {
      const b = h.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.onclick = fn;
    };
    btn('save', '保存为笔记', () => void this.save());
    btn('plus', '新对话', () => {
      const f = this.file() ?? this.plugin.activeNote();
      if (f) this.reset(f); else this.conv = null;
      this.draw();
    });
  }

  private drawContext() {
    this.ctx.empty();
    this.presets.empty();
    if (!this.conv) return;
    const { idx, quote } = this.pending;
    if (idx) {
      const c = this.ctx.createDiv({ cls: 'compress-ctx-chip' });
      c.createSpan({ text: `¶${idx}` });
      c.setAttr('aria-label', '下一个问题针对这一段');
      c.onclick = () => this.plugin.revealUnit(this.conv!.path, idx);
    }
    if (quote) {
      const c = this.ctx.createDiv({ cls: 'compress-ctx-chip compress-ctx-quote' });
      const flat = quote.replace(/\s+/g, ' ');
      c.createSpan({ text: /^\$/.test(quote) ? `公式 ${flat.length > 80 ? flat.slice(0, 80) + '…' : flat}` : `“${flat.length > 80 ? flat.slice(0, 80) + '…' : flat}”` });
    }
    if (idx || quote) {
      const x = this.ctx.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '改为针对全文' } });
      setIcon(x, 'x');
      x.onclick = () => { this.pending = {}; this.drawContext(); };
    }
    const scope = idx || quote ? 'part' : 'whole';
    const isFormula = !!quote && /^\$/.test(quote);
    for (const [id, p] of Object.entries(PRESETS) as [PresetId, Preset][]) {
      if (p.scope !== scope && !(p.scope === 'formula' && isFormula)) continue;
      if (id === 'translate' && !quote && !idx) continue;
      const b = this.presets.createEl('button', { cls: 'compress-chip' });
      setIcon(b.createSpan(), p.icon);
      b.createSpan({ text: p.label });
      b.onclick = () => { if (!this.busy) void this.send(this.presetQuestion(id)); };
    }
  }

  private drawLog() {
    for (const o of this.owners) o.unload();
    this.owners = [];
    this.log.empty();
    if (!this.conv || !this.conv.turns.length) {
      const e = this.log.createDiv({ cls: 'compress-chat-empty' });
      e.createEl('p', { text: '在阅读器里选中文字，点“解释”或“提问”；也可以点段落右侧的对话图标，就那一段提问。' });
      e.createEl('p', { text: '回答里的 ¶12 这样的标记指向原文段落，点一下就跳过去。' });
      return;
    }
    for (const t of this.conv.turns) this.drawTurn(t);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private drawTurn(t: Turn): (a: string) => void {
    const box = this.log.createDiv({ cls: 'compress-turn' });
    const q = box.createDiv({ cls: 'compress-q' });
    if (t.idx || t.quote) {
      const ref = q.createDiv({ cls: 'compress-q-ref' });
      if (t.idx) {
        const a = ref.createEl('a', { cls: 'compress-cite', text: `¶${t.idx}` });
        a.onclick = () => this.plugin.revealUnit(this.conv!.path, t.idx!);
      }
      if (t.quote && /^\$/.test(t.quote)) {
        const m = ref.createDiv({ cls: 'compress-q-math' });
        const own = new Component();
        own.load();
        this.owners.push(own);
        void renderMd(this.app, t.quote, m, this.conv!.path, own);
      } else if (t.quote) {
        ref.createSpan({ text: `“${t.quote.length > 120 ? t.quote.slice(0, 120) + '…' : t.quote}”` });
      }
    }
    q.createDiv({ text: t.q });
    const a = box.createDiv({ cls: 'compress-a' });
    const tools = box.createDiv({ cls: 'compress-a-tools' });
    const owner = new Component();
    owner.load();
    this.owners.push(owner);
    const path = this.conv!.path;
    const paint = async (md: string) => {
      if (t.error) {
        a.empty();
        a.createDiv({ cls: 'compress-error', text: t.error });
        return;
      }
      if (!md) {
        a.empty();
        a.createDiv({ cls: 'compress-thinking', text: '思考中…' });
        return;
      }
      await renderMd(this.app, md, a, path, owner);
      linkCitations(a, (idx) => this.plugin.revealUnit(path, idx));
      if (this.busy) this.log.scrollTop = this.log.scrollHeight;
    };
    const draw = coalesce(paint);
    draw(t.a);
    if (t.a && !t.error) {
      const copy = tools.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '复制回答' } });
      setIcon(copy, 'copy');
      copy.onclick = () => void navigator.clipboard.writeText(t.a.replace(/\[P(\d+)\]/g, '¶$1'));
      tools.createSpan({ cls: 'compress-muted', text: t.model });
    }
    return draw;
  }

  // ------------------------------------------------------------------------------------------------------------
  private file(): TFile | null {
    const f = this.conv ? this.app.vault.getAbstractFileByPath(this.conv.path) : null;
    return f instanceof TFile ? f : null;
  }

  async send(raw: string) {
    const question = raw.trim();
    if (!question || this.busy) return;
    if (!this.conv) {
      const f = this.plugin.activeNote();
      if (!f) return void new Notice('先打开一篇笔记。');
      this.reset(f);
    }
    const why = this.plugin.llm.ready();
    if (why) return void new Notice(why);
    const conv = this.conv!;
    const file = this.file();
    if (!file) return void new Notice('找不到这篇笔记了。');

    const ctrl = new AbortController();
    this.busy = ctrl;   // (set before the reads below, so a second Enter meanwhile is not a second question)
    let turn: Turn | null = null;
    try {
      const { doc } = await this.plugin.loadDoc(file);
      const { idx, quote } = this.pending;
      const focus = idx ? doc.units[idx - 1] ?? null : null;
      if (!conv.system) {
        const engine = this.plugin.engine;
        const line = (s: (typeof doc.sections)[number]) => engine.sectionLadder(doc, s)?.orig.take ?? (s.units[0] ? sentencesOf(s.units[0], [0]).slice(0, 160) : '');
        const block = docBlock(doc, this.plugin.settings.askChars, line, focus, `${question} ${quote ?? ''}`);
        conv.system = askSystem(this.plugin.settings.target, block.text);
        conv.whole = block.whole;
      }
      const sent = askTurn(doc, focus, quote ?? '', question, conv.whole);
      const history = conv.turns.filter((t) => t.a && !t.error).flatMap((t) => [
        { role: 'user' as const, content: t.sent }, { role: 'assistant' as const, content: t.a }]);
      const t: Turn = { q: question, quote, idx, sent, a: '', model: this.plugin.llm.model('ask') };
      turn = t;
      conv.turns.push(t);
      this.pending = {};
      this.input.value = '';
      this.draw();
      const update = this.drawTurnUpdate(t);
      t.a = await this.plugin.llm.text({
        task: 'ask', system: conv.system, messages: [...history, { role: 'user', content: sent }], signal: ctrl.signal,
        onText: (full) => { t.a = full; update(full); },
      });
    } catch (e) {
      const stopped = e instanceof Stopped || ctrl.signal.aborted;
      if (!turn) {
        if (!stopped) new Notice(`提问失败：${(e as Error).message}`);
      } else if (stopped) {
        if (!turn.a) turn.error = '已停止。';
      } else {
        turn.error = (e as Error).message;
      }
    } finally {
      this.busy = null;
      if (this.conv === conv) this.draw();
    }
  }

  /** The last turn's painter (the log was just drawn with the new turn last). */
  private drawTurnUpdate(t: Turn): (md: string) => void {
    this.log.lastElementChild?.remove();
    this.owners.pop()?.unload();
    return this.drawTurn(t);
  }

  private async save() {
    const conv = this.conv;
    if (!conv || !conv.turns.some((t) => t.a)) return void new Notice('还没有可以保存的问答。');
    const folder = normalizePath(this.plugin.settings.chatFolder || 'Compress');
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const safe = conv.title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim().slice(0, 60);
    let path = normalizePath(`${folder}/问答 ${safe} ${stamp}.md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${folder}/问答 ${safe} ${stamp} ${n}.md`);
    const link = this.app.fileManager.generateMarkdownLink(this.file() ?? ({ path: conv.path, basename: conv.title } as TFile), path);
    const body = conv.turns.filter((t) => t.a).map((t) => {
      const ref = [t.idx ? `¶${t.idx}` : '', t.quote ? `“${t.quote.replace(/\n+/g, ' ')}”` : ''].filter(Boolean).join(' ');
      return `> [!question] ${t.q}${ref ? `\n> ${ref}` : ''}\n\n${t.a.replace(/\[P(\d+)\]/g, '¶$1')}\n\n<small>${t.model}</small>`;
    }).join('\n\n---\n\n');
    const f = await this.app.vault.create(path, `来源：${link}\n\n${body}\n`);
    new Notice(`已保存：${f.path}`);
    await this.app.workspace.getLeaf('tab').openFile(f);
  }
}
