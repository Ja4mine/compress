// The providers a model can come from, and the plugin's settings. No Obsidian UI here: the model calls use it too.

import type { LangMode } from './core/levels';

export interface Provider {
  id: string;
  name: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;          // a default model, when one name is stable enough to suggest
  keyUrl?: string;
}

// Any OpenAI-compatible endpoint works through "custom"; these only fill in the address.
export const PROVIDERS: Provider[] = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'qwen', name: '通义千问（阿里云百炼）', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'glm', name: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: '', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'kimi', name: 'Kimi（月之暗面）', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: '', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: '', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'anthropic', name: 'Anthropic Claude', protocol: 'anthropic', baseUrl: '', model: 'claude-opus-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'ollama', name: 'Ollama（本地）', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: '' },
  { id: 'custom', name: '自定义（OpenAI 兼容接口）', protocol: 'openai', baseUrl: '', model: '' },
];

export interface Profile {
  baseUrl: string;
  apiKey: string;
  model: string;
  askModel: string;       // a stronger model for questions; "" is the same model
}

export interface CompressSettings {
  provider: string;
  profiles: Record<string, Profile>;
  target: string;          // the reading language translations and written levels are in
  defaultLevel: number;
  langMode: LangMode;
  showRoles: boolean;
  follow: boolean;         // the reader follows the note you open
  autoFold: boolean;       // write a note's levels as soon as the reader opens it
  pdfBar: boolean;         // offer translate / explain / ask over text selected in Obsidian's PDF view
  mineruMode: 'cloud' | 'local';   // how MinerU is reached: its cloud API, or mineru-kit on this computer
  mineruToken: string;
  mineruModel: string;     // the cloud API's model_version: vlm (formulas best) or pipeline
  mineruLang: string;      // the cloud API's OCR language: ch (Chinese and English), en, …
  mineruApi: string;       // the cloud API's address (changed only by the tests)
  mineruCommand: string;   // the local command
  mineruTier: string;      // the local tier: flash, basic, standard, advanced
  concurrency: number;
  askChars: number;        // a note up to this long goes to a question whole
  glossary: string;
  stream: boolean;
  chatFolder: string;
}

export const DEFAULT_SETTINGS: CompressSettings = {
  provider: 'deepseek',
  profiles: {},
  target: 'zh',
  defaultLevel: 1,
  langMode: 'orig',
  showRoles: true,
  follow: true,
  autoFold: false,
  pdfBar: true,
  mineruMode: 'cloud',
  mineruToken: '',
  mineruModel: 'vlm',
  mineruLang: 'ch',
  mineruApi: 'https://mineru.net',
  mineruCommand: 'mineru-kit',
  mineruTier: 'advanced',
  concurrency: 3,
  askChars: 60000,
  glossary: '',
  stream: true,
  chatFolder: 'Compress',
};

export function profileFor(s: CompressSettings, id: string): Profile {
  const preset = PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
  if (!s.profiles[preset.id]) s.profiles[preset.id] = { baseUrl: preset.baseUrl, apiKey: '', model: preset.model, askModel: '' };
  return s.profiles[preset.id];
}
