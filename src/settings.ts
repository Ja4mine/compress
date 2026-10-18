import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type CompressPlugin from './main';
import type { LangMode } from './core/levels';
import { PROVIDERS, profileFor } from './providers';
import { LANGS } from './ai/prompts';

export class CompressSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CompressPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl).setName('模型').setHeading();
    const preset = PROVIDERS.find((p) => p.id === s.provider) ?? PROVIDERS[0];
    const prof = profileFor(s, preset.id);

    new Setting(containerEl)
      .setName('服务商')
      .setDesc('生成层级、翻译和回答问题用的模型。每个服务商的 Key 和模型分开保存。')
      .addDropdown((d) => {
        for (const p of PROVIDERS) d.addOption(p.id, p.name);
        d.setValue(preset.id).onChange(async (v) => {
          s.provider = v;
          profileFor(s, v);
          await save();
          this.display();
        });
      });

    const keyDesc = document.createDocumentFragment();
    keyDesc.append('保存在本库的 .obsidian/plugins/compress/data.json 里（明文）。');
    if (preset.keyUrl) {
      keyDesc.append(' ');
      keyDesc.createEl('a', { text: '获取 Key', href: preset.keyUrl });
    }
    new Setting(containerEl)
      .setName('API Key')
      .setDesc(keyDesc)
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder(preset.id === 'ollama' ? '本地模型不需要' : 'sk-…').setValue(prof.apiKey).onChange(async (v) => {
          prof.apiKey = v.trim();
          await save();
        });
      });

    new Setting(containerEl)
      .setName('接口地址')
      .setDesc(preset.protocol === 'anthropic' ? '留空即官方地址；用代理时填代理地址。' : 'OpenAI 兼容接口的地址，一般以 /v1 结尾。')
      .addText((t) => t.setPlaceholder(preset.baseUrl || 'https://…/v1').setValue(prof.baseUrl).onChange(async (v) => {
        prof.baseUrl = v.trim();
        await save();
      }));

    let modelText: { setValue(v: string): unknown } | null = null;
    new Setting(containerEl)
      .setName('模型')
      .setDesc('生成层级和翻译用的模型。点右边的按钮可以从服务商取回模型列表。')
      .addText((t) => {
        modelText = t;
        t.setPlaceholder(preset.model || '模型名').setValue(prof.model).onChange(async (v) => {
          prof.model = v.trim();
          await save();
        });
      })
      .addButton((b) => b.setButtonText('获取列表').onClick(async () => {
        try {
          const ids = await this.plugin.llm.listModels();
          if (!ids.length) return new Notice('服务商没有返回模型列表，请手动填写。');
          new ModelPicker(this.app, ids, (id) => {
            prof.model = id;
            modelText?.setValue(id);
            void save();
          }).open();
        } catch (e) {
          new Notice(`取不到模型列表：${(e as Error).message}`);
        }
      }));

    new Setting(containerEl)
      .setName('问答模型')
      .setDesc('回答问题时可以用更强的模型。留空即与上面相同。')
      .addText((t) => t.setPlaceholder('与上面相同').setValue(prof.askModel).onChange(async (v) => {
        prof.askModel = v.trim();
        await save();
      }));

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('用当前设置发一个很短的请求。')
      .addButton((b) => b.setButtonText('测试').onClick(async () => {
        b.setDisabled(true);
        try {
          const t0 = Date.now();
          const out = await this.plugin.llm.text({ task: 'quick', system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Ping' }], maxTokens: 2000 });
          new Notice(`连接成功（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${out.slice(0, 40)}`);
        } catch (e) {
          new Notice(`连接失败：${(e as Error).message}`, 10000);
        } finally {
          b.setDisabled(false);
        }
      }));

    new Setting(containerEl).setName('阅读').setHeading();

    new Setting(containerEl)
      .setName('阅读语言')
      .setDesc('翻译的目标语言，也是 AI 撰写层级时附带的第二种语言。')
      .addDropdown((d) => {
        for (const [code, l] of Object.entries(LANGS)) d.addOption(code, l.native);
        d.setValue(s.target).onChange(async (v) => {
          s.target = v;
          await save();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName('默认层级')
      .setDesc('打开阅读器时的层级。')
      .addDropdown((d) => {
        for (const [n, name] of [[1, '1 全文'], [2, '2 摘句'], [3, '3 精要'], [4, '4 要点'], [5, '5 主题']] as const) d.addOption(String(n), name);
        d.setValue(String(s.defaultLevel)).onChange(async (v) => {
          s.defaultLevel = Number(v);
          await save();
        });
      });

    new Setting(containerEl)
      .setName('默认显示')
      .addDropdown((d) => d.addOptions({ orig: '原文', both: '对照', tr: '译文' }).setValue(s.langMode).onChange(async (v) => {
        s.langMode = v as LangMode;
        await save();
      }));

    new Setting(containerEl)
      .setName('显示段落角色')
      .setDesc('在精要和要点层，标出每段在论证中的角色（背景、方法、结果……）。')
      .addToggle((t) => t.setValue(s.showRoles).onChange(async (v) => {
        s.showRoles = v;
        await save();
        this.plugin.refreshViews();
      }));

    new Setting(containerEl)
      .setName('打开时自动生成层级')
      .setDesc('阅读器打开一篇还没有层级的笔记时，直接调用模型生成。关闭时需要手动点“AI 生成层级”。')
      .addToggle((t) => t.setValue(s.autoFold).onChange(async (v) => {
        s.autoFold = v;
        await save();
      }));

    new Setting(containerEl)
      .setName('PDF 中选中文字时显示工具条')
      .setDesc('在 Obsidian 自带的 PDF 视图里选中文字，旁边出现“翻译 / 解释 / 提问”。')
      .addToggle((t) => t.setValue(s.pdfBar).onChange(async (v) => {
        s.pdfBar = v;
        await save();
      }));

    new Setting(containerEl)
      .setName('跟随当前笔记')
      .setDesc('切换笔记时，阅读器跟着显示新的笔记。')
      .addToggle((t) => t.setValue(s.follow).onChange(async (v) => {
        s.follow = v;
        await save();
      }));

    new Setting(containerEl)
      .setName('术语表')
      .setDesc('翻译时固定使用的译法，每行一条，例如：attention = 注意力')
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.setPlaceholder('attention = 注意力\ninductive bias = 归纳偏置').setValue(s.glossary).onChange(async (v) => {
          s.glossary = v;
          await save();
        });
      });

    new Setting(containerEl).setName('PDF 解析（MinerU）').setHeading();
    const intro = document.createDocumentFragment();
    intro.append('内置的 PDF.js 提取很快，但公式会变成零散符号。MinerU 能把公式识别成 LaTeX、表格识别成表格，AI 才能讲解公式。');
    intro.createEl('br');
    intro.append('在 PDF 上右键 › Compress：用 MinerU 解析，结果存成 PDF 旁边的一篇笔记；之后用阅读器打开这个 PDF 会自动读这篇笔记。');
    new Setting(containerEl).setDesc(intro);

    new Setting(containerEl)
      .setName('解析方式')
      .addDropdown((d) => d.addOptions({ cloud: 'MinerU 云端 API（推荐：免安装）', local: '本机的 mineru-kit（需自行安装）' })
        .setValue(s.mineruMode).onChange(async (v) => {
          s.mineruMode = v as 'cloud' | 'local';
          await save();
          this.display();
        }));

    if (s.mineruMode === 'cloud') {
      const tokenDesc = document.createDocumentFragment();
      tokenDesc.append('在 mineru.net 登录后，在“API 管理”里创建 Token。PDF 会上传到 MinerU 的服务器解析；每个账号每天有 2000 页的高优先级额度。');
      tokenDesc.createEl('br');
      tokenDesc.createEl('a', { text: '接口说明', href: 'https://mineru.net/apiManage/docs' });
      new Setting(containerEl)
        .setName('MinerU Token')
        .setDesc(tokenDesc)
        .addText((t) => {
          t.inputEl.type = 'password';
          t.setPlaceholder('eyJ…').setValue(s.mineruToken).onChange(async (v) => {
            s.mineruToken = v.trim();
            await save();
          });
        });
      new Setting(containerEl)
        .setName('模型')
        .setDesc('vlm 对公式和复杂版面更准；pipeline 是传统流水线。')
        .addDropdown((d) => d.addOptions({ vlm: 'vlm（推荐）', pipeline: 'pipeline' }).setValue(s.mineruModel).onChange(async (v) => {
          s.mineruModel = v;
          await save();
        }));
      new Setting(containerEl)
        .setName('文字语言')
        .setDesc('扫描件做 OCR 时用的语言。')
        .addDropdown((d) => d.addOptions({ ch: '中文与英文', en: '英文', japan: '日文', korean: '韩文', latin: '拉丁字母语言' })
          .setValue(s.mineruLang).onChange(async (v) => {
            s.mineruLang = v;
            await save();
          }));
    } else {
      const cmdDesc = document.createDocumentFragment();
      cmdDesc.append('安装：uv pip install -U "mineru>=4.0,<5"（需要 Python 3.10–3.14，首次解析会下载约 3.4 GB 模型）。从程序坞启动的 Obsidian 可能找不到命令，这时填完整路径（终端里运行 which mineru-kit 查看）。');
      new Setting(containerEl)
        .setName('mineru-kit 命令')
        .setDesc(cmdDesc)
        .addText((t) => t.setPlaceholder('mineru-kit').setValue(s.mineruCommand).onChange(async (v) => {
          s.mineruCommand = v.trim() || 'mineru-kit';
          await save();
        }));
      new Setting(containerEl)
        .setName('解析档位')
        .setDesc('advanced 把公式识别成 LaTeX，最慢；flash 最快，但公式是图片。')
        .addDropdown((d) => d.addOptions({ advanced: 'advanced（公式为 LaTeX）', standard: 'standard', basic: 'basic', flash: 'flash（最快，公式为图片）' })
          .setValue(s.mineruTier).onChange(async (v) => {
            s.mineruTier = v;
            await save();
          }));
    }

    new Setting(containerEl).setName('高级').setHeading();

    new Setting(containerEl)
      .setName('并发请求数')
      .setDesc('生成层级和翻译全文时，同时发出的请求数。免费额度容易限流时调小。')
      .addSlider((sl) => sl.setLimits(1, 8, 1).setValue(s.concurrency).setDynamicTooltip().onChange(async (v) => {
        s.concurrency = v;
        await save();
      }));

    new Setting(containerEl)
      .setName('问答时整篇发送的上限（字符）')
      .setDesc('不超过这个长度的笔记，提问时整篇交给模型；更长的只发章节地图和相关段落。')
      .addText((t) => t.setValue(String(s.askChars)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 2000) {
          s.askChars = n;
          await save();
        }
      }));

    new Setting(containerEl)
      .setName('流式输出')
      .setDesc('回答边写边显示。个别服务商在 Obsidian 里不允许跨域流式请求，插件会自动改为一次性返回。')
      .addToggle((t) => t.setValue(s.stream).onChange(async (v) => {
        s.stream = v;
        await save();
      }));

    new Setting(containerEl)
      .setName('对话保存位置')
      .setDesc('“保存为笔记”时放到这个文件夹。')
      .addText((t) => t.setValue(s.chatFolder).onChange(async (v) => {
        s.chatFolder = v.trim() || 'Compress';
        await save();
      }));

    new Setting(containerEl)
      .setName('清除缓存')
      .setDesc('删除已生成的层级和译文。之后打开笔记要重新生成。')
      .addButton((b) => b.setButtonText('清除').setWarning().onClick(async () => {
        await this.plugin.store.clear();
        this.plugin.refreshViews();
        new Notice('已清除 Compress 的缓存。');
      }));
  }
}


class ModelPicker extends FuzzySuggestModal<string> {
  constructor(app: App, private ids: string[], private pick: (id: string) => void) {
    super(app);
    this.setPlaceholder('选择模型');
  }
  getItems() { return this.ids; }
  getItemText(id: string) { return id; }
  onChooseItem(id: string) { this.pick(id); }
}
