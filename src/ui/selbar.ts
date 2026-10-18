// The small bar over a selection: translate, explain, ask, copy. Shared by the reader and Obsidian's PDF view.

import { setIcon } from 'obsidian';

let bar: HTMLElement | null = null;
let sticky = false;   // a bar over a formula, not a selection: a selection that collapses does not take it away

export interface SelAction { icon: string; label: string; run: () => void }

export function showSelBar(rect: DOMRect, actions: SelAction[], opts: { sticky?: boolean } = {}): void {
  hideSelBar();
  sticky = !!opts.sticky;
  const el = document.body.createDiv({ cls: 'compress-selbar' });
  bar = el;
  for (const a of actions) {
    const b = el.createEl('button');
    setIcon(b.createSpan(), a.icon);
    b.createSpan({ text: a.label });
    b.onmousedown = (e) => e.preventDefault();   // keep the selection
    b.onclick = () => { hideSelBar(); a.run(); };
  }
  const w = el.offsetWidth || 260;
  el.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
  el.style.top = `${rect.top > 52 ? rect.top - 44 : rect.bottom + 8}px`;
}

export function hideSelBar(): void {
  bar?.remove();
  bar = null;
}

/** Whether a bar over a selection is shown (one that should go when the selection does). */
export function selBarShown(): boolean {
  return !!bar && !sticky;
}
