const tabXhs = document.getElementById("tabXhs");
const tabX = document.getElementById("tabX");
const xhsView = document.getElementById("xhsView");
const xView = document.getElementById("xView");
const pageTitle = document.getElementById("pageTitle");

const input = document.getElementById("input");
const modelPreset = document.getElementById("modelPreset");
const modelHint = document.getElementById("modelHint");
const runAllButton = document.getElementById("runAll");
const copyTranscriptButton = document.getElementById("copyTranscript");
const showAnalyticsButton = document.getElementById("showAnalytics");
const retryParseButton = document.getElementById("retryParse");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const transcriptCard = document.getElementById("transcriptCard");
const historyDetailCard = document.getElementById("historyDetailCard");
const analyticsCard = document.getElementById("analyticsCard");
const historyDetailLink = document.getElementById("historyDetailLink");
const copyHistoryDetailButton = document.getElementById("copyHistoryDetail");
const deleteHistoryDetailButton = document.getElementById("deleteHistoryDetail");
const historyListEl = document.getElementById("historyList");
const refreshHistoryButton = document.getElementById("refreshHistory");
const clearHistoryButton = document.getElementById("clearHistory");
const toastEl = document.getElementById("toast");

const xInput = document.getElementById("xInput");
const xStatusEl = document.getElementById("xStatus");
const xResultEl = document.getElementById("xResult");
const xCoverWrap = document.getElementById("xCoverWrap");
const xCover = document.getElementById("xCover");
const xDownloadButton = document.getElementById("xDownloadButton");


let configStatus = null;
let toastTimer = null;
let historyItems = [];
let activeHistoryId = "";
let currentXhsResult = null;
let activeAnalyticsHistoryId = "";

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setXStatus(message, isError = false) {
  xStatusEl.textContent = message;
  xStatusEl.classList.toggle("error", isError);
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  toastEl.classList.toggle("error", isError);

  requestAnimationFrame(() => {
    toastEl.classList.add("visible");
  });

  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove("visible");
    toastTimer = window.setTimeout(() => {
      toastEl.classList.add("hidden");
    }, 220);
  }, 2200);
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
  pageTitle.textContent = isXhs ? "小红书视频转文字" : "X 视频下载";
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
  showAnalyticsButton.classList.toggle("hidden", !data.analytics && !data.transcript);
}

function hideAnalyticsCard() {
  analyticsCard.classList.add("hidden");
  activeAnalyticsHistoryId = "";
}

function clearHistoryDetail() {
  activeHistoryId = "";
  historyDetailCard.classList.add("hidden");
}

function renderHistoryDetail(item) {
  if (!item) {
    clearHistoryDetail();
    return;
  }

  activeHistoryId = item.id || "";
  historyDetailCard.classList.remove("hidden");
  setText("historyDetailTitle", item.title || "未命名内容");
  setText("historyDetailTime", formatDateTime(item.createdAt));
  setText("historyDetailDuration", formatDuration(item.audioDurationSec));
  setText("historyDetailModel", item.model || "-");
  setText("historyDetailTranscript", item.transcript || "当前没有文字稿。");

  if (item.finalUrl) {
    historyDetailLink.href = item.finalUrl;
    historyDetailLink.classList.remove("hidden");
  } else {
    historyDetailLink.removeAttribute("href");
    historyDetailLink.classList.add("hidden");
  }
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatCount(value) {
  if (value === 0) return "0";
  if (!Number.isFinite(value)) return "-";
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return `${value}`;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return "暂缺";
  return `${(value * 100).toFixed(1)}%`;
}

function renderList(id, items, fallback) {
  const el = document.getElementById(id);
  const list = items?.length ? items : [fallback];
  el.innerHTML = list.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderAnalytics(payload) {
  const analytics = payload?.analytics;
  const metrics = analytics?.metrics || payload?.rawMetrics || {};
  const ratios = analytics?.ratios || {};
  const diagnosis = analytics?.contentDiagnosis || {};
  const commentInsight = analytics?.commentInsight || {};

  analyticsCard.classList.remove("hidden");
  setText("analyticsLikeCount", formatCount(metrics.likeCount));
  setText("analyticsCollectCount", formatCount(metrics.collectCount));
  setText("analyticsCommentCount", formatCount(metrics.commentCount));
  setText("analyticsShareCount", formatCount(metrics.shareCount));
  setText("analyticsViewCount", formatCount(metrics.viewCount ?? metrics.exposureCount));
  setText("analyticsEngagementCount", formatCount(metrics.engagementCount));
  setText("analyticsEngagementRate", formatRatio(ratios.engagementRate));
  setText("analyticsCollectLikeRatio", formatRatio(ratios.collectLikeRatio));
  setText("analyticsCommentLikeRatio", formatRatio(ratios.commentLikeRatio));

  document.getElementById("analyticsContentTypes").innerHTML = (diagnosis.contentTypes?.length
    ? diagnosis.contentTypes
    : ["待判断"]).map((item) => `<span class="analytics-tag">${escapeHtml(item)}</span>`).join("");

  document.getElementById("analyticsTitleInsights").textContent = (diagnosis.titleInsights || []).join(" ");
  document.getElementById("analyticsCollectPotential").textContent = `收藏潜力：${diagnosis.collectPotential?.level || "-"}。${(diagnosis.collectPotential?.reasons || []).join(" ")}`;
  document.getElementById("analyticsCommentPotential").textContent = `评论潜力：${diagnosis.commentPotential?.level || "-"}。${(diagnosis.commentPotential?.reasons || []).join(" ")}`;
  document.getElementById("analyticsConversionPotential").textContent = `转化潜力：${diagnosis.conversionPotential?.level || "-"}。${(diagnosis.conversionPotential?.reasons || []).join(" ")}`;
  document.getElementById("analyticsCommentInsight").textContent = commentInsight.note || "当前暂无评论洞察。";
  document.getElementById("analyticsCommentSamples").textContent = (commentInsight.commentSamples || []).join("\n") || "当前未抓到评论正文样本。";

  renderList("analyticsSummary", analytics?.summary || [], "当前真实互动数据不足，结论以内容结构分析为主。");
  renderList("analyticsSuggestions", diagnosis.suggestions || [], "当前内容结构已经较完整，可继续结合真实互动数据复盘。");
  renderList("analyticsLimitations", analytics?.limitations || [], "当前分析已尽量基于可用数据输出。");
}

async function fetchAnalytics(payload) {
  const response = await fetch("/api/xhs/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw new Error("服务器返回了异常响应，请确认服务已正常启动。");
  }
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "数据分析失败");
  }
  return data;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return map[char];
  });
}

function renderHistory(items) {
  historyItems = items || [];

  if (!items?.length) {
    clearHistoryDetail();
    if (activeAnalyticsHistoryId) {
      hideAnalyticsCard();
    }
    historyListEl.innerHTML = `
      <section class="history-empty-state">
        <img class="history-empty-icon" src="/assets/history-empty.svg" alt="历史记录空状态图标" />
        <h3>还没有历史记录</h3>
        <p>先转写一条试试，成功后的内容会自动保存在右侧，方便你随时回看、复制和删除。</p>
      </section>
    `;
    return;
  }

  historyListEl.innerHTML = items.map((item) => {
    const title = escapeHtml(item.title || "未命名内容");
    const createdAt = escapeHtml(formatDateTime(item.createdAt));
    const itemId = escapeHtml(item.id || "");
    const activeClass = item.id === activeHistoryId ? " active" : "";
    const finalUrl = item.finalUrl
      ? `<a class="history-link" href="${escapeHtml(item.finalUrl)}" target="_blank" rel="noreferrer">打开原链接</a>`
      : "";

    return `
      <article class="history-item${activeClass}" data-history-select="${itemId}">
        <div class="history-item-head">
          <h3>${title}</h3>
          <span class="history-time">${createdAt}</span>
        </div>
        <div class="history-card-foot">
          ${finalUrl}
          <button class="ghost small history-card-delete" type="button" data-history-delete="${itemId}">删除</button>
        </div>
      </article>
    `;
  }).join("");

  const selected = historyItems.find((item) => item.id === activeHistoryId) || historyItems[0];
  renderHistoryDetail(selected);
}

async function loadHistory() {
  try {
    const response = await fetch("/api/history");
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "加载历史记录失败");
    }

    renderHistory(data.items || []);
  } catch (error) {
    historyItems = [];
    clearHistoryDetail();
    historyListEl.innerHTML = `
      <section class="history-empty-state history-empty-error">
        <img class="history-empty-icon" src="/assets/history-empty.svg" alt="历史记录加载失败图标" />
        <h3>历史记录暂时没加载出来</h3>
        <p>${escapeHtml(error.message || "加载历史记录失败")}</p>
      </section>
    `;
  }
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
refreshHistoryButton.addEventListener("click", async () => {
  await loadHistory();
  showToast("历史记录已刷新");
});
clearHistoryButton.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/history", {
      method: "DELETE"
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "清空历史记录失败");
    }

    renderHistory([]);
    if (activeAnalyticsHistoryId) {
      hideAnalyticsCard();
    }
    showToast("历史记录已清空");
  } catch (error) {
    showToast(error.message || "清空历史记录失败", true);
  }
});
historyListEl.addEventListener("click", async (event) => {
  if (event.target.closest(".history-link")) {
    return;
  }

  const deleteButton = event.target.closest("[data-history-delete]");
  if (deleteButton) {
    const historyId = deleteButton.getAttribute("data-history-delete");
    if (!historyId) return;

    try {
      const response = await fetch(`/api/history/${encodeURIComponent(historyId)}`, {
        method: "DELETE"
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "删除历史记录失败");
      }

      if (activeHistoryId === historyId) {
        activeHistoryId = "";
      }
      if (activeAnalyticsHistoryId === historyId) {
        hideAnalyticsCard();
      }
      renderHistory(data.items || []);
      showToast("已删除");
    } catch (error) {
      showToast(error.message || "删除历史记录失败", true);
    }
    return;
  }

  const historyCard = event.target.closest("[data-history-select]");
  if (!historyCard) return;
  const historyId = historyCard.getAttribute("data-history-select");
  if (!historyId) return;

  const selected = historyItems.find((item) => item.id === historyId);
  renderHistoryDetail(selected);
  renderHistory(historyItems);
});

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
  hideAnalyticsCard();
  showAnalyticsButton.classList.add("hidden");
  currentXhsResult = null;

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
    currentXhsResult = data;
    setStatus(data.warning || "转写完成。");
    await loadHistory();
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
    showToast("复制成功");
  } catch (_error) {
    setStatus("复制失败，请手动选择文字稿复制。", true);
    showToast("复制失败", true);
  }
});

showAnalyticsButton.addEventListener("click", async () => {
  if (!currentXhsResult) {
    showToast("请先完成一次转写", true);
    return;
  }

  try {
    const payload = currentXhsResult.analytics
      ? {
          analytics: currentXhsResult.analytics,
          rawMetrics: currentXhsResult.rawMetrics
        }
      : await fetchAnalytics({
          input: input.value.trim(),
          title: currentXhsResult.title || "",
          author: currentXhsResult.author || "",
          noteText: currentXhsResult.noteText || "",
          finalUrl: currentXhsResult.finalUrl || "",
          transcript: currentXhsResult.transcript || "",
          rawMetrics: currentXhsResult.rawMetrics || {},
          commentSamples: currentXhsResult.commentSamples || []
        });

    currentXhsResult.analytics = payload.analytics;
    currentXhsResult.rawMetrics = payload.rawMetrics;
    activeAnalyticsHistoryId = "";
    renderAnalytics(payload);
  } catch (error) {
    showToast(error.message || "数据分析失败", true);
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
loadHistory();

document.getElementById("showHistoryAnalytics").addEventListener("click", async () => {
  const item = historyItems.find((entry) => entry.id === activeHistoryId);
  if (!item) {
    showToast("请先选择一条历史记录", true);
    return;
  }

  try {
    const analyticsPayload = item.analytics
      ? {
          analytics: item.analytics,
          rawMetrics: item.rawMetrics || {
            likeCount: item.likeCount,
            collectCount: item.collectCount,
            commentCount: item.commentCount,
            shareCount: item.shareCount,
            viewCount: item.viewCount
          }
        }
      : await fetchAnalytics({
          input: item.input || "",
          title: item.title || "",
          author: item.author || "",
          noteText: item.noteText || "",
          finalUrl: item.finalUrl || "",
          transcript: item.transcript || "",
          rawMetrics: item.rawMetrics || {
            likeCount: item.likeCount,
            collectCount: item.collectCount,
            commentCount: item.commentCount,
            shareCount: item.shareCount,
            viewCount: item.viewCount
          },
          commentSamples: item.commentSamples || []
        });

    item.analytics = analyticsPayload.analytics;
    item.rawMetrics = analyticsPayload.rawMetrics;
    activeAnalyticsHistoryId = activeHistoryId;
    renderAnalytics(analyticsPayload);
    showToast("数据分析已展开");
  } catch (error) {
    showToast(error.message || "数据分析失败", true);
  }
});

copyHistoryDetailButton.addEventListener("click", async () => {
  const item = historyItems.find((entry) => entry.id === activeHistoryId);
  const text = item?.transcript?.trim();
  if (!text) {
    showToast("当前没有可复制的文字稿", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast("复制成功");
  } catch (_error) {
    showToast("复制失败", true);
  }
});

deleteHistoryDetailButton.addEventListener("click", async () => {
  if (!activeHistoryId) {
    showToast("请先选择一条历史记录", true);
    return;
  }

  const deletingHistoryId = activeHistoryId;
  try {
    const response = await fetch(`/api/history/${encodeURIComponent(deletingHistoryId)}`, {
      method: "DELETE"
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "删除历史记录失败");
    }

    activeHistoryId = "";
    if (activeAnalyticsHistoryId === deletingHistoryId) {
      hideAnalyticsCard();
    }
    renderHistory(data.items || []);
    showToast("已删除");
  } catch (error) {
    showToast(error.message || "删除历史记录失败", true);
  }
});

