const tabXhs = document.getElementById("tabXhs");
const tabX = document.getElementById("tabX");
const xhsView = document.getElementById("xhsView");
const xView = document.getElementById("xView");

const input = document.getElementById("input");
const modelPreset = document.getElementById("modelPreset");
const modelHint = document.getElementById("modelHint");
const runAllButton = document.getElementById("runAll");
const copyTranscriptButton = document.getElementById("copyTranscript");
const retryParseButton = document.getElementById("retryParse");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const transcriptCard = document.getElementById("transcriptCard");

const xInput = document.getElementById("xInput");
const xStatusEl = document.getElementById("xStatus");
const xResultEl = document.getElementById("xResult");
const xCoverWrap = document.getElementById("xCoverWrap");
const xCover = document.getElementById("xCover");
const xDownloadButton = document.getElementById("xDownloadButton");

let configStatus = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setXStatus(message, isError = false) {
  xStatusEl.textContent = message;
  xStatusEl.classList.toggle("error", isError);
}

function setText(id, value) {
  document.getElementById(id).textContent = value || "-";
}

function setActiveTab(tabName) {
  const isXhs = tabName === "xhs";
  tabXhs.classList.toggle("active", isXhs);
  tabX.classList.toggle("active", !isXhs);
  xhsView.classList.toggle("hidden", !isXhs);
  xView.classList.toggle("hidden", isXhs);
}

function needsRetryParse(data) {
  const missingTitle = !data.title || data.title === "-";
  const missingAuthor = !data.author || data.author === "-";
  const noteText = data.noteText || data.description || "";
  const missingNoteText = !noteText || noteText === "没有抓到正文。";
  return missingTitle || missingAuthor || missingNoteText;
}

function syncRetryParseButton(shouldShow) {
  retryParseButton.classList.toggle("hidden", !shouldShow);
}

function renderResult(data) {
  resultEl.classList.remove("hidden");
  setText("title", data.title);
  setText("author", data.author);
  setText("noteText", data.noteText || data.description || "没有抓到正文。");
  syncRetryParseButton(needsRetryParse(data));
}

function formatDuration(value) {
  if (!value) return "-";
  const total = Math.round(value);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}分 ${sec}秒`;
}

function renderTranscript(data) {
  transcriptCard.classList.remove("hidden");
  setText("audioDuration", formatDuration(data.audioDurationSec));
  setText("transcriptText", data.transcript || "当前没有文字稿。请先确认本地 faster-whisper 环境已安装完成。");
}

function refreshModelHint() {
  const value = modelPreset.value;
  const option = configStatus?.modelOptions?.[value];
  const isDefault = value === configStatus?.transcribeModel;
  modelHint.textContent = option
    ? `${option.label}：${option.description}${isDefault ? "。当前默认档位" : ""}`
    : "默认读取当前服务配置。";
}

function summarizeFormats(formats) {
  if (!formats?.length) return "-";
  const first = formats.find((item) => item.height || item.ext) || formats[0];
  const parts = [];
  if (first.height) parts.push(`${first.height}p`);
  if (first.ext) parts.push(first.ext);
  if (first.formatNote) parts.push(first.formatNote);
  return parts.join(" · ") || "-";
}

function renderXResult(data) {
  xResultEl.classList.remove("hidden");
  setText("xAuthor", data.author);
  setText("xText", data.text);
  setText("xDuration", formatDuration(data.durationSec));
  setText("xFormats", summarizeFormats(data.formats));
  setText("xParserMode", data.parserMode || "-");
  setText("xHints", (data.hints || []).join("\n") || "无");

  if (data.cover) {
    xCover.src = data.cover;
    xCoverWrap.classList.remove("hidden");
  } else {
    xCover.removeAttribute("src");
    xCoverWrap.classList.add("hidden");
  }

  if (data.downloadUrl) {
    xDownloadButton.href = data.downloadUrl;
    xDownloadButton.classList.remove("hidden");
  } else {
    xDownloadButton.removeAttribute("href");
    xDownloadButton.classList.add("hidden");
  }
}

async function loadConfigStatus() {
  try {
    const response = await fetch("/api/config-status");
    const data = await response.json();
    if (!response.ok || !data.ok) return;
    configStatus = data;
    if (data.transcribeModel) {
      modelPreset.value = data.transcribeModel;
    }
    refreshModelHint();
  } catch (_error) {}
}

tabXhs.addEventListener("click", () => setActiveTab("xhs"));
tabX.addEventListener("click", () => setActiveTab("x"));
modelPreset.addEventListener("change", refreshModelHint);

runAllButton.addEventListener("click", async () => {
  const inputValue = input.value.trim();
  const selectedModel = modelPreset.value;

  if (!inputValue) {
    setStatus("请先输入小红书链接或分享文案。", true);
    return;
  }

  setStatus("正在解析小红书链接并转文字...");
  resultEl.classList.add("hidden");
  transcriptCard.classList.add("hidden");

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: inputValue,
        model: selectedModel
      })
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "转写失败");
    }

    renderResult(data);
    renderTranscript(data);
    setStatus(data.warning || "转写完成。");
  } catch (error) {
    setStatus(error.message, true);
  }
});

retryParseButton.addEventListener("click", async () => {
  const inputValue = input.value.trim();
  if (!inputValue) {
    setStatus("请先输入小红书链接或分享文案。", true);
    return;
  }

  setStatus("正在再次解析解析结果...");

  try {
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: inputValue
      })
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "再次解析失败");
    }

    renderResult(data);
    setStatus(needsRetryParse(data) ? "再次解析完成，但仍有部分内容未抓到。" : "再次解析完成。");
  } catch (error) {
    setStatus(error.message, true);
  }
});

copyTranscriptButton.addEventListener("click", async () => {
  const text = document.getElementById("transcriptText").textContent.trim();
  if (!text || text === "-" || text === "当前没有文字稿。请先确认本地 faster-whisper 环境已安装完成。") {
    setStatus("当前没有可复制的文字稿。", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus("文字稿已复制。");
  } catch (_error) {
    setStatus("复制失败，请手动选择文字稿复制。", true);
  }
});

document.getElementById("runXParse").addEventListener("click", async () => {
  const value = xInput.value.trim();
  if (!value) {
    setXStatus("请先输入 X 视频链接。", true);
    return;
  }

  setXStatus("正在解析 X 视频...");
  xResultEl.classList.add("hidden");

  try {
    const response = await fetch("/api/x/parse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ input: value })
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "X 视频解析失败");
    }

    renderXResult(data);
    setXStatus("X 视频解析完成。");
  } catch (error) {
    setXStatus(error.message, true);
  }
});

loadConfigStatus();
