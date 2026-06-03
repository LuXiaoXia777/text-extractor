#!/usr/bin/env node
require("dotenv").config({ quiet: true });

const cheerio = require("cheerio");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { spawn } = require("child_process");
const OpenCC = require("opencc-js");
const puppeteer = require("puppeteer-core");

const ROOT_DIR = path.resolve(__dirname, "..");
const PYTHON_BIN = process.env.FASTER_WHISPER_PYTHON || path.join(ROOT_DIR, ".venv/bin/python");
const TRANSCRIBE_MODEL = process.env.FASTER_WHISPER_MODEL || "base";
const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const XHS_COOKIE = process.env.XHS_COOKIE || "";
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";
const TESSERACT_BIN = process.env.TESSERACT_BIN || "tesseract";
const TESSERACT_LANG = process.env.TESSERACT_LANG || "chi_sim+eng";
const OUTPUT_DIR = path.resolve(ROOT_DIR, process.env.OUTPUT_DIR || "outputs");
const toSimplifiedChinese = OpenCC.Converter({ from: "twp", to: "cn" });

if (HTTPS_PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new ProxyAgent(HTTPS_PROXY));
  } catch (_error) {}
}

function printUsage() {
  console.log(`用法:
  npm run to-text -- <视频/音频/图片路径或链接> [选项]

选项:
  --model <tiny|base|small>      faster-whisper 模型，默认读取 FASTER_WHISPER_MODEL 或 base
  --output <file|dir>            指定 Markdown 保存路径或文件夹，默认保存到 outputs/
  --json                         终端输出 JSON，同时仍保存 Markdown
  --keep                         保留下载和抽取出的临时文件
  --help                         显示帮助

示例:
  npm run to-text -- ./video.mp4
  npm run to-text -- ./voice.m4a --model tiny
  npm run to-text -- ./image.png --output outputs/image-note.md
  npm run to-text -- "小红书分享文案里的链接" --json
`);
}

function parseArgs(argv) {
  const options = { inputParts: [], model: TRANSCRIBE_MODEL, output: "", json: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--model") options.model = argv[++i] || "";
    else if (arg === "--output" || arg === "-o") options.output = argv[++i] || "";
    else if (arg === "--json") options.json = true;
    else if (arg === "--keep") options.keep = true;
    else options.inputParts.push(arg);
  }
  options.input = options.inputParts.join(" ").trim();
  return options;
}

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function simplifyChineseText(value) {
  return typeof value === "string" && value ? toSimplifiedChinese(value) : value || "";
}

function extractFirstUrl(input) {
  const match = String(input || "").match(/https?:\/\/[^\s\u3002\uff0c\uff1b\uff01\uff1f\uff09\uff08\u3001]+/i);
  return match ? match[0].replace(/[),.;!?]+$/, "") : "";
}

function extractNoteIdFromUrl(url) {
  const patterns = [
    /\/explore\/([a-zA-Z0-9]+)/,
    /\/discovery\/item\/([a-zA-Z0-9]+)/,
    /source=note&noteId=([a-zA-Z0-9]+)/i,
    /noteId=([a-zA-Z0-9]+)/i
  ];
  for (const pattern of patterns) {
    const match = String(url || "").match(pattern);
    if (match) return match[1];
  }
  return "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function decodeEscapedUrl(value) {
  return value.replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
}

function looksLikeVideoUrl(url) {
  return Boolean(url && /\.(mp4|m3u8|mov|m4v)(\?|$)/i.test(url));
}

function looksLikeAudioUrl(url) {
  return Boolean(url && /\.(mp3|m4a|wav|aac|flac|ogg|opus)(\?|$)/i.test(url));
}

function looksLikeImageUrl(url) {
  return Boolean(url && /\.(jpg|jpeg|png|webp|tif|tiff|bmp)(\?|$)/i.test(url));
}

function fileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"].includes(ext)) return "video";
  if ([".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus"].includes(ext)) return "audio";
  if ([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"].includes(ext)) return "image";
  return "";
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function timestampForMarkdown(date = new Date()) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function sanitizeFileName(value) {
  const base = cleanText(value)
    .replace(/[\\/:*?"<>|#%{}[\]^~`]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return base || "to-text";
}

async function resolveMarkdownOutputPath(requestedOutput, output) {
  const defaultName = `${timestampForFile()}-${sanitizeFileName(output.title || output.type)}.md`;
  if (!requestedOutput) {
    return path.join(OUTPUT_DIR, defaultName);
  }

  const resolved = path.resolve(requestedOutput);
  const looksLikeDir =
    requestedOutput.endsWith("/") ||
    requestedOutput.endsWith(path.sep) ||
    (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory());

  if (looksLikeDir) {
    return path.join(resolved, defaultName);
  }

  return path.extname(resolved).toLowerCase() === ".md" ? resolved : `${resolved}.md`;
}

function formatMarkdown(output) {
  const title = cleanText(output.title) || "转文字结果";
  const lines = [
    `# ${title}`,
    "",
    `- 类型：${output.type}`,
    `- 来源：${output.source || ""}`,
    output.pageUrl ? `- 页面：${output.pageUrl}` : null,
    output.noteId ? `- 笔记 ID：${output.noteId}` : null,
    `- 引擎：${output.provider}${output.model ? ` / ${output.model}` : ""}`,
    output.sourceDurationSec ? `- 时长：${Math.round(output.sourceDurationSec)} 秒` : null,
    `- 生成时间：${timestampForMarkdown()}`,
    "",
    "## 正文",
    "",
    output.text || ""
  ];
  return `${lines.filter((line) => line !== null).join("\n")}\n`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      const raw = (stderr || stdout || "").trim().toLowerCase();
      const killed =
        signal === "SIGTERM" ||
        signal === "SIGKILL" ||
        code === null ||
        raw === "terminated" ||
        raw === "killed" ||
        raw.includes("out of memory");
      reject(
        killed
          ? new Error("转写进程被系统终止，通常是内存不足。请改用 --model tiny 或关闭其他应用后重试。")
          : new Error(`${command} exited with code ${code}: ${stderr || stdout}`)
      );
    });
  });
}

async function downloadToFile(url, filePath) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    referer: "https://www.xiaohongshu.com/"
  };
  if (XHS_COOKIE) headers.cookie = XHS_COOKIE;

  const response = await fetch(url, { redirect: "follow", headers });
  if (!response.ok) throw new Error(`下载失败，HTTP ${response.status}`);

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const fileStream = fs.createWriteStream(filePath);
  const readable = Readable.fromWeb(response.body);
  await new Promise((resolve, reject) => {
    readable.pipe(fileStream);
    readable.on("error", reject);
    fileStream.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

async function probeMedia(filePath) {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_entries",
    "format=duration,size:stream=index,codec_type,codec_name,duration",
    "-of",
    "json",
    filePath
  ]);
  return JSON.parse(stdout);
}

async function extractAudio(inputPath, audioPath) {
  await runCommand("ffmpeg", ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audioPath]);
  return audioPath;
}

async function transcribeAudio(audioPath, modelName) {
  if (!fs.existsSync(PYTHON_BIN)) throw new Error(`未找到本地 Python 转写环境：${PYTHON_BIN}`);
  const scriptPath = path.join(ROOT_DIR, "scripts", "transcribe_faster_whisper.py");
  const { stdout } = await runCommand(PYTHON_BIN, [scriptPath, audioPath, modelName]);
  const result = JSON.parse(stdout);
  return {
    text: simplifyChineseText(result.transcript || ""),
    provider: "faster-whisper",
    model: result.model || modelName,
    language: result.language || "",
    durationSec: Number(result.duration || 0),
    segmentCount: result.segment_count || 0
  };
}

async function ocrImage(imagePath) {
  const { stdout } = await runCommand(TESSERACT_BIN, [imagePath, "stdout", "-l", TESSERACT_LANG]);
  return {
    text: simplifyChineseText(stdout.trim()),
    provider: "tesseract",
    model: TESSERACT_LANG,
    language: "",
    durationSec: 0,
    segmentCount: 0
  };
}

function extractVideoUrlsFromHtml(html) {
  const matches = html.match(/https?:\/\/[^"'\\\s<>]+(?:mp4|m3u8)[^"'\\\s<>]*/gi) || [];
  return unique(matches.map(decodeEscapedUrl).filter(looksLikeVideoUrl));
}

function parseHtml(html, finalUrl) {
  const $ = cheerio.load(html);
  const title = cleanText($('meta[property="og:title"]').attr("content")) || cleanText($("title").text());
  const description =
    cleanText($('meta[property="og:description"]').attr("content")) ||
    cleanText($('meta[name="description"]').attr("content"));
  const ogVideo = cleanText($('meta[property="og:video"]').attr("content"));
  const ogImage =
    cleanText($('meta[property="og:image"]').attr("content")) ||
    cleanText($('meta[name="twitter:image"]').attr("content"));

  return {
    title: simplifyChineseText(title),
    description: simplifyChineseText(description),
    finalUrl,
    noteId: extractNoteIdFromUrl(finalUrl),
    videoCandidates: unique([ogVideo, ...extractVideoUrlsFromHtml(html)]),
    imageCandidates: unique([ogImage].filter(looksLikeImageUrl))
  };
}

async function resolveRedirect(url) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
  };
  if (XHS_COOKIE) headers.cookie = XHS_COOKIE;
  const response = await fetch(url, { redirect: "follow", headers });
  return { finalUrl: response.url, status: response.status, html: await response.text() };
}

async function resolveMediaWithBrowser(url) {
  if (!fs.existsSync(CHROME_EXECUTABLE_PATH)) return null;

  const browser = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--lang=zh-CN",
      "--window-size=430,932",
      ...(HTTPS_PROXY ? [`--proxy-server=${HTTPS_PROXY}`] : [])
    ]
  });

  try {
    const page = await browser.newPage();
    const collected = new Set();
    await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    );
    await page.setExtraHTTPHeaders({
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: "https://www.xiaohongshu.com/",
      ...(XHS_COOKIE ? { cookie: XHS_COOKIE } : {})
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    page.on("response", (response) => {
      const responseUrl = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (looksLikeVideoUrl(responseUrl) || /video|mpegurl|mp4|application\/octet-stream/i.test(contentType)) {
        collected.add(responseUrl);
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const domData = await page.evaluate(() => {
      const urls = [];
      document.querySelectorAll("video, source").forEach((element) => {
        if (element.getAttribute("src")) urls.push(element.getAttribute("src"));
        if (element.currentSrc) urls.push(element.currentSrc);
      });
      Array.from(document.scripts).forEach((script) => {
        const text = script.textContent || "";
        const matched = text.match(/https?:\/\/[^"'\\\s<>]+(?:mp4|m3u8)[^"'\\\s<>]*/gi) || [];
        matched.forEach((item) => urls.push(item));
      });
      return { title: document.title || "", urls };
    });

    domData.urls.map(decodeEscapedUrl).filter(looksLikeVideoUrl).forEach((item) => collected.add(item));
    return { title: simplifyChineseText(domData.title || ""), finalUrl: page.url(), videoCandidates: unique([...collected]) };
  } finally {
    await browser.close();
  }
}

async function resolveInput(input, tempDir) {
  const localPath = path.resolve(input);
  if (fs.existsSync(localPath)) {
    const kind = fileKind(localPath);
    if (!kind) throw new Error(`不支持的本地文件类型：${localPath}`);
    return { kind, sourcePath: localPath, source: localPath, title: path.basename(localPath) };
  }

  const url = extractFirstUrl(input);
  if (!url) throw new Error("没有找到本地文件，也没有从输入中识别到有效链接。");

  if (looksLikeVideoUrl(url) || looksLikeAudioUrl(url) || looksLikeImageUrl(url)) {
    const kind = looksLikeImageUrl(url) ? "image" : looksLikeAudioUrl(url) ? "audio" : "video";
    const ext = path.extname(new URL(url).pathname) || (kind === "image" ? ".jpg" : ".mp4");
    const sourcePath = path.join(tempDir, `download${ext}`);
    await downloadToFile(url, sourcePath);
    return { kind, sourcePath, source: url, title: path.basename(sourcePath) };
  }

  const redirected = await resolveRedirect(url);
  const parsed = parseHtml(redirected.html, redirected.finalUrl);
  let mediaUrl = parsed.videoCandidates[0] || parsed.imageCandidates[0] || "";

  if (!mediaUrl) {
    const browserResult = await resolveMediaWithBrowser(url);
    mediaUrl = browserResult?.videoCandidates?.[0] || "";
    if (browserResult?.title) parsed.title = browserResult.title;
    if (browserResult?.finalUrl) parsed.finalUrl = browserResult.finalUrl;
  }

  if (!mediaUrl) throw new Error("链接已打开，但没有识别到可下载的视频或图片资源。");

  const kind = looksLikeImageUrl(mediaUrl) ? "image" : "video";
  const ext = path.extname(new URL(mediaUrl).pathname) || (kind === "image" ? ".jpg" : ".mp4");
  const sourcePath = path.join(tempDir, `download${ext}`);
  await downloadToFile(mediaUrl, sourcePath);
  return {
    kind,
    sourcePath,
    source: mediaUrl,
    pageUrl: parsed.finalUrl,
    title: parsed.title || parsed.description || mediaUrl,
    noteId: parsed.noteId || ""
  };
}

async function convertToText(resolved, options, tempDir) {
  if (resolved.kind === "image") return ocrImage(resolved.sourcePath);

  let audioPath = resolved.sourcePath;
  const sourceProbe = await probeMedia(resolved.sourcePath);
  const sourceMeta = sourceProbe.format || {};
  const hasAudioStream = (sourceProbe.streams || []).some((stream) => stream.codec_type === "audio");
  if (!hasAudioStream) throw new Error("这个视频或音频文件里没有可转写的音轨。");

  if (resolved.kind === "video") {
    audioPath = path.join(tempDir, "audio.mp3");
    await extractAudio(resolved.sourcePath, audioPath);
  }

  const result = await transcribeAudio(audioPath, options.model);
  return { ...result, sourceDurationSec: Number(sourceMeta.duration || 0) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "to-text-"));
  try {
    const resolved = await resolveInput(options.input, tempDir);
    const textResult = await convertToText(resolved, options, tempDir);
    const output = {
      ok: true,
      type: resolved.kind,
      title: resolved.title || "",
      source: resolved.source,
      pageUrl: resolved.pageUrl || "",
      noteId: resolved.noteId || "",
      provider: textResult.provider,
      model: textResult.model,
      language: textResult.language || "",
      sourceDurationSec: textResult.sourceDurationSec || textResult.durationSec || 0,
      segmentCount: textResult.segmentCount || 0,
      text: textResult.text || ""
    };

    const markdownPath = await resolveMarkdownOutputPath(options.output, output);
    await fsp.mkdir(path.dirname(markdownPath), { recursive: true });
    await fsp.writeFile(markdownPath, formatMarkdown(output), "utf8");
    output.markdownPath = markdownPath;

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(output.text);
      console.error(`\n已保存到：${markdownPath}`);
    }
  } finally {
    if (!options.keep) await fsp.rm(tempDir, { recursive: true, force: true });
    else console.error(`临时文件保留在：${tempDir}`);
  }
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
