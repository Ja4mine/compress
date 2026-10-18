# Compress

**English** · [简体中文](README.zh-CN.md)

**Fold any note in Obsidian, from a one-screen map of its sections down to every word.**

Reading papers and references means switching back and forth between "what is this about?" and "let me read this paragraph closely". Compress turns a Markdown note or a PDF into five levels you zoom through with one key. When a paragraph is hard going, read it in translation right where it is, or select a sentence or a concept and ask an AI to explain it against the text.

It follows the ideas of [TextFold](https://github.com/chenxiachan/textfold) (Apache 2.0): a five-level ladder, the author's words kept apart from what a model wrote, and every model-written line anchored to the sentences it rests on. Compress reimplements this in TypeScript as an Obsidian plugin, and adds sentence-aligned translation and a chat for questions.

> **Interface language:** the plugin's interface (buttons, commands, settings) is currently in Simplified Chinese. Below, the labels you will see are given in Chinese next to their meaning. Translations and model-written levels can target other languages (Settings › Compress › 阅读语言, reading language).

## Five levels

| Key | Level | Each paragraph becomes | Whose words |
|:-:|---|---|---|
| **1** | Full (全文) | the paragraph as written | the author's |
| **2** | Key sentences (摘句) | 1–3 of its sentences, verbatim | the author's, picked by the model |
| **3** | Brief (精要) | its point and the reason for it | the model's, based on the key sentences |
| **4** | Takeaway (要点) | one line | the model's |
| **5** | Topic (主题) | a few words; the whole note becomes a map of section cards | the model's |

- **Works before any model call.** Until levels are generated, each paragraph folds to its first sentences, locally. Click **AI 生成层级** (generate levels) in the toolbar and the levels fill in section by section, one request per section.
- **Open just one paragraph.** Click a paragraph to see it in full; click again to fold it back. Click a section heading to open the whole section.
- **Zoom stays where you are.** Switch levels with `1`–`5`, `⌘/Ctrl + scroll`, or a trackpad pinch; the paragraph under the pointer stays in place.
- **Roles.** At levels 3 and 4 each paragraph is tagged with its job in the argument: context, gap, claim, method, setup, result, analysis, limitation.
- **Model-written text is marked** with a thin line at the paragraph's edge, so it is never mistaken for the author's.

## Reading PDFs

Obsidian already displays PDFs. Compress also extracts their text, so a PDF can be folded, translated and asked about like a note:

- **Open it directly.** Right-click a PDF › **Compress：分层阅读** (layered reading), or open the PDF and click the layers icon in the left ribbon. Text is extracted with the PDF.js that ships with Obsidian, on your computer; nothing is uploaded.
- **Layout recovery.** Two columns are read left then right; running headers, footers and page numbers are dropped; words hyphenated across lines are joined; headings are recognised by size, font and numbering (`3.2`). Kangxi radical characters that some Chinese PDFs produce (⽂, ⻓) are mapped back to normal characters.
- **What is not prose goes into collapsed callouts.** Authors and affiliations, text inside figures, tables, equations, footnotes and the references each go into a callout you can expand. They are not paragraphs, so no model is asked to fold them and they cost nothing.
- **Back to the page.** Click the 📄 icon beside a paragraph to open the PDF next to the reader at that paragraph's page. Citations like ¶12 in answers jump there too.
- **Inside Obsidian's PDF view.** Select text in Obsidian's own PDF viewer and a small bar offers translate / explain / ask (翻译 / 解释 / 提问). It can be turned off in the settings.
- **Extract to a note.** Right-click › **Compress：提取文字为笔记** (extract text to a note) writes a Markdown note beside the PDF, which you can edit, link and search. Levels and translations are cached by content, so they carry over to the note at no extra cost.

Limits: the built-in extraction cannot recover formulas (in a PDF they are just glyphs placed on the page), and scanned PDFs have no text layer. Use MinerU for both.

### Parsing with MinerU: formulas as LaTeX

[MinerU](https://github.com/opendatalab/MinerU) recognises formulas as LaTeX and tables as tables, and runs OCR on scans. Right-click a PDF › **Compress：用 MinerU 解析** (parse with MinerU). The result is saved as a note beside the PDF (with a `compress-source` property), its images in a `<name>.assets/` folder. From then on, opening the PDF in the reader reads that note, and its paragraphs still jump back to their PDF pages.

Two ways to run it, chosen in **Settings › Compress › PDF 解析（MinerU）** (PDF parsing):

| | Cloud API (start here) | Local `mineru-kit` |
|---|---|---|
| Setup | Sign in at [mineru.net](https://mineru.net/apiManage/docs), create a token under API management, paste it into the settings | `uv pip install -U "mineru>=4.0,<5"` (Python 3.10–3.14); the first parse downloads about 3.4 GB of models |
| Limits | 2,000 pages a day at top priority per account; files up to 200 MB and 200 pages | none; speed depends on your computer (16 GB or more of memory recommended on Apple silicon) |
| Privacy | the PDF is uploaded to MinerU's servers | nothing leaves your computer |
| Platforms | desktop and mobile | desktop only |

Locally the `advanced` tier is used by default (formulas as LaTeX); `flash` is fastest but gives formulas as images. Obsidian started from the Dock may not find the `mineru-kit` command; in that case enter its full path in the settings (run `which mineru-kit` in a terminal).

### Asking the AI about a formula

- In the reader, hover a display formula and click the Σ icon (讲解这个公式, explain this formula); click an inline formula inside a paragraph. You can also copy its LaTeX.
- The chat receives the formula's LaTeX and the paragraph it belongs to. The answer says what the formula computes, goes through its symbols (using the document's own definitions and citing the paragraph that gives them), then the intuition and the formula's role in the document. A symbol the document does not define is explained by its usual meaning, and said to be so.
- In the editor, select LaTeX source and right-click › **Compress：解释选中内容** (explain selection).

## Translation

- **The whole note.** Switch between 原文 / 对照 / 简体中文 (original / side by side / translation; the third button is named after your reading language) in the toolbar, or press `L`. Translations are aligned sentence by sentence with the original, so level 2 shows the matching translated sentences; levels 3–5 are written in both languages when the levels are generated, with no separate translation step.
- **One paragraph.** Hover a paragraph and click 🌐 to show its translation underneath.
- **A selection.** Select text in the reader, the editor or reading view and click **翻译** (translate), or right-click › **Compress：翻译选中内容**. The translation pops up beside it, and you can go on to explain or ask.
- **Glossary.** Add lines like `attention = 注意力` in the settings to fix how terms are translated.
- The reading language defaults to Simplified Chinese and can be changed to Traditional Chinese, English, Japanese and others.

## Asking questions

- Select a concept or sentence and click **解释** (explain) or **提问** (ask); click the chat icon beside a paragraph to ask about that paragraph; the chat icon in the toolbar asks about the whole note.
- Follow-up questions continue in the side panel. Quick buttons: explain, translate and explain, say it simply, give an example, role in the text; for the whole note: core argument, structure, questions worth asking.
- Answers give the conclusion first, then the grounds, citing the paragraphs they rest on as **¶12**; click one to jump to that paragraph in the reader and highlight it.
- A note up to 60,000 characters is sent whole; a longer one is sent as its section map, the paragraphs around you, and the paragraphs that match the question.
- **Save as note** (保存为笔记) stores the conversation as Markdown, with a link back to the source.

## Installation

Compress is not in the Obsidian community plugin directory yet, so it is installed by hand.

**From a release.** Download `main.js`, `manifest.json` and `styles.css` from this repository's Releases into `.obsidian/plugins/compress/` in your vault, then enable Compress under **Settings › Community plugins**. Once the repository has a release, the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin can also install and update it from this repository's URL.

**From source.**

```bash
npm install
npm run build
```

Then copy the generated `main.js` together with `manifest.json` and `styles.css` into the folder above. While developing, `npm run dev` rebuilds `main.js` whenever the source changes.

## Connecting a model

In **Settings › Compress › 服务商** (provider), pick a provider, enter its API key and a model name (**获取列表** fetches the provider's model list), then **测试连接** (test connection).

| Provider | Notes |
|---|---|
| DeepSeek, Qwen (Alibaba Bailian), Zhipu GLM, Kimi, SiliconFlow, OpenAI, OpenRouter | OpenAI-compatible: a key and a model name are all it needs |
| Anthropic Claude | through the official SDK, default model `claude-opus-5-5`; levels are requested as structured output, so the JSON is always valid |
| Ollama | local models, no key |
| Custom (自定义) | any OpenAI-compatible endpoint: enter its base URL |

- A stronger model can be set for answering questions only (**问答模型**, Q&A model).
- With Claude's official endpoint, server-side fallback is on (`fallbacks: "default"`): if the model declines a request on policy grounds, Anthropic answers it with its recommended fallback model. It is off when a proxy URL is set.
- Some providers do not allow cross-origin streaming from Obsidian; the plugin then falls back to a single response, and the answer appears when it is complete.

## Cost, cache and privacy

- Levels: one request per section (long sections in parts); a 10,000-word paper takes a dozen or so requests and 20–30k input tokens. Translating a whole note costs about as much as its length.
- Levels and translations are cached by **content** in `.obsidian/plugins/compress/cache/`: reopening or renaming a note costs nothing, and editing a paragraph regenerates only its section. The cache can be cleared in the settings.
- What you read, translate or ask about is sent to the provider you chose. API keys are stored in plain text in `.obsidian/plugins/compress/data.json`; take care if your vault is synced with Git or a cloud drive.

## Commands

Search for "Compress" in **Settings › Hotkeys** to bind any of these:

| Command (as shown) | What it does |
|---|---|
| 分层阅读当前笔记 | open the reader beside the current note or PDF (also: the layers icon in the ribbon, or right-click a file) |
| 用 MinerU 解析 PDF（识别公式和表格） | parse the PDF with MinerU into a note with LaTeX formulas |
| 把 PDF 的文字提取为笔记 | extract the PDF's text into a note beside it, with the built-in extractor |
| 为当前笔记生成层级（AI） | generate the levels of sections that do not have them yet |
| 翻译当前笔记全文 | translate the whole note, sentence by sentence |
| 切换到层级 1–5 | the same as pressing a digit in the reader |
| 切换 原文 / 对照 / 译文 | the same as pressing `L` in the reader |
| 翻译选中内容 / 解释选中内容 / 就选中内容提问 | translate / explain / ask about the selection; in the editor, reading view and the reader |
| 就当前笔记提问 | open the chat for the whole note |

## How it differs from TextFold

TextFold is a standalone reader (a Python server and a web page) for arXiv, PDF, Word, Zotero and more. Compress reads the Markdown notes and PDFs in your Obsidian vault, brings the same layered reading into Obsidian, and adds:

- sentence-aligned translation of a paragraph, a selection or a whole note, shown as original, side by side or translation;
- a chat panel for follow-up questions, with answers citing the paragraphs they rest on;
- support for model providers widely used in China.

TextFold's animation of words sliding between levels and its graph of how paragraphs support each other are not implemented here.

## Development

```bash
npm run build   # type-check and bundle
npm test        # unit and API tests (against local mock servers; no API cost)
```

Layout of the source:

```
src/core/      Markdown parsing, sentence splitting, the five levels, the cache, PDF layout recovery (no Obsidian APIs)
src/ai/        prompts, model calls (OpenAI-compatible / Anthropic SDK), batch generation
src/ui/        the reader, the chat panel, the translation popover, the selection bar
src/pdf.ts     reads each page's text items with Obsidian's bundled PDF.js
src/mineru.ts  runs MinerU (cloud API or local mineru-kit) and saves the result as a note
src/main.ts    the plugin: commands, menus, job progress
```

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
