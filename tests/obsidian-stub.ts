// The few Obsidian names the model and MinerU layers reach for, outside Obsidian: requestUrl on top of fetch.
export async function requestUrl(o: { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer }) {
  const r = await fetch(o.url, { method: o.method ?? 'GET', headers: o.headers, body: o.body });
  const buf = await r.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json, arrayBuffer: buf, headers: Object.fromEntries(r.headers.entries()) };
}
export const Platform = { isDesktopApp: true };
export class FileSystemAdapter {}
export class TFile {}
export const normalizePath = (p: string) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
