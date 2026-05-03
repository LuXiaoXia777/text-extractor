// ── 共用工具函数 ──

let toastTimer = null;
const toastEl = document.getElementById("toast");
const networkBanner = document.getElementById("networkBanner");

function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then((res) => { clearTimeout(timer); return res; })
    .catch((err) => {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        const secs = Math.round(timeoutMs / 1000);
        const label = secs >= 60 ? `${Math.round(secs / 60)} 分钟` : `${secs} 秒`;
        throw new Error(`请求超时（超过 ${label}），请检查网络后重试`);
      }
      throw err;
    });
}

function initNetworkStatus() {
  function update() { networkBanner.classList.toggle("hidden", navigator.onLine); }
  window.addEventListener("offline", () => { update(); showToast("网络已断开，请检查连接", true); });
  window.addEventListener("online",  () => { update(); showToast("网络已恢复"); });
  update();
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  toastEl.classList.toggle("error", isError);
  requestAnimationFrame(() => toastEl.classList.add("visible"));
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove("visible");
    toastTimer = window.setTimeout(() => toastEl.classList.add("hidden"), 220);
  }, 2200);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCount(num) {
  if (num == null || num === "") return "-";
  const n = Number(num);
  if (!Number.isFinite(n)) return "-";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  return String(n);
}

// ── DOM 引用 ──

const creatorInput = document.getElementById("creatorInput");
const creatorStatusEl = document.getElementById("creatorStatus");
const creatorResultEl = document.getElementById("creatorResult");

function setCreatorStatus(message, isError = false) {
  creatorStatusEl.textContent = message;
  creatorStatusEl.classList.toggle("error", isError);
}

// ── 渲染函数 ──

const FORMULA_NAME_MAP = {
  "0": "未分类",
  "1": "时间+结果+经验",
  "2": "痛点+解决方案",
  "3": "情绪共鸣",
  "4": "数字清单",
  "5": "身份标签+反常识",
  "6": "对比反差",
  "7": "悬念揭秘",
  "8": "干货承诺",
  "9": "故事第一人称",
  "10": "趋势判断",
  "11": "提问+互动"
};

function renderDistChart(containerEl, distribution, labelMap) {
  if (!containerEl) return;
  const entries = Object.entries(distribution || {}).filter(([, v]) => v > 0);
  if (!entries.length) {
    containerEl.innerHTML = '<p style="color:var(--muted);font-size:13px;margin:0">暂无数据</p>';
    return;
  }
  const maxVal = Math.max(...entries.map(([, v]) => v));
  containerEl.innerHTML = entries
    .sort(([, a], [, b]) => b - a)
    .map(([key, val]) => {
      const label = (labelMap && labelMap[key]) || key;
      const pct = maxVal > 0 ? Math.round((val / maxVal) * 100) : 0;
      return `
        <div class="dist-row">
          <span class="dist-label">${escapeHtml(label)}</span>
          <div class="dist-bar-wrap"><div class="dist-bar" style="width:${pct}%"></div></div>
          <span class="dist-value">${val}</span>
        </div>
      `;
    })
    .join("");
}

function renderCreatorCard(creator) {
  const avatarEl = document.getElementById("creatorAvatar");
  if (creator.avatar) {
    avatarEl.src = creator.avatar.startsWith("//") ? "https:" + creator.avatar : creator.avatar;
    avatarEl.style.display = "";
  } else {
    avatarEl.style.display = "none";
  }
  document.getElementById("creatorNickname").textContent = creator.nickname || "未知博主";
  document.getElementById("creatorFans").textContent = formatCount(creator.fans);
  document.getElementById("creatorLikeCollect").textContent = formatCount(creator.totalLikeAndCollect);
  document.getElementById("creatorNoteCount").textContent = formatCount(creator.noteCount);
}

function renderNoteGrid(notes) {
  const containerEl = document.getElementById("creatorNoteList");
  if (!containerEl) return;
  if (!notes || !notes.length) {
    containerEl.innerHTML = '<p style="color:var(--muted);font-size:13px">未找到笔记数据。</p>';
    return;
  }
  containerEl.innerHTML = notes.map((note) => {
    const cover = note.cover
      ? `<div class="note-card-cover"><img src="${escapeHtml(note.cover)}" alt="" loading="lazy" /></div>`
      : `<div class="note-card-cover"></div>`;
    const formulaTag = note.formula?.formulaName && note.formula.formulaId !== 0
      ? `<span class="note-formula-tag">${escapeHtml(note.formula.formulaName)}</span>`
      : "";
    const likeText = note.likeCount != null
      ? `<span class="note-like">赞 ${formatCount(note.likeCount)}</span>`
      : "";
    return `
      <div class="note-card">
        ${cover}
        <div class="note-card-body">
          <p class="note-card-title">${escapeHtml(note.title || "")}</p>
          <div class="note-card-meta">${formulaTag}${likeText}</div>
        </div>
      </div>
    `;
  }).join("");
}

function renderCreatorResult(data) {
  creatorResultEl.classList.remove("hidden");
  renderCreatorCard(data.creator);
  renderDistChart(document.getElementById("creatorContentTypeDist"), data.analysis.contentTypeDistribution, {});
  renderDistChart(document.getElementById("creatorFormulaDist"), data.analysis.formulaDistribution, FORMULA_NAME_MAP);
  renderNoteGrid(data.notes);
}

// ── 事件绑定 ──

const refreshBtn = document.getElementById("refreshCreatorAnalysis");

async function runAnalysis() {
  const url = creatorInput.value.trim();
  if (!url) {
    setCreatorStatus("请先输入博主主页链接。", true);
    return;
  }

  setCreatorStatus("正在分析博主数据，请稍等（需启动浏览器，约需 30 秒）...");
  creatorResultEl.classList.add("hidden");
  refreshBtn.classList.add("hidden");

  try {
    const response = await fetchWithTimeout("/api/xhs/creator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    }, 120000);
    let data;
    try {
      data = await response.json();
    } catch (_e) {
      throw new Error("服务器返回了异常响应，请确认服务已正常启动。");
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "博主数据分析失败");
    }
    renderCreatorResult(data);
    setCreatorStatus("分析完成。");
    refreshBtn.classList.remove("hidden");
  } catch (error) {
    setCreatorStatus(error.message, true);
    refreshBtn.classList.remove("hidden");
  }
}

document.getElementById("runCreatorAnalysis").addEventListener("click", runAnalysis);
refreshBtn.addEventListener("click", runAnalysis);

creatorInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runAnalysis();
});

initNetworkStatus();
