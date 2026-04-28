require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const { Readable } = require("stream");
const { spawn } = require("child_process");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer-core");

const app = express();
const PORT = process.env.PORT || 3000;
const TRANSCRIBE_MODEL = process.env.FASTER_WHISPER_MODEL || "base";
const PYTHON_BIN = process.env.FASTER_WHISPER_PYTHON || path.join(__dirname, ".venv/bin/python");
const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const XHS_COOKIE = process.env.XHS_COOKIE || "";
const X_COOKIE = process.env.X_COOKIE || "";
const X_COOKIE_FILE = process.env.X_COOKIE_FILE || "";
const YT_DLP_BIN = process.env.YT_DLP_BIN || "yt-dlp";
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

  return {
    noteId,
    title,
    author,
    description,
    noteText,
    cover: image,
    finalUrl,
    jsonDetected,
    videoCandidates
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

function buildXHints({ parserMode, hasCookie, hasYtDlp, hasDownloadUrl }) {
  const hints = [];
  if (parserMode === "browser") {
    hints.push("本次通过浏览器抓取解析 X 页面。");
  }
  if (parserMode === "yt-dlp") {
    hints.push("本次通过 yt-dlp 兜底解析 X 视频。");
  }
  if (!hasCookie) {
    hints.push("当前没有配置 X 登录态，受限内容可能无法解析。");
  }
  if (!hasYtDlp) {
    hints.push("当前环境没有安装 yt-dlp，浏览器抓取失败时将少一层兜底。");
  }
  if (!hasDownloadUrl) {
    hints.push("当前未拿到稳定下载地址。");
  }
  return hints;
}

function extractXStatusId(url) {
  const patterns = [
    /x\.com\/[^/]+\/status\/(\d+)/i,
    /twitter\.com\/[^/]+\/status\/(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function isXUrl(url) {
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(url);
}

async function hasYtDlpSupport() {
  try {
    await runCommand(YT_DLP_BIN, ["--version"]);
    return true;
  } catch (_error) {
    return false;
  }
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

  const browser = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--lang=zh-CN",
      "--window-size=430,932"
    ]
  });

  const collected = new Set();
  let finalUrl = "";
  let title = "";
  let cover = "";
  let noteId = "";

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
        coverCandidates
      };
    });

    finalUrl = page.url();
    title = domData.title || "";
    cover = pickBestCover(domData.coverCandidates || []);
    noteId = extractNoteIdFromUrl(finalUrl) || "";

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
      videoCandidates: unique([...collected])
    };
  } finally {
    await browser.close();
  }
}

async function resolveXWithBrowser(url) {
  if (!hasBrowserSupport()) {
    return {
      ok: false,
      parserMode: "browser",
      error: `未找到 Chrome 可执行文件：${CHROME_EXECUTABLE_PATH}`
    };
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--lang=en-US",
      "--window-size=1440,900"
    ]
  });

  const mediaCandidates = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9",
      referer: "https://x.com/"
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false
      });
    });

    if (X_COOKIE) {
      await page.setExtraHTTPHeaders({
        "accept-language": "en-US,en;q=0.9",
        referer: "https://x.com/",
        cookie: X_COOKIE
      });
    }

    page.on("response", async (response) => {
      try {
        const responseUrl = response.url();
        const contentType = response.headers()["content-type"] || "";
        if (
          looksLikeMediaUrl(responseUrl) ||
          /video|mpegurl|mp4|application\/octet-stream/i.test(contentType)
        ) {
          mediaCandidates.add(responseUrl);
        }
      } catch (_error) {}
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await sleep(3000);

    const domData = await page.evaluate(() => {
      const getMeta = (selector) => document.querySelector(selector)?.getAttribute("content") || "";
      const textCandidates = [];
      const authorCandidates = [];
      const mediaCandidates = [];

      document.querySelectorAll("video, source").forEach((element) => {
        const src = element.getAttribute("src");
        if (src) mediaCandidates.push(src);
        if (element.currentSrc) mediaCandidates.push(element.currentSrc);
      });

      document.querySelectorAll("[data-testid='tweetText']").forEach((node) => {
        const value = (node.textContent || "").trim();
        if (value) textCandidates.push(value);
      });

      document.querySelectorAll("[data-testid='User-Name']").forEach((node) => {
        const value = (node.textContent || "").trim();
        if (value) authorCandidates.push(value);
      });

      return {
        title: document.title || "",
        description: getMeta('meta[property="og:description"]') || getMeta('meta[name="description"]'),
        author: getMeta('meta[name="twitter:title"]'),
        cover: getMeta('meta[property="og:image"]') || getMeta('meta[name="twitter:image"]'),
        text: textCandidates.join("\n"),
        authorCandidates,
        mediaCandidates
      };
    });

    const browserUrl = page.url();
    const statusId = extractXStatusId(browserUrl);
    domData.mediaCandidates
      .map(decodeEscapedUrl)
      .filter(looksLikeMediaUrl)
      .forEach((item) => mediaCandidates.add(item));

    const bestDownloadUrl = unique([...mediaCandidates])[0] || "";
    const author =
      cleanText(domData.authorCandidates[0]) ||
      cleanText(domData.author).replace(/\s*on X:?/i, "").trim();
    const text = cleanText(domData.text) || cleanText(domData.description);
    const cover = looksLikeImageUrl(domData.cover) ? domData.cover : "";
    const title = cleanText(domData.title).replace(/\s*\/ X$/i, "").trim();

    if (!statusId || !bestDownloadUrl) {
      return {
        ok: false,
        parserMode: "browser",
        requiresAuth: /login|sign in/i.test(browserUrl),
        error: "浏览器抓取未拿到稳定视频地址。",
        finalUrl: browserUrl,
        title,
        author,
        text,
        cover
      };
    }

    return {
      ok: true,
      parserMode: "browser",
      statusId,
      finalUrl: browserUrl,
      title,
      author,
      text,
      cover,
      durationSec: 0,
      formats: [],
      downloadUrl: bestDownloadUrl,
      requiresAuth: false
    };
  } finally {
    await browser.close();
  }
}

async function createTempCookieFileFromHeader(cookieHeader) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "x-cookie-"));
  const cookiePath = path.join(tempDir, "cookies.txt");
  const rows = ["# Netscape HTTP Cookie File"];
  const pairs = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf("=");
      return idx === -1 ? null : [part.slice(0, idx), part.slice(idx + 1)];
    })
    .filter(Boolean);

  for (const [name, value] of pairs) {
    rows.push([`.x.com`, "TRUE", "/", "FALSE", "2147483647", name, value].join("\t"));
    rows.push([`.twitter.com`, "TRUE", "/", "FALSE", "2147483647", name, value].join("\t"));
  }

  await fsp.writeFile(cookiePath, `${rows.join("\n")}\n`, "utf8");
  return { tempDir, cookiePath };
}

function pickBestXFormat(formats) {
  const candidates = (formats || []).filter(
    (format) => format && format.url && (format.ext === "mp4" || looksLikeMediaUrl(format.url))
  );
  candidates.sort((a, b) => (b.height || 0) - (a.height || 0));
  return candidates[0] || null;
}

function summarizeFormats(formats) {
  return (formats || [])
    .filter((format) => format && format.url)
    .map((format) => ({
      formatId: format.format_id || "",
      ext: format.ext || "",
      width: format.width || 0,
      height: format.height || 0,
      fps: format.fps || 0,
      filesize: format.filesize || 0,
      formatNote: format.format_note || ""
    }))
    .filter((format) => format.ext || format.height || format.formatNote)
    .slice(0, 8);
}

function parseYtDlpEntries(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function pickBestYtDlpEntry(entries) {
  const videos = entries
    .map((entry) => ({
      entry,
      bestFormat: pickBestXFormat(entry.formats || [])
    }))
    .filter((item) => item.bestFormat);

  videos.sort((a, b) => (b.bestFormat.height || 0) - (a.bestFormat.height || 0));
  return videos[0] || null;
}

async function resolveXWithYtDlp(url) {
  const hasBinary = await hasYtDlpSupport();
  if (!hasBinary) {
    return {
      ok: false,
      parserMode: "yt-dlp",
      error: "当前环境没有安装 yt-dlp。"
    };
  }

  let cleanup = null;
  const args = ["--dump-json", "--no-playlist", url];

  if (X_COOKIE_FILE) {
    args.unshift(X_COOKIE_FILE);
    args.unshift("--cookies");
  } else if (X_COOKIE) {
    cleanup = await createTempCookieFileFromHeader(X_COOKIE);
    args.unshift(cleanup.cookiePath);
    args.unshift("--cookies");
  }

  try {
    const { stdout } = await runCommand(YT_DLP_BIN, args);
    const entries = parseYtDlpEntries(stdout);
    const selected = pickBestYtDlpEntry(entries);

    if (!selected) {
      return {
        ok: false,
        parserMode: "yt-dlp",
        requiresAuth: /login|private|not available/i.test(stdout),
        error: "yt-dlp 未拿到稳定视频地址。"
      };
    }

    const parsed = selected.entry;
    const bestFormat = selected.bestFormat;
    const statusId = extractXStatusId(parsed.webpage_url || parsed.playlist_webpage_url || url);
    const author = cleanText(parsed.uploader || parsed.channel || parsed.uploader_id || "");
    const text = cleanText(parsed.description || parsed.fulltitle || parsed.title || "");
    const title = cleanText(parsed.title || parsed.fulltitle || "");
    const cover = looksLikeImageUrl(parsed.thumbnail || "") ? parsed.thumbnail : "";

    if (!statusId || !bestFormat?.url) {
      return {
        ok: false,
        parserMode: "yt-dlp",
        requiresAuth: /login|private|not available/i.test(stdout),
        error: "yt-dlp 未拿到稳定视频地址。",
        title,
        author,
        text,
        cover
      };
    }

    return {
      ok: true,
      parserMode: "yt-dlp",
      statusId,
      finalUrl: parsed.webpage_url || url,
      title,
      author,
      text,
      cover,
      durationSec: Number(parsed.duration || 0),
      formats: summarizeFormats(parsed.formats),
      downloadUrl: bestFormat.url,
      requiresAuth: false
    };
  } catch (error) {
    const message = error.message || "yt-dlp 解析失败。";
    return {
      ok: false,
      parserMode: "yt-dlp",
      requiresAuth: /sign in|login|private|cookies/i.test(message),
      error: message
    };
  } finally {
    if (cleanup?.tempDir) {
      await fsp.rm(cleanup.tempDir, { recursive: true, force: true });
    }
  }
}

async function prepareXVideoFromRequest(input) {
  const url = extractFirstUrl(input || "");
  if (!url || !isXUrl(url)) {
    throw new Error("请输入有效的 X 视频链接。");
  }

  const browserResult = await resolveXWithBrowser(url);
  const ytDlpAvailable = await hasYtDlpSupport();
  const browserNeedsUpgrade =
    browserResult.ok &&
    (
      !browserResult.downloadUrl ||
      /\.m3u8(\?|$)/i.test(browserResult.downloadUrl) ||
      !browserResult.cover ||
      !browserResult.durationSec
    );

  if (browserNeedsUpgrade && ytDlpAvailable) {
    const ytDlpPreferred = await resolveXWithYtDlp(url);
    if (ytDlpPreferred.ok) {
      return {
        ok: true,
        ...ytDlpPreferred,
        hints: buildXHints({
          parserMode: "yt-dlp",
          hasCookie: Boolean(X_COOKIE || X_COOKIE_FILE),
          hasYtDlp: true,
          hasDownloadUrl: Boolean(ytDlpPreferred.downloadUrl)
        })
      };
    }
  }

  if (browserResult.ok) {
    return {
      ok: true,
      ...browserResult,
      hints: buildXHints({
        parserMode: "browser",
        hasCookie: Boolean(X_COOKIE || X_COOKIE_FILE),
        hasYtDlp: ytDlpAvailable,
        hasDownloadUrl: Boolean(browserResult.downloadUrl)
      })
    };
  }

  const ytDlpResult = await resolveXWithYtDlp(url);
  if (ytDlpResult.ok) {
    return {
      ok: true,
      ...ytDlpResult,
      hints: buildXHints({
        parserMode: "yt-dlp",
        hasCookie: Boolean(X_COOKIE || X_COOKIE_FILE),
        hasYtDlp: true,
        hasDownloadUrl: Boolean(ytDlpResult.downloadUrl)
      })
    };
  }

  const hasPartialBrowserData = Boolean(
    browserResult.title || browserResult.author || browserResult.text || browserResult.cover
  );
  if (hasPartialBrowserData) {
    return {
      ok: true,
      parserMode: browserResult.parserMode,
      statusId: browserResult.statusId || extractXStatusId(browserResult.finalUrl || url),
      finalUrl: browserResult.finalUrl || url,
      title: browserResult.title || "",
      author: browserResult.author || "",
      text: browserResult.text || "",
      cover: browserResult.cover || "",
      durationSec: 0,
      formats: [],
      downloadUrl: "",
      requiresAuth: Boolean(browserResult.requiresAuth || ytDlpResult.requiresAuth),
      hints: buildXHints({
        parserMode: browserResult.parserMode,
        hasCookie: Boolean(X_COOKIE || X_COOKIE_FILE),
        hasYtDlp: ytDlpAvailable,
        hasDownloadUrl: false
      })
    };
  }

  const error = new Error(ytDlpResult.error || browserResult.error || "X 视频解析失败。");
  error.meta = {
    browser: browserResult,
    ytDlp: ytDlpResult,
    requiresAuth: Boolean(browserResult.requiresAuth || ytDlpResult.requiresAuth)
  };
  throw error;
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
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
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
    transcript: result.transcript || "",
    provider: "faster-whisper",
    model: result.model || modelName,
    language: result.language || "",
    warning: result.warning || "",
    segmentCount: result.segment_count || 1
  };
}

async function prepareMediaFromRequest(input, mediaUrl) {
  if (mediaUrl) {
    return {
      sourceType: "direct-media",
      finalUrl: "",
      noteId: "",
      title: "",
      cover: "",
      mediaUrl
    };
  }

  const url = extractFirstUrl(input || "");
  if (!url) {
    throw new Error("没有识别到有效链接。");
  }

  const { finalUrl, status, html } = await resolveRedirect(url);
  const parsed = parseHtml(html, finalUrl);
  const htmlSucceeded = isResolvableNotePage(finalUrl) && parsed.noteId && parsed.videoCandidates.length;

  if (htmlSucceeded) {
    return {
      sourceType: "xiaohongshu-note",
      finalUrl,
      noteId: parsed.noteId,
      title: parsed.title,
      cover: parsed.cover,
      mediaUrl: parsed.videoCandidates[0],
      videoCandidates: parsed.videoCandidates,
      parserMode: "html"
    };
  }

  const browserResult = await resolveMediaWithBrowser(url);

  if (browserResult.videoCandidates.length && browserResult.noteId) {
    return {
      sourceType: "xiaohongshu-note",
      finalUrl: browserResult.finalUrl,
      noteId: browserResult.noteId,
      title: browserResult.title || parsed.title,
      cover: browserResult.cover || parsed.cover,
      mediaUrl: browserResult.videoCandidates[0],
      videoCandidates: browserResult.videoCandidates,
      parserMode: "browser"
    };
  }

  const failureMessage = !isResolvableNotePage(finalUrl) || !parsed.noteId
    ? "短链没有稳定落到具体笔记页，当前版本暂时无法继续解析。"
    : "笔记页已打开，但没有识别到视频资源，可能这是图文笔记、私密笔记，或页面结构发生了变化。";
  const error = new Error(failureMessage);
  error.meta = {
    finalUrl,
    status,
    parsed: {
      noteId: parsed.noteId,
      title: parsed.title,
      candidateCount: parsed.videoCandidates.length
    },
    browser: browserResult
  };
  throw error;
}

app.post("/api/parse", async (req, res) => {
  const { input } = req.body || {};
  if (!input || typeof input !== "string") {
    return res.status(400).json({ ok: false, error: "请输入小红书分享文案或链接。" });
  }

  const url = extractFirstUrl(input);
  if (!url) {
    return res.status(400).json({ ok: false, error: "没有识别到有效链接。" });
  }

  try {
    const { finalUrl, status, html } = await resolveRedirect(url);
    const parsed = parseHtml(html, finalUrl);
    const htmlSucceeded = isResolvableNotePage(finalUrl) && parsed.noteId && parsed.videoCandidates.length;

    if (htmlSucceeded) {
      return res.json({
        ok: true,
        inputUrl: url,
        httpStatus: status,
        ...parsed,
        parserMode: "html",
        hints: buildMediaHints({
          usedBrowser: false,
          hasCookie: Boolean(XHS_COOKIE),
          videoCandidates: parsed.videoCandidates
        })
      });
    }

    const browserResult = await resolveMediaWithBrowser(url);
    if (browserResult.videoCandidates.length && browserResult.noteId) {
      return res.json({
        ok: true,
        inputUrl: url,
        httpStatus: status,
        noteId: browserResult.noteId,
        title: browserResult.title || parsed.title,
        author: parsed.author,
        description: parsed.description,
        noteText: parsed.noteText,
        cover: browserResult.cover || parsed.cover,
        finalUrl: browserResult.finalUrl,
        jsonDetected: parsed.jsonDetected,
        videoCandidates: browserResult.videoCandidates,
        parserMode: "browser",
        hints: buildMediaHints({
          usedBrowser: true,
          hasCookie: Boolean(XHS_COOKIE),
          videoCandidates: browserResult.videoCandidates
        })
      });
    }

    return res.status(422).json({
      ok: false,
      error: "HTML 解析和浏览器兜底都没拿到稳定视频资源。",
      inputUrl: url,
      finalUrl,
      httpStatus: status,
      parserMode: "failed",
      browser: browserResult,
      hints: [
        "这通常说明该笔记需要登录态、命中了风控，或者并不是公开视频笔记。",
        Boolean(XHS_COOKIE)
          ? "当前已经带了 XHS_COOKIE，但仍未拿到视频资源，下一步更可能需要人工登录态验证或更深的网络请求分析。"
          : "下一步优先建议配置 XHS_COOKIE，再次尝试浏览器兜底。"
      ]
    });
  } catch (error) {
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

    return res.json({
      ok: true,
      sourceType: media.sourceType,
      finalUrl: media.finalUrl,
      noteId: media.noteId,
      title: media.title,
      cover: media.cover,
      mediaUrl: media.mediaUrl,
      videoCandidates: media.videoCandidates || [media.mediaUrl],
      parserMode: media.parserMode || "direct-media",
      sourceDurationSec: Number(sourceMeta.duration || 0),
      audioDurationSec: Number(audioMeta.duration || 0),
      transcript: transcription.transcript,
      provider: transcription.provider,
      model: transcription.model,
      language: transcription.language || "",
      segmentCount: transcription.segmentCount || 0,
      warning: transcription.warning,
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

app.post("/api/x/parse", async (req, res) => {
  const { input } = req.body || {};
  if (!input || typeof input !== "string") {
    return res.status(400).json({ ok: false, error: "请输入 X 视频链接。" });
  }

  try {
    const result = await prepareXVideoFromRequest(input);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "X 视频解析失败。",
      meta: error.meta || null
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config-status", async (_req, res) => {
  res.json({
    ok: true,
    hasXhsCookie: Boolean(XHS_COOKIE),
    hasXCookie: Boolean(X_COOKIE || X_COOKIE_FILE),
    hasChrome: hasBrowserSupport(),
    hasLocalWhisper: fs.existsSync(PYTHON_BIN),
    hasYtDlp: await hasYtDlpSupport(),
    localPythonPath: PYTHON_BIN,
    chromeExecutablePath: CHROME_EXECUTABLE_PATH,
    ytDlpBin: YT_DLP_BIN,
    transcribeModel: TRANSCRIBE_MODEL,
    modelOptions: MODEL_OPTIONS
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
