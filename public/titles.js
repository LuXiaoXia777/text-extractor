// ── 共用工具函数 ──

let toastTimer = null;
const toastEl = document.getElementById("toast");

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

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 状态 ──

let titleLibraryItems = [];
let activeFormulaId = -1;

const formulaNavEl = document.getElementById("formulaNav");
const titleTableBodyEl = document.getElementById("titleTableBody");
const titlesEmptyEl = document.getElementById("titlesEmpty");
const titlesCountEl = document.getElementById("titlesCount");
const syncTitlesButton = document.getElementById("syncTitles");
const titlesStatusEl = document.getElementById("titlesStatus");

// ── 公式列表 ──

const FORMULA_LIST = [
  { id: -1, name: "全部" },
  { id: 1, name: "时间+结果+经验" },
  { id: 2, name: "痛点+解决方案" },
  { id: 3, name: "情绪共鸣" },
  { id: 4, name: "数字清单" },
  { id: 5, name: "身份标签+反常识" },
  { id: 6, name: "对比反差" },
  { id: 7, name: "悬念揭秘" },
  { id: 8, name: "干货承诺" },
  { id: 9, name: "故事第一人称" },
  { id: 10, name: "趋势判断+行业视角" },
  { id: 11, name: "提问+互动" },
  { id: 0, name: "未分类" }
];

// ── 渲染函数 ──

function renderFormulaNav(stats) {
  const byFormula = stats?.byFormula || {};
  const total = stats?.total || 0;
  formulaNavEl.innerHTML = FORMULA_LIST.map((formula) => {
    const count = formula.id === -1 ? total : (byFormula[String(formula.id)] || 0);
    const activeClass = formula.id === activeFormulaId ? " active" : "";
    return `
      <button class="formula-nav-item${activeClass}" type="button" data-formula-id="${formula.id}">
        <span class="formula-nav-name">${escapeHtml(formula.name)}</span>
        <span class="formula-nav-count">${count}</span>
      </button>
    `;
  }).join("");
}

function setActiveFormula(formulaId) {
  activeFormulaId = formulaId;
  formulaNavEl.querySelectorAll(".formula-nav-item").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.getAttribute("data-formula-id")) === formulaId);
  });
  renderTitleTable();
}

function renderTitleTable() {
  const filtered = activeFormulaId === -1
    ? titleLibraryItems
    : titleLibraryItems.filter((item) => item.formulaId === activeFormulaId);

  titlesCountEl.textContent = `共 ${filtered.length} 条`;

  if (!filtered.length) {
    titleTableBodyEl.innerHTML = "";
    titlesEmptyEl.classList.remove("hidden");
    return;
  }

  titlesEmptyEl.classList.add("hidden");
  titleTableBodyEl.innerHTML = filtered.map((item) => {
    const tags = (item.contentTypes || [])
      .map((t) => `<span class="analytics-tag">${escapeHtml(t)}</span>`)
      .join("");
    const like = item.rawMetrics?.likeCount != null ? formatCount(item.rawMetrics.likeCount) : "—";
    const collect = item.rawMetrics?.collectCount != null ? formatCount(item.rawMetrics.collectCount) : "—";
    const comment = item.rawMetrics?.commentCount != null ? formatCount(item.rawMetrics.commentCount) : "—";
    const titleCell = item.finalUrl
      ? `<a href="${escapeHtml(item.finalUrl)}" target="_blank" rel="noreferrer" style="color:var(--accent-dark);font-weight:600;text-decoration:none;">${escapeHtml(item.title || "")}</a>`
      : escapeHtml(item.title || "");
    return `
      <tr>
        <td>${titleCell}</td>
        <td><span class="title-formula-label">${escapeHtml(item.formulaName || "未分类")}</span></td>
        <td><div class="title-tags">${tags || "—"}</div></td>
        <td style="white-space:nowrap">${like} · ${collect} · ${comment}</td>
        <td style="white-space:nowrap;color:var(--muted)">${formatDateTime(item.savedAt)}</td>
      </tr>
    `;
  }).join("");
}

// ── 数据加载 ──

async function loadTitleLibrary() {
  try {
    const response = await fetch("/api/titles");
    let data;
    try { data = await response.json(); } catch (_e) { throw new Error("加载失败"); }
    if (!response.ok || !data.ok) throw new Error(data.error || "加载标题库失败");
    titleLibraryItems = data.items || [];
    renderFormulaNav(data.stats);
    renderTitleTable();
  } catch (_error) {
    titleLibraryItems = [];
    renderFormulaNav({});
    renderTitleTable();
  }
}

async function syncTitlesFromHistory() {
  syncTitlesButton.disabled = true;
  titlesStatusEl.textContent = "正在同步...";
  titlesStatusEl.classList.remove("error");
  try {
    const response = await fetch("/api/titles/sync", { method: "POST" });
    let data;
    try { data = await response.json(); } catch (_e) { throw new Error("同步失败，服务器返回了异常响应。"); }
    if (!response.ok || !data.ok) throw new Error(data.error || "同步失败");
    titleLibraryItems = data.items || [];
    renderFormulaNav(data.stats);
    renderTitleTable();
    titlesStatusEl.textContent = "";
    showToast(`同步完成，新增 ${data.added} 条，更新 ${data.updated} 条`);
  } catch (error) {
    titlesStatusEl.textContent = error.message;
    titlesStatusEl.classList.add("error");
  } finally {
    syncTitlesButton.disabled = false;
  }
}

// ── 事件绑定 ──

syncTitlesButton.addEventListener("click", syncTitlesFromHistory);

formulaNavEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-formula-id]");
  if (btn) setActiveFormula(Number(btn.getAttribute("data-formula-id")));
});

// ── 初始化 ──
loadTitleLibrary();
