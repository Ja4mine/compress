// The model call, behind one class, for two protocols:
//   anthropic  the official SDK (@anthropic-ai/sdk), structured output for JSON
//   openai     any OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, Kimi, SiliconFlow, OpenRouter, OpenAI, Ollama):
//              JSON mode where the provider takes it, the schema in the prompt either way
// Streaming uses fetch; where a provider's CORS rules block that inside Obsidian, the call is made again through
// Obsidian's requestUrl (no CORS) and the answer arrives at once.

import Anthropic from '@anthropic-ai/sdk';
import { requestUrl } from 'obsidian';
import { CompressSettings, PROVIDERS, Profile } from '../providers';

export type Task = 'fold' | 'translate' | 'ask' | 'quick';

export interface Msg { role: 'user' | 'assistant'; content: string }

export interface CallOpts {
  task: Task;
  system: string;
  messages: Msg[];
  schema?: Record<string, unknown>;   // a JSON reply is wanted, of this shape
  onText?: (full: string) => void;    // stream the answer as it is written
  signal?: AbortSignal;
  maxTokens?: number;
}

export class LLMError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export class Stopped extends Error {
  constructor() {
    super('已停止');
  }
}

function friendly(status: number, detail: string): string {
  const d = detail.replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403) return `API Key 无效或没有权限（${status}）：${d}`;
  if (status === 404) return `接口地址或模型名不对（404）：${d}`;
  if (status === 429) return `请求太频繁，或账户额度不足（429）：${d}`;
  if (status >= 500) return `模型服务暂时不可用（${status}）：${d}`;
  return `请求失败（${status}）：${d}`;
}

/** A reply's text without a reasoning model's <think> block. */
export function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
}

/** The JSON object in a reply: fences, a preface or trailing commas around it are forgiven. */
export function parseJSON<T>(text: string): T {
  let s = stripThink(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    return JSON.parse(s) as T;
  } catch {
    return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')) as T;
  }
}

// Claude models that take output_config.effort, and those that take server-side fallbacks ("default").
const EFFORT_OK = /^claude-(opus-4-[5-9]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/;
const FALLBACK_OK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const EFFORT: Record<Task, 'low' | 'medium'> = { fold: 'low', translate: 'low', quick: 'low', ask: 'medium' };

const noStream = new Set<string>();   // endpoints whose CORS rules turned a streaming fetch away

export class LLM {
  constructor(private settings: () => CompressSettings) {}

  private profile(): { p: Profile; protocol: 'openai' | 'anthropic'; id: string } {
    const s = this.settings();
    const preset = PROVIDERS.find((x) => x.id === s.provider) ?? PROVIDERS[0];
    const p = s.profiles[preset.id] ?? { baseUrl: preset.baseUrl, apiKey: '', model: preset.model, askModel: '' };
    return { p, protocol: preset.protocol, id: preset.id };
  }

  /** The model a task runs on. */
  model(task: Task): string {
    const { p } = this.profile();
    return (task === 'ask' && p.askModel.trim()) || p.model.trim();
  }

  /** Whether a model is set up at all: a model name, and a key where the provider needs one. */
  ready(): string | null {
    const { p, id } = this.profile();
    if (!p.model.trim()) return '还没有设置模型：设置 › Compress › 模型';
    if (!p.apiKey.trim() && id !== 'ollama' && id !== 'custom') return '还没有填写 API Key：设置 › Compress › 模型';
    return null;
  }

  async text(o: CallOpts): Promise<string> {
    const why = this.ready();
    if (why) throw new LLMError(why);
    const { p, protocol } = this.profile();
    const model = this.model(o.task);
    if (o.signal?.aborted) throw new Stopped();
    try {
      return protocol === 'anthropic' ? await this.anthropic(p, model, o) : await this.openai(p, model, o);
    } catch (e) {
      if (o.signal?.aborted) throw new Stopped();
      throw e;
    }
  }

  async json<T>(o: CallOpts): Promise<T> {
    const first = await this.text(o);
    try {
      return parseJSON<T>(first);
    } catch {
      const again = await this.text({
        ...o,
        messages: [...o.messages, { role: 'assistant', content: first.slice(0, 4000) },
          { role: 'user', content: 'That reply was not valid JSON. Reply again with only the JSON object, complete and valid.' }],
      });
      return parseJSON<T>(again);
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  private async anthropic(p: Profile, model: string, o: CallOpts): Promise<string> {
    const client = new Anthropic({ apiKey: p.apiKey, baseURL: p.baseUrl.trim() || undefined, dangerouslyAllowBrowser: true, maxRetries: 2 });
    const official = !p.baseUrl.trim() || /^https:\/\/api\.anthropic\.com\/?$/.test(p.baseUrl.trim());
    const base: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: o.maxTokens ?? (o.onText ? 32000 : 16000),
      system: o.system,
      messages: o.messages,
      cache_control: { type: 'ephemeral' },
    };
    const config: Anthropic.Beta.BetaOutputConfig = {};
    if (EFFORT_OK.test(model)) config.effort = EFFORT[o.task];
    if (o.schema) config.format = { type: 'json_schema', schema: o.schema };
    if (Object.keys(config).length) base.output_config = config;
    if (official && FALLBACK_OK.has(model)) {
      // a request the model declines for policy reasons is answered by Anthropic's recommended fallback model
      base.betas = ['server-side-fallback-2026-07-01'];
      base.fallbacks = 'default';
    }
    const once = async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
      let msg: Anthropic.Beta.BetaMessage;
      if (o.onText) {
        const stream = client.beta.messages.stream(params, { signal: o.signal });
        let full = '';
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            full += ev.delta.text;
            o.onText(full);
          }
        }
        msg = await stream.finalMessage();
      } else {
        msg = await client.beta.messages.create(params, { signal: o.signal });
      }
      if (msg.stop_reason === 'refusal') throw new LLMError('模型拒绝回答这个请求（refusal）。可以换个问法，或换一个模型。');
      return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    };
    try {
      return await once(base);
    } catch (e) {
      if (o.signal?.aborted) throw new Stopped();
      if (e instanceof Anthropic.BadRequestError && (base.output_config?.effort || base.fallbacks)) {
        // a reasoning level or fallback is a request, never a condition: a model or proxy that refuses one is asked
        // once more without them
        const { fallbacks: _f, betas: _b, ...rest } = base;
        return await once({ ...rest, output_config: o.schema ? { format: { type: 'json_schema', schema: o.schema } } : undefined });
      }
      if (e instanceof Anthropic.APIError && e.status) throw new LLMError(friendly(e.status, e.message), e.status);
      if (e instanceof Anthropic.APIConnectionError) throw new LLMError(`连不上 Anthropic 接口：${e.message}`);
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  private async openai(p: Profile, model: string, o: CallOpts): Promise<string> {
    const base = (p.baseUrl.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = `${base}/chat/completions`;
    const messages = o.messages.map((m) => ({ ...m }));
    if (o.schema) {
      const last = messages[messages.length - 1];
      last.content += `\n\nReply with one JSON object that matches this JSON Schema:\n${JSON.stringify(o.schema)}`;
    }
    const body: Record<string, unknown> = { model, messages: [{ role: 'system', content: o.system }, ...messages] };
    if (o.maxTokens) body.max_tokens = o.maxTokens;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (p.apiKey.trim()) headers.Authorization = `Bearer ${p.apiKey.trim()}`;
    if (base.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://obsidian.md';
      headers['X-Title'] = 'Compress for Obsidian';
    }

    if (o.onText && this.settings().stream && !noStream.has(base)) {
      try {
        return await this.openaiStream(url, headers, body, o);
      } catch (e) {
        if (o.signal?.aborted) throw new Stopped();
        // a CORS refusal (a TypeError, or Ollama's 403 for an origin it does not know): the same call without
        // streaming, through requestUrl, which no CORS rule applies to
        if (!(e instanceof TypeError || (e instanceof LLMError && e.status === 403))) throw e;
        noStream.add(base);
      }
    }
    let json = !!o.schema;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw new Stopped();
      const r = await requestUrl({ url, method: 'POST', headers, body: JSON.stringify(json ? { ...body, response_format: { type: 'json_object' } } : body), throw: false });
      if (r.status === 400 && json) {   // a provider that does not take JSON mode: the schema in the prompt is enough
        json = false;
        continue;
      }
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        const after = Number(r.headers['retry-after'] ?? r.headers['Retry-After']);
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : [4, 12, 30][attempt] * 1000, o.signal);
        continue;
      }
      if (r.status >= 400) throw new LLMError(friendly(r.status, r.text), r.status);
      const data = readJson<{ choices?: { message?: { content?: string } }[] }>(r);
      const text = stripThink(data.choices?.[0]?.message?.content ?? '');
      o.onText?.(text);
      return text;
    }
  }

  private async openaiStream(url: string, headers: Record<string, string>, body: Record<string, unknown>, o: CallOpts): Promise<string> {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }), signal: o.signal });
    if (!res.ok || !res.body) throw new LLMError(friendly(res.status, await res.text().catch(() => '')), res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const d = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (d) {
            full += d;
            o.onText?.(stripThink(full));
          }
        } catch { /* a keep-alive or a partial line */ }
      }
    }
    return stripThink(full);
  }

  // ------------------------------------------------------------------------------------------------------------
  /** The provider's model list, for the settings' picker. */
  async listModels(): Promise<string[]> {
    const { p, protocol } = this.profile();
    if (protocol === 'anthropic') {
      const client = new Anthropic({ apiKey: p.apiKey, baseURL: p.baseUrl.trim() || undefined, dangerouslyAllowBrowser: true });
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids;
    }
    const base = (p.baseUrl.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const r = await requestUrl({ url: `${base}/models`, headers: p.apiKey.trim() ? { Authorization: `Bearer ${p.apiKey.trim()}` } : {}, throw: false });
    if (r.status >= 400) throw new LLMError(friendly(r.status, r.text), r.status);
    const data = readJson<{ data?: { id: string }[] }>(r);
    return (data.data ?? []).map((m) => m.id).sort();
  }
}

/** requestUrl's .json throws on a body that is not JSON: say what came back instead. */
function readJson<T>(r: { json: unknown; text: string }): T {
  try {
    return r.json as T;
  } catch {
    throw new LLMError(`服务商返回的不是 JSON：${r.text.slice(0, 200)}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Stopped());
    }, { once: true });
  });
}
