import type { TFile } from 'obsidian';

/** The files the reader can read: Markdown notes and PDFs. */
export const readable = (f: TFile | null | undefined): f is TFile => !!f && (f.extension === 'md' || f.extension === 'pdf');
