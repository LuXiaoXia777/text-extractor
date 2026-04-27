const input = document.getElementById("input");
const mediaUrlInput = document.getElementById("mediaUrl");
const modelPreset = document.getElementById("modelPreset");
const modelHint = document.getElementById("modelHint");
const submit = document.getElementById("submit");
const transcribeButton = document.getElementById("transcribe");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const transcriptCard = document.getElementById("transcriptCard");
let configStatus = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setText(id, value) {
  document.getElementById(id).textContent = value || "-";
}

function renderResult(data) {
  resultEl.classList.remove("hidden");
  setText("noteId", data.noteId);
  setText("title", data.title);
  setText("author", data.author);
  setText("description", data.description);
  setText("httpStatus", String(data.httpStatus || "-"));
  setText("parserMode", data.parserMode || "-");
  setText("videoCount", String((data.videoCandidates || []).length));
  setText("jsonDetected", data.jsonDetected ? "是" : "否");
  setText("noteText", data.noteText || data.description || "没有抓到正文。");
  setText("videoCandidates", (data.videoCandidates || []).join("\n") || "没有识别到候选视频 URL。");

  const finalUrl = document.getElementById("finalUrl");
  finalUrl.href = data.finalUrl || data.inputUrl;
  finalUrl.textContent = data.finalUrl || data.inputUrl;

  const cover = document.getElementById("cover");
  if (data.cover) {
    cover.src = data.cover;
    cover.style.display = "block";
  } else {
    cover.removeAttribute("src");
    cover.style.display = "none";
  }

  const hints = document.getElementById("hints");
  hints.innerHTML = "";
  for (const hint of data.hints || []) {
    const li = document.createElement("li");
    li.textContent = hint;
    hints.appendChild(li);
  }
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
  setText("sourceType", data.sourceType);
  setText("usedModel", data.model || "-");
  setText("sourceDuration", formatDuration(data.sourceDurationSec));
  setText("audioDuration", formatDuration(data.audioDurationSec));
  setText("segmentCount", String(data.segmentCount || 0));
  setText("transcribeWarning", data.warning || "已成功转写。");
  setText("transcriptText", data.transcript || "当前没有文字稿。请先确认本地 faster-whisper 环境已安装完成。");
  setText(
    "providerInfo",
    data.provider === "faster-whisper" ? `${data.provider} · ${data.model}` : "仅完成抽音频"
  );
}

function refreshModelHint() {
  const value = modelPreset.value;
  const option = configStatus?.modelOptions?.[value];
  const isDefault = value === configStatus?.transcribeModel;
  modelHint.textContent = option
    ? `${option.label}：${option.description}${isDefault ? "。当前默认档位" : ""}`
    : "默认读取当前服务配置。";
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

submit.addEventListener("click", async () => {
  const value = input.value.trim();
  if (!value) {
    setStatus("先输入一段分享文案或链接。", true);
    return;
  }

  setStatus("正在解析小红书链接...");
  resultEl.classList.add("hidden");

  try {
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ input: value })
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "解析失败");
    }

    renderResult(data);
    setStatus("解析完成。这个版本先验证链路，结果不稳定是正常的。");
  } catch (error) {
    setStatus(error.message, true);
  }
});

modelPreset.addEventListener("change", refreshModelHint);

transcribeButton.addEventListener("click", async () => {
  const inputValue = input.value.trim();
  const mediaUrl = mediaUrlInput.value.trim();
  const selectedModel = modelPreset.value;

  if (!inputValue && !mediaUrl) {
    setStatus("请先输入小红书链接，或者直接填入视频直链。", true);
    return;
  }

  setStatus("正在下载媒体、抽音频并尝试转写...");
  transcriptCard.classList.add("hidden");

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: inputValue,
        mediaUrl,
        model: selectedModel
      })
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "转写失败");
    }

    renderTranscript(data);
    setStatus(data.warning || "转写完成。");
  } catch (error) {
    setStatus(error.message, true);
  }
});

loadConfigStatus();
