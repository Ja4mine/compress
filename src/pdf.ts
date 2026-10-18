// A PDF's text, through the PDF.js Obsidian ships with (loadPdfJs): every page's text items with their positions,
// sizes and fonts, for core/pdflayout.ts to put back into headings and paragraphs.

import { App, loadPdfJs, TFile } from 'obsidian';
import { PdfItem, PdfPage } from './core/pdflayout';

interface TextItem { str?: string; transform: number[]; width: number; height: number; fontName: string }

export async function readPdf(app: App, file: TFile): Promise<PdfPage[]> {
  const pdfjs = await loadPdfJs();
  const data = await app.vault.readBinary(file);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  try {
    const pages: PdfPage[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const [vx, vy, vx1, vy1] = page.view as number[];
      const content = await page.getTextContent();
      const items: PdfItem[] = [];
      for (const it of content.items as TextItem[]) {
        if (typeof it.str !== 'string' || !it.str.trim()) continue;
        const [, b, c, d, e, f] = it.transform;
        if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3) continue;   // rotated text: an arXiv stamp in the margin
        items.push({ s: it.str, x: e - vx, y: f - vy, w: it.width, size: Math.abs(d) || it.height, font: it.fontName });
      }
      pages.push({ w: vx1 - vx, h: vy1 - vy, items });
      page.cleanup();
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}
