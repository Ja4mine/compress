// A small floating card next to a selection: a translation as it streams in, with a way on to the chat.

import { App, Component, setIcon } from 'obsidian';
import { coalesce, handleLinks, renderMd } from './markdown';

let current: Popover | null = null;

export class Popover extends Component {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private actions: HTMLElement;
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };
  private onDown = (e: MouseEvent) => { if (!this.el.contains(e.target as Node)) this.close(); };
  readonly abort = new AbortController();
  private show = coalesce((md: string) => renderMd(this.app, md, this.body, this.sourcePath, this));

  constructor(private app: App, rect: DOMRect, title: string, private sourcePath: string) {
    super();
    current?.close();
    current = this;
    this.el = document.body.createDiv({ cls: 'compress-popover' });
    const head = this.el.createDiv({ cls: 'compress-popover-head' });
    head.createSpan({ text: title });
    const x = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '关闭' } });
    setIcon(x, 'x');
    x.onclick = () => this.close();
    this.body = this.el.createDiv({ cls: 'compress-popover-body' });
    this.body.createDiv({ cls: 'compress-thinking', text: '翻译中…' });
    this.actions = this.el.createDiv({ cls: 'compress-popover-actions' });
    handleLinks(app, this.body, () => sourcePath, this);
    this.place(rect);
    this.load();
    window.setTimeout(() => {
      document.addEventListener('keydown', this.onKey);
      document.addEventListener('mousedown', this.onDown, true);
    }, 0);
  }

  private place(rect: DOMRect) {
    const w = Math.min(460, window.innerWidth - 24);
    this.el.style.width = `${w}px`;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - w - 12));
    const below = rect.bottom + 8;
    const roomBelow = window.innerHeight - below;
    this.el.style.left = `${left}px`;
    if (roomBelow > 220 || roomBelow > rect.top) {
      this.el.style.top = `${below}px`;
      this.el.style.maxHeight = `${Math.max(160, roomBelow - 16)}px`;
    } else {
      this.el.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      this.el.style.maxHeight = `${Math.max(160, rect.top - 24)}px`;
    }
  }

  setMarkdown(md: string) { this.show(md); }

  setError(msg: string) {
    this.body.empty();
    this.body.createDiv({ cls: 'compress-error', text: msg });
  }

  addAction(label: string, icon: string, fn: () => void) {
    const b = this.actions.createEl('button', { cls: 'compress-chip' });
    setIcon(b.createSpan(), icon);
    b.createSpan({ text: label });
    b.onclick = () => fn();
  }

  close() {
    this.abort.abort();
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('mousedown', this.onDown, true);
    this.el.remove();
    this.unload();
    if (current === this) current = null;
  }
}

export function closePopover() { current?.close(); }
