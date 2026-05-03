require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const { Readable } = require("stream");
const { spawn } = require("child_process");
const cheerio = require("cheerio");
const OpenCC = require("opencc-js");
const puppeteer = require("puppeteer-core");

// 若配置了代理，让 Node 内置 fetch 全局走代理
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";
if (HTTPS_PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new ProxyAgent(HTTPS_PROXY));
  } catch (_) {}
}

const app = express();
const PORT = process.env.PORT || 3000;
const TRANSCRIBE_MODEL = process.env.FASTER_WHISPER_MODEL || "base";
const PYTHON_BIN = process.env.FASTER_WHISPER_PYTHON || path.join(__dirname, ".venv/bin/python");
const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const XHS_COOKIE = process.env.XHS_COOKIE || "";
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const TITLE_LIBRARY_FILE = path.join(DATA_DIR, "title-library.json");
const HISTORY_LIMIT = 100;
const toSimplifiedChinese = OpenCC.Converter({ from: "twp", to: "cn" });
const MODEL_OPTIONS = {
  tiny: { label: "极速", description: "最快，准确率较低" },
  base: { label: "均衡", description: "速度和准确率更平衡" },
  small: { label: "更准", description: "更稳一些，但更慢" }
};

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function extractFirstUrl(input) {
  const match = input.match(/https?:\/\/[^\s\u3002\uff0c\uff1b\uff01\uff1f\uff09\uff08\u3001]+/i);
  return match ? match[0].replace(/[),.;!?]+$/, "") : null;
}

function extractNoteIdFromUrl(url) {
  const patterns = [
    /\/explore\/([a-zA-Z0-9]+)/,
    /\/discovery\/item\/([a-zA-Z0-9]+)/,
    /source=note&noteId=([a-zA-Z0-9]+)/i,
    /noteId=([a-zA-Z0-9]+)/i
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function simplifyChineseText(value) {
  if (typeof value !== "string" || !value) return value || "";
  return toSimplifiedChinese(value);
}

function toNullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function createEmptyRawMetrics() {
  return {
    likeCount: null,
    collectCount: null,
    commentCount: null,
    shareCount: null,
    viewCount: null,
    exposureCount: null
  };
}

function normalizeCounterValue(raw) {
  if (raw == null) return null;
  const text = String(raw).replace(/,/g, "").trim();
  if (!text) return null;

  const match = text.match(/(\d+(?:\.\d+)?)(万|w|W|千|k|K)?/);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = match[2];

  if (unit === "万" || unit === "w" || unit === "W") {
    return Math.round(base * 10000);
  }
  if (unit === "千" || unit === "k" || unit === "K") {
    return Math.round(base * 1000);
  }
  return Math.round(base);
}

function findMetricFromText(text, labels) {
  if (!text) return null;
  const normalized = String(text).replace(/\s+/g, "");
  const labelPattern = labels.join("|");
  const patterns = [
    new RegExp(`([\\d.,]+(?:万|w|W|千|k|K)?)(${labelPattern})`, "i"),
    new RegExp(`(${labelPattern})([\\d.,]+(?:万|w|W|千|k|K)?)`, "i")
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const value = normalizeCounterValue(match[1]);
      if (value !== null) return value;
      const fallback = normalizeCounterValue(match[2]);
      if (fallback !== null) return fallback;
    }
  }
  return null;
}

function mergeRawMetrics(...sources) {
  const merged = createEmptyRawMetrics();
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(merged)) {
      const value = source[key];
      if (value === 0 || Number.isFinite(value)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function extractXhsRawMetricsFromText(text) {
  if (!text) return createEmptyRawMetrics();

  return {
    likeCount: findMetricFromText(text, ["点赞", "赞"]),
    collectCount: findMetricFromText(text, ["收藏"]),
    commentCount: findMetricFromText(text, ["评论"]),
    shareCount: findMetricFromText(text, ["分享", "转发"]),
    viewCount: findMetricFromText(text, ["浏览", "阅读", "播放"]),
    exposureCount: findMetricFromText(text, ["曝光"])
  };
}

function buildDataAvailability(rawMetrics, commentSamples = []) {
  const availableFields = [];
  const missingFields = [];

  Object.entries(rawMetrics || {}).forEach(([key, value]) => {
    if (value === 0 || Number.isFinite(value)) {
      availableFields.push(key);
    } else {
      missingFields.push(key);
    }
  });

  if (commentSamples.length) {
    availableFields.push("commentSamples");
  } else {
    missingFields.push("commentSamples");
  }

  return {
    availableFields,
    missingFields,
    hasInteractionMetrics: ["likeCount", "collectCount", "commentCount"].some((key) => availableFields.includes(key)),
    hasCommentSamples: commentSamples.length > 0
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) return null;
      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (!name || !value) return null;
      return { name, value };
    })
    .filter(Boolean);
}

async function setCookiesFromHeader(page, cookieHeader, domain) {
  const cookies = parseCookieHeader(cookieHeader).map(({ name, value }) => ({
    name,
    value,
    domain,
    path: "/",
    secure: true,
    httpOnly: false
  }));

  if (!cookies.length) return;
  await page.setCookie(...cookies);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findJsonBlob(html) {
  const patterns = [
    /<script\b[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i,
    /<script\b[^>]*>\s*window\.__INITIAL_SSR_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i,
    /<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function collectStringsDeep(node, bucket = []) {
  if (typeof node === "string") {
    bucket.push(node);
    return bucket;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectStringsDeep(item, bucket);
    }
    return bucket;
  }

  if (node && typeof node === "object") {
    for (const value of Object.values(node)) {
      collectStringsDeep(value, bucket);
    }
  }

  return bucket;
}

function findBestText(strings) {
  return strings
    .map(cleanText)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || "";
}

function decodeEscapedUrl(value) {
  return value
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function looksLikeMediaUrl(url) {
  return Boolean(url && /\.(mp4|m3u8)(\?|$)/i.test(url));
}

function looksLikeImageUrl(url) {
  return Boolean(url && /^https?:\/\//i.test(url) && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url));
}

function isUsableCoverUrl(url) {
  return Boolean(
    url &&
      /^https?:\/\//i.test(url) &&
      !/^data:/i.test(url)
  );
}

function pickBestCover(candidates) {
  for (const candidate of candidates) {
    const value = cleanText(candidate);
    if (isUsableCoverUrl(value)) {
      return value;
    }
  }
  return "";
}

function extractVideoUrlsFromHtml(html) {
  const matches = html.match(/https?:\/\/[^"'\\\s<>]+(?:mp4|m3u8)[^"'\\\s<>]*/gi) || [];
  const normalized = matches
    .map(decodeEscapedUrl)
    .filter(looksLikeMediaUrl);
  return unique(normalized);
}

function parseHtml(html, finalUrl) {
  const $ = cheerio.load(html);
  const title =
    cleanText($('meta[property="og:title"]').attr("content")) ||
    cleanText($("title").text());
  const description =
    cleanText($('meta[property="og:description"]').attr("content")) ||
    cleanText($('meta[name="description"]').attr("content"));
  const image = pickBestCover([
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    $('img[src^="http"]').first().attr("src"),
    $('img').first().attr("src")
  ]);
  const ogVideo = cleanText($('meta[property="og:video"]').attr("content"));

  const author =
    cleanText($('meta[name="xhs:note_user_nickname"]').attr("content")) ||
    cleanText($('[class*="author"]').first().text());

  let noteText = description;
  let jsonDetected = false;
  const pageText = simplifyChineseText(cleanText($("body").text()));

  const jsonBlob = findJsonBlob(html);
  if (jsonBlob) {
    try {
      const parsed = JSON.parse(jsonBlob);
      const allStrings = collectStringsDeep(parsed, []);
      const longText = findBestText(allStrings.filter((item) => item.length > 20));
      if (longText) {
        noteText = cleanText(longText);
      }
      jsonDetected = true;
    } catch (error) {
      jsonDetected = false;
    }
  }

  const noteId = extractNoteIdFromUrl(finalUrl);
  const videoCandidates = unique([ogVideo, ...extractVideoUrlsFromHtml(html)]);
  const rawMetrics = extractXhsRawMetricsFromText(pageText);

  return {
    noteId,
    title,
    author,
    description,
    noteText,
    cover: image,
    finalUrl,
    jsonDetected,
    videoCandidates,
    rawMetrics,
    commentSamples: []
  };
}

function isResolvableNotePage(finalUrl) {
  return /xiaohongshu\.com\/(explore|discovery\/item)\//i.test(finalUrl);
}

function hasBrowserSupport() {
  return fs.existsSync(CHROME_EXECUTABLE_PATH);
}

function buildMediaHints({ usedBrowser, hasCookie, videoCandidates }) {
  const hints = [];

  if (usedBrowser) {
    hints.push("本次已启用真实浏览器兜底，直接从页面和网络请求里抓视频资源。");
  } else {
    hints.push("本次先走轻量解析，速度更快；失败时可再走浏览器兜底。");
  }

  if (!hasCookie) {
    hints.push("当前没有配置 XHS_COOKIE，遇到需要登录态或更严格风控的笔记，成功率会受影响。");
  }

  if (videoCandidates?.length) {
    hints.push("已经识别到候选视频资源，可以继续调用转写接口。");
  } else {
    hints.push("暂时还没有识别到可用视频资源。");
  }

  return hints;
}

async function resolveRedirect(url) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
  };

  if (XHS_COOKIE) {
    headers.cookie = XHS_COOKIE;
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers
  });

  const html = await response.text();
  return {
    finalUrl: response.url,
    status: response.status,
    html
  };
}

async function resolveMediaWithBrowser(url) {
  if (!hasBrowserSupport()) {
    return {
      usedBrowser: false,
      finalUrl: "",
      title: "",
      noteId: "",
      videoCandidates: [],
      cover: "",
      error: `未找到 Chrome 可执行文件：${CHROME_EXECUTABLE_PATH}`
    };
  }

  const puppeteerArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--lang=zh-CN",
    "--window-size=430,932"
  ];
  if (HTTPS_PROXY) {
    puppeteerArgs.push(`--proxy-server=${HTTPS_PROXY}`);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args: puppeteerArgs
  });

  const collected = new Set();
  let finalUrl = "";
  let title = "";
  let cover = "";
  let noteId = "";
  let pageText = "";
  let rawMetrics = createEmptyRawMetrics();
  let commentSamples = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    );
    await page.setExtraHTTPHeaders({
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: "https://www.xiaohongshu.com/"
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false
      });
    });

    if (XHS_COOKIE) {
      await page.setExtraHTTPHeaders({
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        referer: "https://www.xiaohongshu.com/",
        cookie: XHS_COOKIE
      });
    }

    page.on("response", async (response) => {
      try {
        const responseUrl = response.url();
        const contentType = response.headers()["content-type"] || "";
        if (looksLikeMediaUrl(responseUrl) || /video|mpegurl|mp4|application\/octet-stream/i.test(contentType)) {
          collected.add(responseUrl);
        }
      } catch (_error) {}
    });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await sleep(3500);

    const domData = await page.evaluate(() => {
      const urls = [];

      document.querySelectorAll("video, source").forEach((element) => {
        const src = element.getAttribute("src");
        if (src) urls.push(src);
        if (element.currentSrc) urls.push(element.currentSrc);
      });

      const coverCandidates = [
        document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
        document.querySelector('meta[name="twitter:image"]')?.getAttribute("content") || "",
        document.querySelector('img[src^="http"]')?.getAttribute("src") || "",
        document.querySelector("img")?.getAttribute("src") || ""
      ];

      Array.from(document.scripts).forEach((script) => {
        const text = script.textContent || "";
        const matched = text.match(/https?:\/\/[^"'\\\s<>]+(?:mp4|m3u8)[^"'\\\s<>]*/gi) || [];
        matched.forEach((item) => urls.push(item));
      });

      return {
        urls,
        title: document.title || "",
        coverCandidates,
        pageText: (document.body?.innerText || "").trim(),
        commentSamples: Array.from(
          document.querySelectorAll('[class*="comment"] span, [class*="comment"] p, [data-testid*="comment"] span')
        )
          .map((node) => (node.textContent || "").trim())
          .filter((text) => text.length >= 8 && text.length <= 120)
          .slice(0, 5)
      };
    });

    finalUrl = page.url();
    title = domData.title || "";
    cover = pickBestCover(domData.coverCandidates || []);
    noteId = extractNoteIdFromUrl(finalUrl) || "";
    pageText = simplifyChineseText(domData.pageText || "");
    rawMetrics = extractXhsRawMetricsFromText(pageText);
    commentSamples = unique((domData.commentSamples || []).map((text) => simplifyChineseText(text))).slice(0, 5);

    domData.urls
      .map(decodeEscapedUrl)
      .filter(looksLikeMediaUrl)
      .forEach((item) => collected.add(item));

    return {
      usedBrowser: true,
      finalUrl,
      title,
      cover,
      noteId,
      videoCandidates: unique([...collected]),
      rawMetrics,
      commentSamples
    };
  } finally {
    await browser.close();
  }
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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const raw = (stderr || stdout || "").trim().toLowerCase();
        const isKilled =
          signal === "SIGTERM" || signal === "SIGKILL" || code === null ||
          raw === "terminated" || raw === "killed" || raw.includes("out of memory");
        if (isKilled) {
          reject(new Error("转写进程被系统强制终止，通常是内存不足导致的。请关闭其他应用后重试，或在档位选择中改用「极速 · tiny」模型以减少内存占用。"));
        } else {
          reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
        }
      }
    });
  });
}

async function downloadToFile(url, filePath) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    referer: "https://www.xiaohongshu.com/"
  };

  if (XHS_COOKIE) {
    headers.cookie = XHS_COOKIE;
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers
  });

  if (!response.ok) {
    throw new Error(`媒体下载失败，HTTP ${response.status}`);
  }

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

async function extractAudio(videoPath, audioPath) {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "32k",
    audioPath
  ]);

  return audioPath;
}

function resolveRequestedModel(requestedModel) {
  return MODEL_OPTIONS[requestedModel] ? requestedModel : TRANSCRIBE_MODEL;
}

function getCombinedContent(note) {
  return simplifyChineseText([
    note.title || "",
    note.noteText || "",
    note.description || "",
    note.transcript || ""
  ].join("\n"));
}

function detectContentTypes(content) {
  const mappings = [
    { label: "教程", pattern: /(教程|如何|怎么|步骤|方法|攻略|技巧|指南|公式)/ },
    { label: "干货", pattern: /(干货|建议|经验|总结|复盘|避坑|核心|重点)/ },
    { label: "测评", pattern: /(测评|评测|开箱|实测|对比|体验|使用感)/ },
    { label: "叙事", pattern: /(经历|故事|今天|那天|后来|当时|自己|人生)/ },
    { label: "情绪", pattern: /(情绪|焦虑|崩溃|治愈|共鸣|痛苦|好运|体质)/ },
    { label: "种草", pattern: /(推荐|种草|入手|好物|值得买|平替|爱用|回购)/ }
  ];

  return mappings
    .filter((item) => item.pattern.test(content))
    .map((item) => item.label);
}

function classifyTitle(title) {
  if (!title || typeof title !== "string") {
    return { formulaId: 0, formulaName: "未分类" };
  }
  const t = title.trim();
  const rules = [
    { id: 7, name: "悬念揭秘", pattern: /(内幕|不会告诉你|不敢说|揭秘|真相|潜规则)/ },
    { id: 1, name: "时间+结果+经验", pattern: /(\d+(天|周|个月|年|小时)).{0,20}(终于|坚持|做到|改变|学会)|(终于).{0,20}\d+(天|周|个月|年)/ },
    { id: 4, name: "数字清单", pattern: /\d+\s*(个|件|条|点|步|招|种|类|款|本)[^\d]/ },
    { id: 8, name: "干货承诺", pattern: /(保姆级|零基础|一篇(讲完|搞定|看完)|手把手|超详细|全攻略|从零到一|一文搞懂)/ },
    { id: 5, name: "身份标签+反常识", pattern: /(\d{2}岁|宝妈|设计师|程序员|打工人|自由职业|留学生|大厂).{0,15}(不是|不靠|不用|其实|真正|而是)/ },
    { id: 6, name: "对比反差", pattern: /(vs\.?|VS\.?|对比|差距在哪|区别|哪个更|PK)/ },
    { id: 2, name: "痛点+解决方案+效果", pattern: /(总是|老是|一直|每次).{0,10}(卡|不会|不懂|没有)/ },
    { id: 3, name: "情绪共鸣", pattern: /(早知道|幸亏|幸好|可惜没|后悔|当初|要是早|真希望)/ },
    { id: 9, name: "故事第一人称", pattern: /^(那天|昨天|上周|上个月|今天|前几天|在.{2,8}的时候|记得那次)/ },
    { id: 10, name: "趋势判断+行业视角", pattern: /(202\d年?|下一个|未来|趋势|风口|赛道).{0,15}(判断|预测|方向|机会|洗牌|变化)/ },
    { id: 11, name: "提问+互动", pattern: /[？?]\s*$|姐妹们?.{0,10}(吗|不|嘛|呀|啊|呢)|你们.{0,10}[？?]/ }
  ];
  for (const rule of rules) {
    if (rule.pattern.test(t)) {
      return { formulaId: rule.id, formulaName: rule.name };
    }
  }
  return { formulaId: 0, formulaName: "未分类" };
}

async function ensureTitleLibraryFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(TITLE_LIBRARY_FILE, fs.constants.F_OK);
  } catch (_error) {
    await fsp.writeFile(TITLE_LIBRARY_FILE, "[]\n", "utf8");
  }
}

async function readTitleLibrary() {
  await ensureTitleLibraryFile();
  try {
    const raw = await fsp.readFile(TITLE_LIBRARY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

async function writeTitleLibrary(items) {
  await ensureTitleLibraryFile();
  await fsp.writeFile(TITLE_LIBRARY_FILE, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

async function appendTitleRecord(historyEntry) {
  if (!historyEntry.title) return;
  const library = await readTitleLibrary();
  if (library.some((item) => item.id === historyEntry.id)) return;
  const { formulaId, formulaName } = classifyTitle(historyEntry.title);
  const contentTypes = detectContentTypes(
    [historyEntry.title, historyEntry.noteText || "", historyEntry.transcript || ""].join("\n")
  );
  library.unshift({
    id: historyEntry.id,
    title: historyEntry.title,
    formulaId,
    formulaName,
    contentTypes,
    rawMetrics: {
      likeCount: historyEntry.rawMetrics?.likeCount ?? null,
      collectCount: historyEntry.rawMetrics?.collectCount ?? null,
      commentCount: historyEntry.rawMetrics?.commentCount ?? null
    },
    finalUrl: historyEntry.finalUrl || "",
    savedAt: historyEntry.createdAt || new Date().toISOString(),
    source: "auto"
  });
  await writeTitleLibrary(library);
}

function buildLevel(reasons, fallbackReason) {
  if (reasons.length >= 3) return { level: "高", reasons };
  if (reasons.length >= 2) return { level: "中", reasons };
  if (reasons.length >= 1) return { level: "低", reasons };
  return { level: "低", reasons: [fallbackReason] };
}

function buildTitleInsights(title) {
  const insights = [];
  if (/[？?]|如何|怎么|为什么/.test(title)) insights.push("标题带问题导向，容易吸引目标人群点开。");
  if (/\d/.test(title)) insights.push("标题出现数字表达，利于强化具体收益感。");
  if (/变成|做到|学会|提升|重启|重塑/.test(title)) insights.push("标题包含结果导向词，适合承接转化型阅读预期。");
  if (!insights.length) insights.push("标题偏陈述型，可增加问题感或结果感来提升点击动力。");
  return insights;
}

function buildAnalyticsSummary(note, ratios, contentTypes, availability) {
  const summary = [];
  if (contentTypes.length) {
    summary.push(`这是一篇偏${contentTypes.join(" / ")}的小红书笔记。`);
  } else {
    summary.push("这篇笔记目前更像是通用内容表达，类型特征不算特别强。");
  }

  if (ratios.collectLikeRatio !== null && ratios.collectLikeRatio >= 0.4) {
    summary.push("赞藏比偏高，说明内容更容易被用户当作可回看资料保存。");
  } else if (availability.hasInteractionMetrics) {
    summary.push("当前互动数据可用，但暂时没有明显的“高收藏倾向”信号。");
  } else {
    summary.push("当前真实互动数据不完整，结论以内容结构分析为主。");
  }

  if (ratios.commentLikeRatio !== null && ratios.commentLikeRatio >= 0.12) {
    summary.push("评论参与感相对不错，内容具备一定讨论空间。");
  } else {
    summary.push("评论层的讨论信号暂时一般，可以加强提问或争议点设计。");
  }

  return summary;
}

function buildXhsAnalytics(note) {
  const rawMetrics = mergeRawMetrics(note.rawMetrics);
  const content = getCombinedContent(note);
  const title = simplifyChineseText(note.title || "");
  const lines = content.split("\n").map((line) => cleanText(line)).filter(Boolean);
  const contentTypes = detectContentTypes(content);

  const likeCount = toNullableNumber(rawMetrics.likeCount);
  const collectCount = toNullableNumber(rawMetrics.collectCount);
  const commentCount = toNullableNumber(rawMetrics.commentCount);
  const shareCount = toNullableNumber(rawMetrics.shareCount);
  const viewCount = toNullableNumber(rawMetrics.viewCount);
  const exposureCount = toNullableNumber(rawMetrics.exposureCount);
  const engagementCount =
    (likeCount || 0) + (collectCount || 0) + (commentCount || 0);

  const ratios = {
    engagementRate: exposureCount ? engagementCount / exposureCount : null,
    collectLikeRatio: likeCount ? collectCount / likeCount : null,
    commentLikeRatio: likeCount ? commentCount / likeCount : null
  };

  const collectReasons = [];
  if (/(步骤|清单|方法|公式|攻略|教程|指南)/.test(content)) collectReasons.push("内容中有明确的方法、步骤或清单结构。");
  if (lines.length >= 8) collectReasons.push("文本信息密度较高，适合被收藏后反复查看。");
  if (/建议|总结|避坑|重点|核心/.test(content)) collectReasons.push("内容呈现出知识提炼或经验总结特征。");

  const commentReasons = [];
  if (/[？?]|你觉得|你会|有没有|是不是|欢迎/.test(content)) commentReasons.push("内容里存在提问或引导表达，利于触发评论。");
  if (/但是|可是|其实|误区|真相/.test(content)) commentReasons.push("内容具备一定反差或争议切口。");
  if (/我|自己|经历|故事/.test(content)) commentReasons.push("第一人称叙事更容易激发代入和回复。");

  const conversionReasons = [];
  if (/点击|收藏|关注|评论区|私信|主页|链接/.test(content)) conversionReasons.push("内容里存在明确行动引导。");
  if (/变成|提升|实现|学会|获得|解决/.test(content)) conversionReasons.push("内容表达了清晰收益或结果。");
  if (/适合|人群|如果你|你总是/.test(content)) conversionReasons.push("内容对目标读者有相对清晰的指向。");

  const suggestions = [];
  if (!/[？?]|如何|怎么|为什么/.test(title)) {
    suggestions.push("标题可以补一个问题句或结果句，增强点击动机。");
  }
  if (!/(步骤|清单|方法|建议|总结|攻略)/.test(content)) {
    suggestions.push("正文可以补更明确的结构词，让内容更像“可收藏资料”。");
  }
  if (!/(你觉得|欢迎|评论区|有没有|是不是)/.test(content)) {
    suggestions.push("结尾可增加一个明确提问，引导用户留言表达观点。");
  }
  if (!/(关注|收藏|点击|私信|主页|链接)/.test(content)) {
    suggestions.push("如果目标是转化，结尾需要更直接的行动号召。");
  }

  const commentSamples = Array.isArray(note.commentSamples) ? note.commentSamples : [];
  const availability = buildDataAvailability(rawMetrics, commentSamples);
  const limitations = [];
  if (!availability.hasInteractionMetrics) {
    limitations.push("当前没有稳定抓到点赞、收藏、评论等真实互动数据，表现层判断仅供参考。");
  }
  if (!commentSamples.length) {
    limitations.push("当前未抓到评论正文，评论洞察只基于评论数和内容结构推断。");
  }

  return {
    metrics: {
      ...rawMetrics,
      engagementCount
    },
    ratios,
    contentDiagnosis: {
      contentTypes,
      titleInsights: buildTitleInsights(title),
      collectPotential: buildLevel(collectReasons, "当前更偏普通表达，收藏理由不够集中。"),
      commentPotential: buildLevel(commentReasons, "当前缺少强提问或强讨论点。"),
      conversionPotential: buildLevel(conversionReasons, "当前行动号召与转化指令还不够明确。"),
      suggestions: suggestions.slice(0, 3)
    },
    commentInsight: {
      commentCount,
      hasCommentSamples: commentSamples.length > 0,
      commentSamples,
      note: commentSamples.length
        ? "已拿到部分评论样本，可继续做主题归纳。"
        : "当前仅分析评论数，评论内容洞察待后续抓取能力补齐。"
    },
    summary: buildAnalyticsSummary(note, ratios, contentTypes, availability),
    limitations
  };
}

async function ensureHistoryFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(HISTORY_FILE, fs.constants.F_OK);
  } catch (_error) {
    await fsp.writeFile(HISTORY_FILE, "[]\n", "utf8");
  }
}

async function readHistory() {
  await ensureHistoryFile();
  try {
    const raw = await fsp.readFile(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const history = Array.isArray(parsed) ? parsed : [];
    const normalized = history.map((item) => {
      const transcript = simplifyChineseText(item.transcript || "");
      const rawMetrics = mergeRawMetrics(item.rawMetrics, {
        likeCount: item.likeCount,
        collectCount: item.collectCount,
        commentCount: item.commentCount,
        shareCount: item.shareCount,
        viewCount: item.viewCount,
        exposureCount: item.exposureCount
      });
      const commentSamples = Array.isArray(item.commentSamples) ? item.commentSamples : [];
      const analytics = item.analytics || buildXhsAnalytics({
        title: item.title || "",
        noteText: item.noteText || "",
        description: item.description || "",
        transcript,
        rawMetrics,
        commentSamples
      });

      return {
        ...item,
        transcript,
        transcriptPreview: buildHistoryPreview(transcript),
        rawMetrics,
        commentSamples,
        analytics,
        analyticsSummary: item.analyticsSummary || analytics.summary.join(" ")
      };
    });
    const changed = JSON.stringify(history) !== JSON.stringify(normalized);
    if (changed) {
      await writeHistory(normalized);
    }
    return normalized;
  } catch (_error) {
    return [];
  }
}

function buildHistoryPreview(text) {
  return cleanText(text).slice(0, 120);
}

async function appendHistoryRecord(record) {
  const history = await readHistory();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...record,
    transcriptPreview: buildHistoryPreview(record.transcript || "")
  };

  history.unshift(entry);
  const trimmed = history.slice(0, HISTORY_LIMIT);
  await fsp.writeFile(HISTORY_FILE, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
  return entry;
}

async function writeHistory(items) {
  await ensureHistoryFile();
  await fsp.writeFile(HISTORY_FILE, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

async function transcribeWithLocalWhisper(audioPath, modelName) {
  if (!fs.existsSync(PYTHON_BIN)) {
    return {
      transcript: "",
      provider: "none",
      model: null,
      language: "",
      segmentCount: 0,
      warning: `未找到本地 Python 转写环境：${PYTHON_BIN}`
    };
  }

  const scriptPath = path.join(__dirname, "scripts", "transcribe_faster_whisper.py");
  const { stdout } = await runCommand(PYTHON_BIN, [scriptPath, audioPath, modelName]);
  const result = JSON.parse(stdout);

  return {
    transcript: simplifyChineseText(result.transcript || ""),
    provider: "faster-whisper",
    model: result.model || modelName,
    language: result.language || "",
    warning: result.warning || "",
    segmentCount: result.segment_count || 1
  };
}

async function resolveXhsNoteFromInput(input) {
  const url = extractFirstUrl(input || "");
  if (!url) {
    throw new Error("没有识别到有效链接。");
  }

  const { finalUrl, status, html } = await resolveRedirect(url);
  const parsed = parseHtml(html, finalUrl);
  const htmlSucceeded = isResolvableNotePage(finalUrl) && parsed.noteId;
  const parsedRawMetrics = mergeRawMetrics(parsed.rawMetrics);

  if (htmlSucceeded) {
    return {
      ok: true,
      inputUrl: url,
      httpStatus: status,
      ...parsed,
      rawMetrics: parsedRawMetrics,
      commentSamples: parsed.commentSamples || [],
      dataAvailability: buildDataAvailability(parsedRawMetrics, parsed.commentSamples || []),
      parserMode: "html",
      hints: buildMediaHints({
        usedBrowser: false,
        hasCookie: Boolean(XHS_COOKIE),
        videoCandidates: parsed.videoCandidates
      })
    };
  }

  const browserResult = await resolveMediaWithBrowser(url);
  const mergedRawMetrics = mergeRawMetrics(browserResult.rawMetrics, parsedRawMetrics);
  const mergedCommentSamples = unique([...(browserResult.commentSamples || []), ...(parsed.commentSamples || [])]).slice(0, 5);

  if (browserResult.noteId || parsed.noteId) {
    return {
      ok: true,
      inputUrl: url,
      httpStatus: status,
      noteId: browserResult.noteId || parsed.noteId,
      title: browserResult.title || parsed.title,
      author: parsed.author,
      description: parsed.description,
      noteText: parsed.noteText,
      cover: browserResult.cover || parsed.cover,
      finalUrl: browserResult.finalUrl || finalUrl,
      jsonDetected: parsed.jsonDetected,
      videoCandidates: browserResult.videoCandidates || parsed.videoCandidates,
      rawMetrics: mergedRawMetrics,
      commentSamples: mergedCommentSamples,
      dataAvailability: buildDataAvailability(mergedRawMetrics, mergedCommentSamples),
      parserMode: "browser",
      hints: buildMediaHints({
        usedBrowser: true,
        hasCookie: Boolean(XHS_COOKIE),
        videoCandidates: browserResult.videoCandidates
      })
    };
  }

  const error = new Error("解析失败，当前没有拿到足够稳定的笔记信息。");
  error.status = 422;
  error.payload = {
    ok: false,
    error: "解析失败，当前没有拿到足够稳定的笔记信息。",
    inputUrl: url,
    finalUrl,
    httpStatus: status,
    parserMode: "failed",
    title: parsed.title,
    author: parsed.author,
    noteText: parsed.noteText,
    description: parsed.description,
    cover: parsed.cover,
    browser: browserResult,
    dataAvailability: buildDataAvailability(mergedRawMetrics, mergedCommentSamples),
    rawMetrics: mergedRawMetrics,
    hints: [
      "这通常说明该笔记需要登录态、命中了风控，或者并不是公开视频笔记。",
      Boolean(XHS_COOKIE)
        ? "当前已经带了 XHS_COOKIE，但仍未拿到视频资源，下一步更可能需要人工登录态验证或更深的网络请求分析。"
        : "下一步优先建议配置 XHS_COOKIE，再次尝试浏览器兜底。"
    ]
  };
  throw error;
}

async function prepareMediaFromRequest(input, mediaUrl) {
  if (mediaUrl) {
    return {
      sourceType: "direct-media",
      finalUrl: "",
      noteId: "",
      title: "",
      author: "",
      noteText: "",
      description: "",
      cover: "",
      mediaUrl,
      rawMetrics: createEmptyRawMetrics(),
      commentSamples: [],
      dataAvailability: buildDataAvailability(createEmptyRawMetrics(), [])
    };
  }

  const note = await resolveXhsNoteFromInput(input);
  if (!note.videoCandidates?.length) {
    const failureMessage = !note.noteId
      ? "短链没有稳定落到具体笔记页，当前版本暂时无法继续解析。"
      : "笔记页已打开，但没有识别到视频资源，可能这是图文笔记、私密笔记，或页面结构发生了变化。";
    throw new Error(failureMessage);
  }
  return {
    sourceType: "xiaohongshu-note",
    finalUrl: note.finalUrl,
    noteId: note.noteId,
    title: note.title,
    author: note.author || "",
    noteText: note.noteText || "",
    description: note.description || "",
    cover: note.cover,
    mediaUrl: note.videoCandidates[0],
    videoCandidates: note.videoCandidates,
    parserMode: note.parserMode,
    rawMetrics: note.rawMetrics,
    commentSamples: note.commentSamples,
    dataAvailability: note.dataAvailability
  };
}

app.post("/api/parse", async (req, res) => {
  const { input } = req.body || {};
  if (!input || typeof input !== "string") {
    return res.status(400).json({ ok: false, error: "请输入小红书分享文案或链接。" });
  }

  try {
    const note = await resolveXhsNoteFromInput(input);
    return res.json(note);
  } catch (error) {
    if (error.payload) {
      return res.status(error.status || 422).json(error.payload);
    }
    return res.status(500).json({
      ok: false,
      error: "解析失败，可能是网络、跳转或页面风控导致。",
      detail: error.message
    });
  }
});

app.post("/api/transcribe", async (req, res) => {
  const { input, mediaUrl, model } = req.body || {};

  if ((!input || typeof input !== "string") && (!mediaUrl || typeof mediaUrl !== "string")) {
    return res.status(400).json({
      ok: false,
      error: "请提供小红书链接，或者直接提供视频直链 mediaUrl。"
    });
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xhs-transcribe-"));
  const videoPath = path.join(tempDir, "source.mp4");
  const audioPath = path.join(tempDir, "audio.mp3");

  try {
    const media = await prepareMediaFromRequest(input, mediaUrl);
    const selectedModel = resolveRequestedModel(model);

    await downloadToFile(media.mediaUrl, videoPath);
    const sourceProbe = await probeMedia(videoPath);
    const sourceMeta = sourceProbe.format || {};
    const hasAudioStream = (sourceProbe.streams || []).some((stream) => stream.codec_type === "audio");

    if (!hasAudioStream) {
      return res.status(422).json({
        ok: false,
        error: "视频里没有可提取的音轨，当前无法转文字。",
        meta: {
          mediaUrl: media.mediaUrl,
          sourceDurationSec: Number(sourceMeta.duration || 0)
        }
      });
    }

    await extractAudio(videoPath, audioPath);
    const audioProbe = await probeMedia(audioPath);
    const audioMeta = audioProbe.format || {};
    const transcription = await transcribeWithLocalWhisper(audioPath, selectedModel);
    const noteForAnalytics = {
      ...media,
      transcript: transcription.transcript,
      rawMetrics: media.rawMetrics,
      commentSamples: media.commentSamples
    };
    const analytics = buildXhsAnalytics(noteForAnalytics);
    const historyEntry = await appendHistoryRecord({
      input: cleanText(input || ""),
      title: media.title || "",
      author: media.author || "",
      noteText: media.noteText || media.description || "",
      finalUrl: media.finalUrl || "",
      mediaUrl: media.mediaUrl || "",
      cover: media.cover || "",
      sourceType: media.sourceType,
      parserMode: media.parserMode || "direct-media",
      audioDurationSec: Number(audioMeta.duration || 0),
      transcript: transcription.transcript,
      model: transcription.model,
      provider: transcription.provider,
      rawMetrics: media.rawMetrics,
      commentSamples: media.commentSamples || [],
      analytics,
      analyticsSummary: analytics.summary.join(" "),
      likeCount: media.rawMetrics?.likeCount ?? null,
      collectCount: media.rawMetrics?.collectCount ?? null,
      commentCount: media.rawMetrics?.commentCount ?? null,
      shareCount: media.rawMetrics?.shareCount ?? null,
      viewCount: media.rawMetrics?.viewCount ?? null
    });

    try {
      await appendTitleRecord(historyEntry);
    } catch (titleError) {
      console.error("标题库写入失败（不影响转写结果）：", titleError.message);
    }

    return res.json({
      ok: true,
      sourceType: media.sourceType,
      finalUrl: media.finalUrl,
      noteId: media.noteId,
      title: media.title,
      author: media.author || "",
      noteText: media.noteText || media.description || "",
      cover: media.cover,
      mediaUrl: media.mediaUrl,
      videoCandidates: media.videoCandidates || [media.mediaUrl],
      parserMode: media.parserMode || "direct-media",
      rawMetrics: media.rawMetrics,
      commentSamples: media.commentSamples || [],
      dataAvailability: media.dataAvailability,
      sourceDurationSec: Number(sourceMeta.duration || 0),
      audioDurationSec: Number(audioMeta.duration || 0),
      transcript: transcription.transcript,
      provider: transcription.provider,
      model: transcription.model,
      language: transcription.language || "",
      segmentCount: transcription.segmentCount || 0,
      warning: transcription.warning,
      analytics,
      historyEntry,
      hints: [
        transcription.provider === "faster-whisper"
          ? "已完成视频下载、抽音频和本地 faster-whisper 转写。首次运行如果要下载模型，会慢一些。"
          : "已完成视频下载和抽音频；请确认 .venv 和 faster-whisper 已安装完成。",
        `当前档位：${MODEL_OPTIONS[selectedModel]?.label || selectedModel}。本地转写不依赖外部 API 余额，但会占用本机 CPU / 内存。模型越大，效果通常越好，速度也越慢。`
      ]
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "转写失败。",
      meta: error.meta || null
    });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

app.post("/api/xhs/analyze", async (req, res) => {
  const {
    input,
    title = "",
    author = "",
    noteText = "",
    description = "",
    cover = "",
    finalUrl = "",
    transcript = "",
    rawMetrics = null,
    commentSamples = []
  } = req.body || {};

  try {
    let note = null;

    if (input && typeof input === "string") {
      try {
        note = await resolveXhsNoteFromInput(input);
      } catch (error) {
        if (error.payload) {
          note = error.payload;
        } else {
          throw error;
        }
      }
    }

    const mergedRawMetrics = mergeRawMetrics(rawMetrics, note?.rawMetrics);
    const mergedCommentSamples = unique([...(commentSamples || []), ...(note?.commentSamples || [])]).slice(0, 5);
    const mergedNote = {
      title: title || note?.title || "",
      author: author || note?.author || "",
      noteText: noteText || note?.noteText || "",
      description: description || note?.description || "",
      cover: cover || note?.cover || "",
      finalUrl: finalUrl || note?.finalUrl || "",
      transcript: transcript || "",
      rawMetrics: mergedRawMetrics,
      commentSamples: mergedCommentSamples
    };
    const analytics = buildXhsAnalytics(mergedNote);

    return res.json({
      ok: true,
      note: mergedNote,
      analytics,
      rawMetrics: mergedRawMetrics,
      dataAvailability: buildDataAvailability(mergedRawMetrics, mergedCommentSamples)
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "小红书数据分析失败。",
      meta: error.meta || null
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/history", async (_req, res) => {
  const history = await readHistory();
  res.json({
    ok: true,
    items: history
  });
});

app.delete("/api/history", async (_req, res) => {
  await writeHistory([]);
  res.json({ ok: true });
});

app.delete("/api/history/:id", async (req, res) => {
  const history = await readHistory();
  const nextItems = history.filter((item) => item.id !== req.params.id);

  if (nextItems.length === history.length) {
    return res.status(404).json({
      ok: false,
      error: "没有找到这条历史记录。"
    });
  }

  await writeHistory(nextItems);
  res.json({
    ok: true,
    items: nextItems
  });
});

app.get("/api/config-status", async (_req, res) => {
  res.json({
    ok: true,
    hasXhsCookie: Boolean(XHS_COOKIE),
    hasChrome: hasBrowserSupport(),
    hasLocalWhisper: fs.existsSync(PYTHON_BIN),
    localPythonPath: PYTHON_BIN,
    chromeExecutablePath: CHROME_EXECUTABLE_PATH,
    transcribeModel: TRANSCRIBE_MODEL,
    modelOptions: MODEL_OPTIONS
  });
});

app.get("/api/titles", async (_req, res) => {
  const items = await readTitleLibrary();
  const byFormula = {};
  for (const item of items) {
    const key = String(item.formulaId ?? 0);
    byFormula[key] = (byFormula[key] || 0) + 1;
  }
  res.json({ ok: true, items, stats: { total: items.length, byFormula } });
});

app.post("/api/titles/sync", async (_req, res) => {
  const history = await readHistory();
  const existing = await readTitleLibrary();
  const existingMap = new Map(existing.map((item) => [item.id, item]));
  let added = 0;
  let updated = 0;

  for (const entry of history) {
    if (!entry.title) continue;
    const { formulaId, formulaName } = classifyTitle(entry.title);
    const contentTypes = detectContentTypes(
      [entry.title, entry.noteText || "", entry.transcript || ""].join("\n")
    );
    const record = {
      id: entry.id,
      title: entry.title,
      formulaId,
      formulaName,
      contentTypes,
      rawMetrics: {
        likeCount: entry.rawMetrics?.likeCount ?? null,
        collectCount: entry.rawMetrics?.collectCount ?? null,
        commentCount: entry.rawMetrics?.commentCount ?? null
      },
      finalUrl: entry.finalUrl || "",
      savedAt: entry.createdAt || new Date().toISOString(),
      source: "history"
    };

    if (existingMap.has(entry.id)) {
      const prev = existingMap.get(entry.id);
      if (prev.formulaId !== formulaId) {
        existingMap.set(entry.id, record);
        updated++;
      }
    } else {
      existingMap.set(entry.id, record);
      added++;
    }
  }

  const merged = Array.from(existingMap.values());
  await writeTitleLibrary(merged);
  const byFormula = {};
  for (const item of merged) {
    const key = String(item.formulaId ?? 0);
    byFormula[key] = (byFormula[key] || 0) + 1;
  }
  res.json({ ok: true, added, updated, total: merged.length, items: merged, stats: { total: merged.length, byFormula } });
});

async function resolveCreatorPage(url) {
  if (!hasBrowserSupport()) {
    throw new Error(`未找到 Chrome 可执行文件：${CHROME_EXECUTABLE_PATH}`);
  }

  // 从 URL 中提取 userId
  const userIdMatch = url.match(/user\/profile\/([a-f0-9]+)/i);
  if (!userIdMatch) {
    throw new Error("无法从链接中提取博主 ID，请使用 https://www.xiaohongshu.com/user/profile/... 格式的链接");
  }
  const userId = userIdMatch[1];

  const browser = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--lang=zh-CN,zh",
      "--window-size=1440,900",
      "--disable-web-security",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
      window.chrome = { runtime: {} };
    });
    await setCookiesFromHeader(page, XHS_COOKIE, ".xiaohongshu.com");

    // 拦截并捕获小红书接口响应
    const captured = { userInfo: null, notes: [] };

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      req.continue();
    });

    page.on("response", async (res) => {
      const resUrl = res.url();
      try {
        if (resUrl.includes("/api/sns/web/v1/user_info") || resUrl.includes("/api/sns/web/v2/user/me")) {
          const json = await res.json().catch(() => null);
          if (json?.data?.basic_info || json?.data?.user) {
            captured.userInfo = json.data;
          }
        }
        if (resUrl.includes("/api/sns/web/v1/user_posted")) {
          const json = await res.json().catch(() => null);
          if (json?.data?.notes && Array.isArray(json.data.notes)) {
            captured.notes.push(...json.data.notes);
          }
        }
      } catch (_) {}
    });

    const headers = {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: "https://www.xiaohongshu.com/"
    };
    if (XHS_COOKIE) headers.cookie = XHS_COOKIE;
    await page.setExtraHTTPHeaders(headers);

    // 先访问首页建立会话，再跳转博主页
    try {
      await page.goto("https://www.xiaohongshu.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
      await sleep(1500);
    } catch (_) {}

    // 构造干净的博主页 URL（去掉 xsec_token 等参数避免验证失败）
    const cleanUrl = `https://www.xiaohongshu.com/user/profile/${userId}`;
    try {
      await page.goto(cleanUrl, { waitUntil: "networkidle2", timeout: 35000 });
    } catch (e) {
      if (!e.message.includes("Navigation timeout") && !e.message.includes("net::ERR_ABORTED")) {
        throw new Error(`无法打开博主页面：${e.message}。请检查 Cookie 是否已过期（在小红书网页版登录后重新复制 Cookie）。`);
      }
    }
    await sleep(4000);
    const finalPageUrl = page.url();
    const domCreatorInfo = await page.evaluate(() => {
      function parseCount(text) {
        if (!text) return null;
        const t = text.replace(/,/g, "").trim();
        const m = t.match(/(\d+(?:\.\d+)?)(万|w|W)?/);
        if (!m) return null;
        const base = Number(m[1]);
        if (!Number.isFinite(base)) return null;
        if (m[2] === "万" || m[2] === "w" || m[2] === "W") return Math.round(base * 10000);
        return Math.round(base);
      }

      function extractNearNumber(text, keyword) {
        const patterns = [
          new RegExp(`([\\d.,]+(?:万|w|W)?)\\s*${keyword}`),
          new RegExp(`${keyword}\\s*([\\d.,]+(?:万|w|W)?)`)
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) return match[1];
        }
        return null;
      }

      function queryText(selectors) {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el?.textContent?.trim()) return el.textContent.trim();
        }
        return "";
      }

      function queryAttr(selectors, attr) {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el?.getAttribute(attr)) return el.getAttribute(attr);
        }
        return "";
      }

      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ");
      return {
        nickname: queryText([
          ".user-name", ".username", "[class*='user-name']", "[class*='username']",
          "[class*='nickname']", "h1", ".info-nickname"
        ]),
        avatar: queryAttr([
          "img.avatar", "img[class*='avatar']", ".user-avatar img", "[class*='user'] img:first-child"
        ], "src"),
        fans: parseCount(extractNearNumber(bodyText, "粉丝")),
        likeCollect: parseCount(
          extractNearNumber(bodyText, "获赞与收藏") ||
          extractNearNumber(bodyText, "获赞和收藏") ||
          extractNearNumber(bodyText, "获赞")
        ),
        noteCount: parseCount(
          extractNearNumber(bodyText, "笔记") ||
          extractNearNumber(bodyText, "作品")
        )
      };
    });

    // 尝试从拦截的接口数据构建结果
    if (captured.userInfo || captured.notes.length > 0) {
      const basic = captured.userInfo?.basic_info || captured.userInfo?.user || {};
      const interactions = captured.userInfo?.interactions || [];
      const fansObj = interactions.find((i) => i.type === "fans");
      const likeObj = interactions.find((i) => i.type === "liked");

      function parseApiCount(val) {
        if (val == null) return null;
        if (typeof val === "number") return val;
        const s = String(val).replace(/,/g, "").trim();
        const m = s.match(/(\d+(?:\.\d+)?)(万|w|W)?/);
        if (!m) return null;
        const base = Number(m[1]);
        if (!Number.isFinite(base)) return null;
        if (m[2]) return Math.round(base * 10000);
        return Math.round(base);
      }

      const notes = captured.notes.slice(0, 12).map((n, i) => {
        const title = simplifyChineseText(cleanText(n.display_title || n.title || n.note_card?.display_title || ""));
        const cover = n.cover?.url_default || n.cover?.url || n.note_card?.cover?.url_default || "";
        const likeCount = parseApiCount(n.interact_info?.liked_count ?? n.note_card?.interact_info?.liked_count);
        const contentTypes = detectContentTypes(title);
        const formula = classifyTitle(title);
        return { rank: i + 1, title, cover, likeCount, contentTypes, formula };
      }).filter((n) => n.title.length > 0);

      const contentTypeDistribution = {};
      const formulaDistribution = {};
      for (const note of notes) {
        for (const ct of note.contentTypes) {
          contentTypeDistribution[ct] = (contentTypeDistribution[ct] || 0) + 1;
        }
        const fk = String(note.formula.formulaId);
        formulaDistribution[fk] = (formulaDistribution[fk] || 0) + 1;
      }

      return {
        ok: true,
        source: "api",
        creator: {
          nickname: simplifyChineseText(cleanText(basic.nickname || basic.name || domCreatorInfo.nickname || "")),
          avatar: basic.images || basic.avatar || domCreatorInfo.avatar || "",
          fans: parseApiCount(fansObj?.count) ?? domCreatorInfo.fans,
          totalLikeAndCollect: parseApiCount(likeObj?.count) ?? domCreatorInfo.likeCollect,
          noteCount: parseApiCount(captured.userInfo?.tab_public?.collection_count ?? null) ?? domCreatorInfo.noteCount
        },
        notes,
        analysis: { contentTypeDistribution, formulaDistribution }
      };
    }

    if (/\/login\b/i.test(finalPageUrl)) {
      throw new Error("当前打开的是小红书登录页，说明 XHS_COOKIE 没有生效或已经过期，请在 Chrome 里重新登录小红书后更新 .env 里的 XHS_COOKIE。");
    }

    // fallback：DOM 解析
    const data = await page.evaluate(() => {
      function parseCount(text) {
        if (!text) return null;
        const t = text.replace(/,/g, "").trim();
        const m = t.match(/(\d+(?:\.\d+)?)(万|w|W)?/);
        if (!m) return null;
        const base = Number(m[1]);
        if (!Number.isFinite(base)) return null;
        if (m[2] === "万" || m[2] === "w" || m[2] === "W") return Math.round(base * 10000);
        return Math.round(base);
      }

      function extractNearNumber(text, keyword) {
        const patterns = [
          new RegExp(`([\\d.,]+(?:万|w|W)?)\\s*${keyword}`),
          new RegExp(`${keyword}\\s*([\\d.,]+(?:万|w|W)?)`)
        ];
        for (const p of patterns) { const m = text.match(p); if (m) return m[1]; }
        return null;
      }

      // 尝试从 window.__INITIAL_STATE__ 或 nuxt store 提取
      let storeData = null;
      try {
        const state = window.__INITIAL_STATE__ || window.__NUXT__?.state;
        if (state) storeData = JSON.stringify(state).substring(0, 50000);
      } catch (_) {}

      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ");

      // 选择器 fallback — 遍历多个候选
      function queryText(sels) {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el?.textContent?.trim()) return el.textContent.trim();
        }
        return "";
      }
      function queryAttr(sels, attr) {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el?.getAttribute(attr)) return el.getAttribute(attr);
        }
        return "";
      }

      const nickname = queryText([
        ".user-name", ".username", "[class*='user-name']", "[class*='username']",
        "[class*='nickname']", "h1", ".info-nickname"
      ]);
      const avatar = queryAttr([
        "img.avatar", "img[class*='avatar']", ".user-avatar img", "[class*='user'] img:first-child"
      ], "src");

      const fans = parseCount(extractNearNumber(bodyText, "粉丝"));
      const likeCollect = parseCount(
        extractNearNumber(bodyText, "获赞与收藏") ||
        extractNearNumber(bodyText, "获赞和收藏") ||
        extractNearNumber(bodyText, "获赞")
      );
      const noteCount = parseCount(
        extractNearNumber(bodyText, "笔记") ||
        extractNearNumber(bodyText, "作品")
      );

      // 笔记列表：遍历更多选择器
      const noteSels = [
        "[class*='note-item']", "[class*='noteItem']", "[class*='feed-item']",
        "[class*='feedItem']", "[class*='note-card']", "[class*='noteCard']",
        "section[class*='note']", "li[class*='note']", "a[href*='/explore/']",
        "a[href*='/discovery/item/']"
      ];
      let noteItems = [];
      for (const sel of noteSels) {
        const items = Array.from(document.querySelectorAll(sel));
        if (items.length >= 3) { noteItems = items; break; }
      }

      const notes = noteItems.slice(0, 12).map((el) => {
        const titleEl = el.querySelector("[class*='title'], [class*='desc'], span:not(:empty), p:not(:empty)");
        const imgEl = el.querySelector("img");
        const likeEl = el.querySelector("[class*='like'], [class*='count'], [class*='interact']");
        return {
          title: titleEl?.textContent?.trim() || "",
          cover: imgEl?.getAttribute("src") || "",
          likeRaw: likeEl?.textContent?.trim() || ""
        };
      }).filter((n) => n.title.length > 1);

      return { nickname, avatar, fans, likeCollect, noteCount, notes, storeData };
    });

    // 尝试从 window state 中补充数据
    if (data.storeData) {
      try {
        const raw = JSON.parse(data.storeData);
        const userNode = raw?.user?.userPageData || raw?.userStore?.userInfo || {};
        if (!data.nickname && userNode.basicInfo?.nickname) {
          data.nickname = userNode.basicInfo.nickname;
        }
        if (!data.avatar && userNode.basicInfo?.images) {
          data.avatar = userNode.basicInfo.images;
        }
      } catch (_) {}
    }

    const notes = data.notes.map((n, i) => {
      const t = (n.likeRaw || "").replace(/,/g, "").trim();
      const m = t.match(/(\d+(?:\.\d+)?)(万|w|W)?/);
      const likeCount = m ? (m[2] ? Math.round(Number(m[1]) * 10000) : Math.round(Number(m[1]))) : null;
      const title = simplifyChineseText(cleanText(n.title));
      const contentTypes = detectContentTypes(title);
      const formula = classifyTitle(title);
      return { rank: i + 1, title, cover: n.cover, likeCount, contentTypes, formula };
    });

    const contentTypeDistribution = {};
    const formulaDistribution = {};
    for (const note of notes) {
      for (const ct of note.contentTypes) {
        contentTypeDistribution[ct] = (contentTypeDistribution[ct] || 0) + 1;
      }
      const fk = String(note.formula.formulaId);
      formulaDistribution[fk] = (formulaDistribution[fk] || 0) + 1;
    }

    const hasCreatorIdentity = Boolean(data.nickname || data.avatar || data.fans || data.likeCollect || data.noteCount);
    if (!notes.length && !hasCreatorIdentity) {
      throw new Error("没有抓到博主主页数据，通常是因为小红书要求登录或页面结构发生变化。请先更新 XHS_COOKIE 后再试。");
    }

    return {
      ok: true,
      source: "dom",
      creator: {
        nickname: simplifyChineseText(cleanText(data.nickname)),
        avatar: data.avatar || "",
        fans: data.fans,
        totalLikeAndCollect: data.likeCollect,
        noteCount: data.noteCount
      },
      notes,
      analysis: { contentTypeDistribution, formulaDistribution }
    };
  } finally {
    await browser.close();
  }
}

app.post("/api/xhs/creator", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "请输入博主主页链接。" });
  }

  try {
    const result = await resolveCreatorPage(url);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "博主数据分析失败，请检查链接或 Chrome 配置。"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
