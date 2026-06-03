# 本地转文字脚本

这个项目只保留本地脚本能力：视频、音频、图片、链接转文字。没有网页、服务端、标题库、线索库和数据分析功能。

转写结果默认保存为 Markdown 文件，统一放在 `outputs/` 文件夹里。

## 安装

### 1. 安装 Node 依赖

```bash
npm install
```

### 2. 安装 Python 转写环境

```bash
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install faster-whisper
```

### 3. 安装 ffmpeg 和 tesseract

```bash
brew install ffmpeg tesseract tesseract-lang
```

验证：

```bash
ffmpeg -version
tesseract --version
```

### 4. 配置 `.env`

```bash
cp .env.example .env
```

至少需要确认这一项指向当前项目的虚拟环境：

```env
FASTER_WHISPER_PYTHON=/Users/你的用户名/path/to/链接转文字/.venv/bin/python
```

小红书链接解析不稳定时，可以补 `XHS_COOKIE`。

## 使用

```bash
npm run to-text -- ./video.mp4
npm run to-text -- ./voice.m4a --model tiny
npm run to-text -- ./image.png --output outputs/image-note.md
npm run to-text -- "小红书分享文案里的链接" --json
```

支持：

- 视频文件：`mp4`、`mov`、`m4v`、`mkv`、`webm`、`avi`
- 音频文件：`mp3`、`m4a`、`wav`、`aac`、`flac`、`ogg`、`opus`
- 图片文件：`jpg`、`png`、`webp`、`tif`、`bmp`
- 链接：媒体直链、图片直链、小红书分享链接

## 参数

- `--model tiny|base|small`：选择 faster-whisper 模型
- `--output file.md`：指定 Markdown 保存路径
- `--output outputs/`：指定 Markdown 保存文件夹
- `--json`：终端输出 JSON，同时仍保存 Markdown
- `--keep`：保留临时下载和抽音频文件

不传 `--output` 时，结果会自动保存到 `outputs/`。

## 同步到 GitHub

手动同步当前改动：

```bash
npm run sync
```

持续监听并自动同步：

```bash
npm run sync:watch
```

`sync:watch` 会一直运行，发现文件变化后等待一小段时间，再自动提交并推送到 GitHub。按 `Ctrl+C` 可以停止。

安装后台自动同步：

```bash
npm run sync:auto:install
```

安装后，系统登录时会自动启动监听。这个工作流会每 15 秒检查一次项目改动，发现变化后等待 20 秒，再自动提交并推送到 GitHub。

如果项目放在 macOS 的 `Documents`、`Desktop`、`Downloads` 等受保护目录里，后台服务可能会被系统隐私权限拦截。遇到这种情况，可以使用前台监听：

```bash
npm run sync:watch
```

或者把项目移动到非受保护目录后重新运行 `npm run sync:auto:install`。

停止并移除后台自动同步：

```bash
npm run sync:auto:uninstall
```

后台日志位置：

```bash
~/Library/Logs/text-extractor/autosync.log
~/Library/Logs/text-extractor/autosync.err.log
```

## 常见问题

**小红书链接解析失败**
→ 更新 `.env` 里的 `XHS_COOKIE`，或确认 `CHROME_EXECUTABLE_PATH` 指向本机 Chrome。

**音视频不能转文字**
→ 检查 `ffmpeg`、`.venv`、`FASTER_WHISPER_PYTHON`。

**图片不能转文字**
→ 检查 `tesseract` 和中文语言包是否安装。必要时调整 `.env` 里的 `TESSERACT_LANG`。

**第一次转写很慢**
→ 正常，faster-whisper 第一次运行会下载模型，后续会快很多。

**内存不足**
→ 使用 `--model tiny`。
