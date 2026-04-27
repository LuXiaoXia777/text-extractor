# 小红书链接转文字 MVP

## 配置

先复制配置模板：

```bash
cp .env.example .env
```

然后至少填写：

```env
XHS_COOKIE=
```

- `XHS_COOKIE`：你登录小红书后浏览器请求头里的整段 cookie
- `FASTER_WHISPER_MODEL`：本地转写模型，默认 `base`

## 启动

```bash
npm install
npm run dev
```

默认访问：

```bash
http://localhost:3000
```

## 配置检查

```bash
http://localhost:3000/api/config-status
```

返回是否检测到：

- 小红书 cookie
- 本地 faster-whisper Python 环境
- Chrome 路径
- 当前转写模型
