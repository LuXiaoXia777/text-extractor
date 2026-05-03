# 小红书视频转文字

本地运行的视频工具网站：输入小红书分享文案或链接，自动解析视频、抽音频、用本地 faster-whisper 转文字，并支持博主数据分析和爆款标题库。

---

## 每次启动步骤

> 日常使用时照着这里做就够了。

**第一步：拉取最新代码**

```bash
git pull origin main
```

**第二步：如果 package.json 有变动，重新安装依赖**

每次 pull 完，建议都跑一下（几秒钟，有变化时会自动安装，没变化也不影响）：

```bash
npm install
```

**第三步：启动服务器**

```bash
npm start
```

看到这行说明启动成功：

```
Server running at http://localhost:3000
```

**第四步：打开浏览器**

```
http://localhost:3000
```

---

## 需要定期手动处理的事

### Cookie 过期（约每 1-2 周需要更新一次）

小红书 Cookie 有时效性，过期后链接解析会失败。症状：能打开网站，但粘贴链接后报错。

更新方法：

1. 用 Chrome 打开并登录小红书：`https://www.xiaohongshu.com/`
2. 按 `Option + Command + I` 打开开发者工具
3. 点顶部的 `网络`（Network）
4. 刷新页面
5. 点任意一个发往 `xiaohongshu.com` 的请求
6. 在右侧点 `标头`（Headers）
7. 在「请求标头」里找到 `cookie: xxxxxx`
8. 复制 `cookie:` 后面的整段内容
9. 打开项目目录里的 `.env` 文件，替换 `XHS_COOKIE=` 后面的内容
10. 保存 `.env`，重启服务器（`npm start`）

---

## 首次安装（换电脑或全新环境）

### 1. 克隆项目

```bash
git clone https://github.com/LuXiaoXia777/video_to_text.git
cd video_to_text
```

### 2. 安装 Node 依赖

```bash
npm install
```

### 3. 安装 Python 转写环境

```bash
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install faster-whisper
```

### 4. 安装 ffmpeg

```bash
brew install ffmpeg
```

验证：

```bash
ffmpeg -version
```

### 5. 配置 `.env`

```bash
cp .env.example .env
```

用文本编辑器打开 `.env`，至少需要改这两项：

```env
XHS_COOKIE=（粘贴你的小红书 Cookie，获取方法见上方）
FASTER_WHISPER_PYTHON=/Users/你的用户名/Desktop/video_to_text/.venv/bin/python
```

其余保持默认即可：

```env
FASTER_WHISPER_MODEL=base
FASTER_WHISPER_DEVICE=cpu
FASTER_WHISPER_COMPUTE_TYPE=int8
CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
PORT=3000
```

### 6. 启动

```bash
npm start
```

访问 `http://localhost:3000`，确认页面能打开。

---

## 检查配置是否正常

访问：

```
http://localhost:3000/api/config-status
```

正常时会看到：

```json
{
  "ok": true,
  "hasXhsCookie": true,
  "hasChrome": true,
  "hasLocalWhisper": true,
  "transcribeModel": "base"
}
```

- `hasXhsCookie: true` — Cookie 已配置
- `hasChrome: true` — Chrome 找得到
- `hasLocalWhisper: true` — Python 路径正确，faster-whisper 可用

---

## 常见问题

**网站能打开，但小红书链接解析失败**
→ Cookie 过期，按上面「Cookie 过期」步骤更新。

**网站能打开，但不能转文字**
→ 依次检查：`ffmpeg` 是否安装、`.venv` 是否创建、`FASTER_WHISPER_PYTHON` 路径是否指向当前电脑的实际路径。

**npm start 启动失败，报 `Cannot find module`**
→ 跑一次 `npm install` 再重试，通常是 pull 了新代码但没有更新依赖。

**第一次转写很慢**
→ 正常，faster-whisper 第一次运行会下载模型，后续会快很多。

---

## 转写速度档位

可以在网页里切换，也可以在 `.env` 里设置默认值：

| 档位 | 说明 |
|------|------|
| `tiny` | 最快，准确率较低 |
| `base` | 速度和准确率平衡（推荐） |
| `small` | 更准，但更慢 |
