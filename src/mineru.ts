// MinerU, two ways: its cloud API (mineru.net: a token, no install, the PDF is uploaded) or its command line on this
// computer (mineru-kit, desktop only: nothing leaves the computer, about 3.4 GB of models). Either way the result is a
// note beside the PDF, its pictures in a folder beside the note, its formulas as LaTeX, its pages marked.

import { App, FileSystemAdapter, normalizePath, Platform, requestUrl, TFile } from 'obsidian';
import { unzipSync } from 'fflate';
import { noteFromMinerU } from './core/mineru';
import type { CompressSettings } from './providers';
import { Stopped } from './ai/llm';

export interface MinerUOutput { md?: string; json?: unknown; images: Map<string, Uint8Array> }

type Progress = (done: number, total: number, label?: string) => void;

export class MinerUError extends Error {}

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Stopped()); }, { once: true });
  });
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

/** MinerU's zip: its Markdown (full.md), its JSON (content_list or structured_content) and its pictures, the
 *  pictures by their path relative to the Markdown (or the JSON), as the Markdown refers to them. */
export function unpack(zip: Uint8Array): MinerUOutput {
  const files = unzipSync(zip);
  const names = Object.keys(files).filter((n) => !n.endsWith('/') && !n.includes('__MACOSX'));
  const mdName = names.find((n) => /(^|\/)full\.md$/.test(n)) ?? names.find((n) => n.endsWith('.md'));
  const jsonName = names.find((n) => /content_list\.json$/.test(n)) ?? names.find((n) => /content_list[^/]*\.json$/.test(n))
    ?? names.find((n) => /structured_content\.json$/.test(n));
  const base = dirOf(mdName ?? jsonName ?? '');
  const dec = new TextDecoder();
  const out: MinerUOutput = { images: new Map() };
  if (mdName) out.md = dec.decode(files[mdName]);
  if (jsonName) {
    try {
      out.json = JSON.parse(dec.decode(files[jsonName]));
    } catch { /* pages are lost, the text is not */ }
  }
  for (const n of names) if (IMAGE.test(n)) out.images.set(n.startsWith(base) ? n.slice(base.length) : n, files[n]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// the cloud API (https://mineru.net/apiManage/docs): ask for an upload address, upload, poll, download the zip

interface Reply<T> { code?: number; msg?: string; data?: T }

async function api<T>(url: string, token: string, body?: unknown): Promise<T> {
  const r = await requestUrl({
    url, method: body ? 'POST' : 'GET', throw: false,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j: Reply<T> = {};
  try { j = r.json as Reply<T>; } catch { /* not JSON */ }
  if (r.status === 401 || r.status === 403) throw new MinerUError(`MinerU Token 无效或已过期（${r.status}）：${j.msg ?? r.text.slice(0, 200)}`);
  if (r.status >= 400 || (j.code !== undefined && j.code !== 0)) throw new MinerUError(`MinerU 接口出错（${r.status}${j.code ? ` / ${j.code}` : ''}）：${j.msg ?? r.text.slice(0, 200)}`);
  if (!j.data) throw new MinerUError(`MinerU 接口返回了意外的内容：${r.text.slice(0, 200)}`);
  return j.data;
}

export async function runCloud(app: App, file: TFile, s: CompressSettings, progress: Progress, signal?: AbortSignal): Promise<MinerUOutput> {
  if (!s.mineruToken.trim()) throw new MinerUError('还没有填写 MinerU Token：设置 › Compress › PDF 解析');
  const base = (s.mineruApi || 'https://mineru.net').replace(/\/+$/, '');
  const token = s.mineruToken.trim();
  const data = await app.vault.readBinary(file);
  progress(0, 0, '上传中');
  const batch = await api<{ batch_id: string; file_urls: string[] }>(`${base}/api/v4/file-urls/batch`, token, {
    files: [{ name: file.name, data_id: `compress-${Date.now()}` }],
    model_version: s.mineruModel, enable_formula: true, enable_table: true, language: s.mineruLang,
  });
  const put = batch.file_urls?.[0];
  if (!batch.batch_id || !put) throw new MinerUError('MinerU 没有给出上传地址');
  // the upload address is signed without a Content-Type: none is sent (requestUrl first, fetch if that is refused)
  const up = await requestUrl({ url: put, method: 'PUT', body: data, throw: false });
  if (up.status >= 400) {
    const r = await fetch(put, { method: 'PUT', body: data }).catch(() => null);
    if (!r || !r.ok) throw new MinerUError(`上传 PDF 失败（${up.status}）：${up.text.slice(0, 200)}`);
  }
  const started = Date.now();
  for (;;) {
    await sleep(3000, signal);
    const res = await api<{ extract_result?: { state?: string; err_msg?: string; full_zip_url?: string; extract_progress?: { extracted_pages?: number; total_pages?: number } }[] }>(
      `${base}/api/v4/extract-results/batch/${batch.batch_id}`, token);
    const one = res.extract_result?.[0];
    const state = one?.state ?? 'pending';
    if (state === 'failed') throw new MinerUError(`MinerU 解析失败：${one?.err_msg || '未知原因'}`);
    if (state === 'done' && one?.full_zip_url) {
      progress(1, 1, '下载结果');
      const z = await requestUrl({ url: one.full_zip_url, throw: false });
      if (z.status >= 400) throw new MinerUError(`下载 MinerU 结果失败（${z.status}）`);
      return unpack(new Uint8Array(z.arrayBuffer));
    }
    const p = one?.extract_progress;
    progress(p?.extracted_pages ?? 0, p?.total_pages ?? 0, state === 'running' ? '解析中' : state === 'converting' ? '转换中' : '排队中');
    if (Date.now() - started > 45 * 60 * 1000) throw new MinerUError('MinerU 解析超过 45 分钟仍未完成，请稍后在 mineru.net 查看。');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the command line on this computer (MinerU 4: mineru-kit parse <pdf> -o out.zip --format zip --tier …)

/** Node's modules, in Obsidian's desktop app (the mobile app has none). */
function node<T>(name: string): T {
  const req = (window as unknown as { require?: (n: string) => unknown }).require;
  if (!req) throw new MinerUError('本地 MinerU 只能在桌面版 Obsidian 里使用');
  return req(name) as T;
}

export async function runLocal(app: App, file: TFile, s: CompressSettings, progress: Progress, signal?: AbortSignal): Promise<MinerUOutput> {
  if (!Platform.isDesktopApp) throw new MinerUError('本地 MinerU 只能在桌面版 Obsidian 里使用');
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) throw new MinerUError('无法得到 PDF 在磁盘上的路径');
  const pdf = adapter.getFullPath(file.path);
  return runCommand(s.mineruCommand || 'mineru-kit', pdf, s.mineruTier, progress, signal);
}

/** Runs mineru-kit on a PDF and reads its zip. Exported for the tests, which run a stand-in command. */
export async function runCommand(command: string, pdf: string, tier: string, progress: Progress, signal?: AbortSignal): Promise<MinerUOutput> {
  const os = node<typeof import('os')>('os');
  const path = node<typeof import('path')>('path');
  const fs = node<typeof import('fs')>('fs');
  const cp = node<typeof import('child_process')>('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-mineru-'));
  const zip = path.join(dir, 'result.zip');
  const args = ['parse', pdf, '-o', zip, '--format', 'zip', '--tier', tier];
  if (tier === 'advanced') args.push('--disable-image-analysis');   // (on, it turns charts into tables of data)
  // an app started from the Dock does not have the shell's PATH: the usual places for a Python tool are added
  const home = os.homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.pyenv/shims`, `${home}/.cargo/bin`, `${home}/miniconda3/bin`, `${home}/anaconda3/bin`];
  const env = { ...process.env, PATH: [process.env.PATH ?? '', ...extra].filter(Boolean).join(path.delimiter) };
  const tail: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = cp.spawn(command, args, { env });
      const onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      const read = (chunk: Buffer) => {
        for (const line of chunk.toString().split(/[\r\n]+/)) {
          if (!line.trim()) continue;
          tail.push(line);
          if (tail.length > 20) tail.shift();
          const m = /\|\s*(\d+)\/(\d+)/.exec(line);   // a progress bar: " 45%|████   | 9/20"
          if (m && Number(m[2])) progress(Number(m[1]), Number(m[2]), '本地解析中');
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT'
        ? new MinerUError(`找不到命令“${command}”。请在设置里填写 mineru-kit 的完整路径（在终端运行 which mineru-kit 查看）。`)
        : e));
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return reject(new Stopped());
        // it may fail on its way out with its work written (TextFold saw this): a zip is kept when there is one
        if (code === 0 || fs.existsSync(zip)) resolve();
        else reject(new MinerUError(`MinerU 退出（代码 ${code}）：\n${tail.slice(-6).join('\n')}`));
      });
    });
    if (!fs.existsSync(zip)) throw new MinerUError('MinerU 没有写出结果文件');
    return unpack(new Uint8Array(fs.readFileSync(zip)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the note

/** Writes MinerU's output as a note beside the PDF (replacing an earlier MinerU note of it) and its pictures in
 *  "<name>.assets/" beside the note. */
export async function saveNote(app: App, pdf: TFile, out: MinerUOutput, existing: TFile | null): Promise<TFile> {
  const dir = pdf.parent && pdf.parent.path !== '/' ? `${pdf.parent.path}/` : '';
  const assets = normalizePath(`${dir}${pdf.basename}.assets`);
  const wanted = new Map<string, string>();   // a picture's path in the output → its path in the vault
  const link = (p: string) => {
    const key = p.replace(/^\.?\//, '');
    if (!out.images.has(key)) return `*（图片缺失：${key}）*`;
    let to = wanted.get(key);
    if (!to) {
      to = normalizePath(`${assets}/${key.replace(/[\\/]/g, '_')}`);
      wanted.set(key, to);
    }
    return `![[${to}]]`;
  };
  const body = noteFromMinerU(out, link);
  if (wanted.size && !app.vault.getAbstractFileByPath(assets)) await app.vault.createFolder(assets);
  for (const [key, to] of wanted) {
    const data = out.images.get(key)!;
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const f = app.vault.getAbstractFileByPath(to);
    if (f instanceof TFile) await app.vault.modifyBinary(f, buf);
    else await app.vault.createBinary(to, buf);
  }
  const text = `---\ncompress-source: "[[${pdf.path}]]"\ncompress-parser: mineru\n---\n\n${body}`;
  if (existing) {
    await app.vault.modify(existing, text);
    return existing;
  }
  let path = normalizePath(`${dir}${pdf.basename}.md`);
  for (let n = 1; app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${dir}${pdf.basename}（MinerU${n > 1 ? n : ''}）.md`);
  return app.vault.create(path, text);
}
