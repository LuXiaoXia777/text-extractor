# 小红书视频转文字

一个本地运行的小红书视频转文字网站：

- 输入小红书分享文案或链接
- 自动解析视频
- 自动抽音频
- 使用本地 `faster-whisper` 转文字

## 运行环境

换一台电脑后，不能只下载代码就直接用，还需要先安装这些依赖：

1. Node.js 18+
2. Python 3
3. `ffmpeg`
4. Google Chrome

## 1. 克隆项目

```bash
git clone https://github.com/LuXiaoXia777/video_to_text.git
cd video_to_text
```

## 2. 安装前端 / Node 依赖

```bash
npm install
```

## 3. 创建 Python 虚拟环境并安装转写依赖

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install faster-whisper
```

如果以后重新打开终端，还需要先激活虚拟环境：

```bash
. .venv/bin/activate
```

## 4. 安装 ffmpeg

如果你是 macOS，通常可以用 Homebrew：

```bash
brew install ffmpeg
```

安装完成后可以检查：

```bash
ffmpeg -version
```

## 5. 配置 `.env`

先复制模板：

```bash
cp .env.example .env
```

然后编辑 `.env`。

推荐最少配置：

```env
XHS_COOKIE=
FASTER_WHISPER_MODEL=base
FASTER_WHISPER_DEVICE=cpu
FASTER_WHISPER_COMPUTE_TYPE=int8
FASTER_WHISPER_PYTHON=/你的项目路径/.venv/bin/python
CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
PORT=3000
```

注意：

- `FASTER_WHISPER_PYTHON` 必须改成你当前电脑上的实际项目路径
- 如果是 macOS，默认 Chrome 路径通常就是：
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

## 6. 如何获取 `XHS_COOKIE`

`XHS_COOKIE` 不是链接，而是你登录小红书后的浏览器 Cookie。

获取方法：

1. 用 Chrome 打开并登录小红书：
   `https://www.xiaohongshu.com/`
2. 按 `Option + Command + I` 打开开发者工具
3. 点顶部的 `网络`
4. 刷新页面
5. 点任意一个发往 `xiaohongshu.com` 的请求
6. 在右侧点 `标头`
7. 在 `请求标头` 里找到：

```text
cookie: xxxxx
```

8. 复制 `cookie:` 后面的整段内容
9. 粘贴到 `.env`：

```env
XHS_COOKIE=这里粘贴整段cookie
```

注意：

- 不要把 `.env` 提交到 GitHub
- 不要把 Cookie 发给别人
- Cookie 过期后需要重新复制

## 7. 启动项目

```bash
npm run dev
```

启动后访问：

```bash
http://localhost:3000
```

## 8. 检查配置是否生效

打开：

```bash
http://localhost:3000/api/config-status
```

如果配置正常，你会看到类似：

```json
{
  "ok": true,
  "hasXhsCookie": true,
  "hasChrome": true,
  "hasLocalWhisper": true,
  "transcribeModel": "base"
}
```

## 9. 常用模型档位

你可以在网页里直接切换速度档位，也可以在 `.env` 里设置默认值：

```env
FASTER_WHISPER_MODEL=base
```

可选值：

- `tiny`：最快，准确率较低
- `base`：速度和准确率更平衡
- `small`：更稳一些，但更慢

## 10. 常见问题

### 1. 网站能打开，但不能转文字

通常检查这几项：

- `ffmpeg` 是否安装成功
- `.venv` 是否创建成功
- `faster-whisper` 是否安装成功
- `FASTER_WHISPER_PYTHON` 路径是否正确

### 2. 网站能打开，但小红书链接解析失败

通常检查：

- `XHS_COOKIE` 是否填了
- Cookie 是否过期
- 小红书是否需要重新登录

### 3. 第一次转写很慢

这是正常的。

第一次运行 `faster-whisper` 会下载模型，后面会快很多。

## 11. 项目结构

```text
public/                     前端页面
scripts/transcribe_faster_whisper.py
server.js                   后端服务
.env.example                配置模板
```
