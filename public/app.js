const headers = [
  "기호",
  "소재지",
  "지번",
  "시점",
  "면적",
  "지목",
  "용도지역",
  "이용상황",
  "도로교통",
  "형상",
  "지세",
  "목적/거래가격",
  "단가(원/㎡)",
  "개별공시지가",
  "개공비율",
  "검토",
  "시점수정치",
  "시점수정",
  "크롤링상태",
];

const columnLetters = ["", ...Array.from({ length: headers.length }, (_, index) => {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    n -= 1;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }
  return label;
})];

const state = {
  file: null,
  timer: null,
  lastProgress: "",
  logs: [],
  currentJobId: null,
  pendingHistoryId: null,
  historyPage: 1,
};

const historyDbName = "tojiWorksHistory";
const historyFileStore = "files";

const els = {
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  fileName: document.querySelector("#fileName"),
  fileMeta: document.querySelector("#fileMeta"),
  brandHomeBtn: document.querySelector("#brandHomeBtn"),
  processBtn: document.querySelector("#processBtn"),
  serverStatus: document.querySelector("#serverStatus"),
  steps: [...document.querySelectorAll("#steps span")],
  downloadBtn: document.querySelector("#downloadBtn"),
  previewHead: document.querySelector("#previewHead"),
  previewBody: document.querySelector("#previewBody"),
  gsiPopupBtn: document.querySelector("#gsiPopupBtn"),
  batchRateBtn: document.querySelector("#batchRateBtn"),
  saveCellsBtn: document.querySelector("#saveCellsBtn"),
  gsiDialog: document.querySelector("#gsiDialog"),
  gsiDialogClose: document.querySelector("#gsiDialogClose"),
  gsiSearchForm: document.querySelector("#gsiSearchForm"),
  gsiKeyword: document.querySelector("#gsiKeyword"),
  gsiSuggestList: document.querySelector("#gsiSuggestList"),
  gsiSelectedAddress: document.querySelector("#gsiSelectedAddress"),
  gsiSearchStatus: document.querySelector("#gsiSearchStatus"),
  gsiResultHead: document.querySelector("#gsiResultHead"),
  gsiResultBody: document.querySelector("#gsiResultBody"),
  summaryText: document.querySelector("#summaryText"),
  sheetName: document.querySelector("#sheetName"),
  officeBtn: document.querySelector("#officeBtn"),
  devViewBtn: document.querySelector("#devViewBtn"),
  historyViewBtn: document.querySelector("#historyViewBtn"),
  backToMainBtn: document.querySelector("#backToMainBtn"),
  mainView: document.querySelector("#mainView"),
  devView: document.querySelector("#devView"),
  historyView: document.querySelector("#historyView"),
  logStream: document.querySelector("#logStream"),
  rowCount: document.querySelector("#rowCount"),
  requestForm: document.querySelector("#requestForm"),
  requestTitle: document.querySelector("#requestTitle"),
  requestBody: document.querySelector("#requestBody"),
  requestImage: document.querySelector("#requestImage"),
  imagePreview: document.querySelector("#imagePreview"),
  requestList: document.querySelector("#requestList"),
  clearRequestsBtn: document.querySelector("#clearRequestsBtn"),
  historyList: document.querySelector("#historyList"),
  historyPagination: document.querySelector("#historyPagination"),
  historyUploadInput: document.querySelector("#historyUploadInput"),
  historyHidePending: document.querySelector("#historyHidePending"),
  historyCount: document.querySelector("#historyCount"),
};

const historyPageSize = 10;
let gsiSuggestTimer = null;
let selectedGsiSuggestion = null;

function nowTime() {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function todayLabel() {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(new Date());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setText(element, text) {
  if (element) element.textContent = text;
}

function addLog(message, type = "info") {
  if (!message || state.lastProgress === message) return;
  state.lastProgress = message;
  state.logs.push({ time: nowTime(), message, type });
  renderLogs();
}

function renderLogs() {
  const logs = state.logs;
  els.logStream.innerHTML = [
    `<div class="log-day">${todayLabel()}</div>`,
    ...logs.map((log) => `
      <div class="log-line ${log.type}">
        <span class="log-time">${log.time}</span>
        <span class="log-arrow">==&gt;</span>
        <span class="log-message">${escapeHtml(log.message)}</span>
      </div>
    `),
  ].join("");
  els.logStream.scrollTop = els.logStream.scrollHeight;
}

window.addEventListener("error", (event) => {
  addLog(`화면 오류: ${event.message}`, "error");
});

window.addEventListener("unhandledrejection", (event) => {
  addLog(`처리 오류: ${event.reason?.message || event.reason || "알 수 없는 오류"}`, "error");
});

function setStep(index) {
  els.steps.forEach((step, i) => {
    step.classList.toggle("active", i === index);
    step.classList.toggle("done", i < index);
  });
}

function setServerStatus(text) {
  setText(els.serverStatus, text);
}

function showView(view) {
  els.mainView.classList.toggle("hidden", view !== "main");
  els.devView.classList.toggle("hidden", view !== "dev");
  els.historyView.classList.toggle("hidden", view !== "history");
  els.devViewBtn.classList.toggle("active", view === "dev");
  els.historyViewBtn.classList.toggle("active", view === "history");
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem("tojiJobHistory") || "[]");
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem("tojiJobHistory", JSON.stringify(history));
}

function openHistoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(historyDbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(historyFileStore, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveOriginalFile(id, file) {
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(historyFileStore, "readwrite");
    tx.objectStore(historyFileStore).put({
      id,
      name: file.name,
      type: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      blob: file,
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getOriginalFile(id) {
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(historyFileStore).objectStore(historyFileStore).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name || "원본.xlsx";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filenameFromDisposition(value) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value || "")?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return /filename="?([^"]+)"?/i.exec(value || "")?.[1] || "TojiWorks.xlsx";
}

async function downloadResultFile(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    let message = "다운로드 실패";
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      message = await response.text() || message;
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const fileName = filenameFromDisposition(response.headers.get("Content-Disposition"));
  downloadBlob(fileName, blob);
}

function parseHistoryTime(item) {
  if (Number.isFinite(item.createdAtMs)) return item.createdAtMs;
  const idTime = String(item.jobId || "").match(/(?:pending|queued)-(\d+)/)?.[1];
  if (idTime) return Number(idTime);
  const text = String(item.createdAt || "");
  const match = text.match(/(\d{4})\.\s*(\d{2})\.\s*(\d{2})\.\s*(오전|오후)?\s*(\d{1,2}):(\d{2})/);
  if (match) {
    let hour = Number(match[5]);
    if (match[4] === "오후" && hour < 12) hour += 12;
    if (match[4] === "오전" && hour === 12) hour = 0;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, Number(match[6])).getTime();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function upsertHistory(item) {
  const history = getHistory().filter((entry) => entry.jobId !== item.jobId);
  history.unshift({ ...item, createdAtMs: item.createdAtMs || Date.now() });
  saveHistory(history.slice(0, 100));
  state.historyPage = 1;
  renderHistory();
}

function renderHistory() {
  const hidePending = els.historyHidePending?.checked;
  const all = getHistory().sort((a, b) => parseHistoryTime(b) - parseHistoryTime(a));
  const history = hidePending ? all.filter((item) => item.downloadUrl) : all;
  setText(els.historyCount, `총 ${history.length}개`);
  const totalPages = Math.max(1, Math.ceil(history.length / historyPageSize));
  state.historyPage = Math.min(Math.max(1, state.historyPage), totalPages);
  const start = (state.historyPage - 1) * historyPageSize;
  const pageItems = history.slice(start, start + historyPageSize);
  const rows = pageItems.map((item, index) => {
    const expired = item.expiresAt && Date.now() > Date.parse(item.expiresAt);
    const originalDownload = item.originalFileId
      ? `<button class="history-link" type="button" data-original-id="${escapeHtml(item.originalFileId)}">다운로드</button>`
      : `<span class="history-muted">-</span>`;
    const processedDownload = !item.downloadUrl
      ? `<span class="history-muted">-</span>`
      : expired
      ? `<span class="history-expired">만료됨</span>`
      : `<button class="history-link" type="button" data-download-url="${escapeHtml(item.downloadUrl)}">다운로드</button>`;
    const expiresAt = item.expiresAt ? item.expiresAt.slice(0, 10) : "";
    const isDone = Boolean(item.downloadUrl);
    const statusCell = isDone
      ? `<span class="status-label done">완료</span>`
      : `<button class="status-label pending" type="button" data-run-history-id="${escapeHtml(item.jobId)}">대기</button>`;
    const version = isDone ? item.version || "-" : "-";
    return `
      <div class="history-item">
        <div>${start + index + 1}</div>
        <div>${escapeHtml(item.createdAt || "-")}</div>
        <div><strong>${escapeHtml(item.fileName || "-")}</strong></div>
        <div>${statusCell}</div>
        <div>${escapeHtml(version)}</div>
        <div>${originalDownload}</div>
        <div>${processedDownload}${expiresAt ? `<small>${escapeHtml(`${expiresAt}까지`)}</small>` : ""}</div>
      </div>
    `;
  }).join("");
  els.historyList.innerHTML = rows || `<div class="empty-list">아직 작업 히스토리가 없습니다.</div>`;
  els.historyPagination.innerHTML = history.length > historyPageSize
    ? `
      <button type="button" data-history-page="${state.historyPage - 1}" ${state.historyPage === 1 ? "disabled" : ""}>이전</button>
      <span>${state.historyPage} / ${totalPages}</span>
      <button type="button" data-history-page="${state.historyPage + 1}" ${state.historyPage === totalPages ? "disabled" : ""}>다음</button>
    `
    : "";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function addOriginalHistory(file, source = "main") {
  const id = `${source}-${Date.now()}`;
  await saveOriginalFile(id, file);
  upsertHistory({
    jobId: id,
    originalFileId: id,
    fileName: file.name,
    status: "분석 전",
    version: "-",
    createdAt: new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date()),
    savedFileName: "",
    downloadUrl: "",
    expiresAt: "",
  });
  return id;
}

async function chooseFile(file) {
  if (!file) return;
  state.file = file;
  setText(els.fileName, file.name);
  setText(els.fileMeta, `${formatBytes(file.size)} · 업로드 준비 완료`);
  els.processBtn.disabled = false;
  els.processBtn.classList.remove("complete");
  setText(els.processBtn, "파일 분석");
  setServerStatus("파일 선택");
  addLog(`파일 선택: ${file.name} (${formatBytes(file.size)})`);
  state.pendingHistoryId = await addOriginalHistory(file, "pending");
}

function renderHead() {
  els.previewHead.innerHTML = [
    `<th class="corner"></th>`,
    ...headers.map((header, index) => `<th><span class="col-letter">${columnLetters[index + 1]}</span> ${header}</th>`),
  ].join("");
}

function valueText(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString("ko-KR")
      : value.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  return String(value);
}

function isCrawledCell(header, row) {
  if (header === "크롤링상태") return Boolean(row[header]) && !String(row[header]).startsWith("원본");
  if (header === "개별공시지가") return /조회완료/.test(String(row["크롤링상태"] || ""));
  return false;
}

function renderPreview(rows) {
  renderHead();
  setText(els.rowCount, `${rows?.length || 0}건`);
  if (!rows?.length) {
    els.previewBody.innerHTML = `<tr><td class="row-head">1</td><td class="empty" colspan="${headers.length}">업로드 후 결과 미리보기가 표시됩니다.</td></tr>`;
    return;
  }

  els.previewBody.innerHTML = rows
    .map((row, rowIndex) => {
      const cells = headers
        .map((header, colIndex) => {
          const className = isCrawledCell(header, row) ? " class=\"crawled\"" : "";
          return `<td${className} data-col="${colIndex}" contenteditable="true" spellcheck="false">${escapeHtml(valueText(row[header]))}</td>`;
        })
        .join("");
      return `<tr><td class="row-head">${rowIndex + 1}</td>${cells}</tr>`;
    })
    .join("");
}

function splitSearchJibun(value) {
  let text = String(value || "").trim();
  let san = "1";
  if (text.startsWith("산")) {
    san = "2";
    text = text.slice(1).trim();
  }
  const [main = "", sub = "0"] = text.split("-");
  return {
    san,
    bun1: main.replace(/\D/g, "").padStart(4, "0"),
    bun2: (sub.replace(/\D/g, "") || "0").padStart(4, "0"),
  };
}

function gsiParamsFromForm() {
  const data = new FormData(els.gsiSearchForm);
  if (!selectedGsiSuggestion?.params) {
    throw new Error("자동완성 후보에서 주소를 먼저 선택해 주세요.");
  }
  return {
    ...selectedGsiSuggestion.params,
    notice_year: data.get("notice_year") || "",
    notice_year_nm: "",
  };
}

function gsiSearchMode() {
  return new FormData(els.gsiSearchForm).get("gsiSearchMode") || "parcel";
}

function renderSuggestions(items) {
  if (!items.length) {
    els.gsiSuggestList.innerHTML = `<div class="suggest-empty">실시간 API에서 일치하는 주소가 없습니다. 정확한 검증을 위해 시군구나 동 이름을 함께 입력해 주세요.</div>`;
    els.gsiSuggestList.classList.remove("hidden");
    return;
  }
  els.gsiSuggestList.innerHTML = items.map((item, index) => `
    <button type="button" data-suggest-index="${index}">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml(item.detail || (item.mode === "road" ? "도로명" : "지번"))}</span>
    </button>
  `).join("");
  els.gsiSuggestList._items = items;
  els.gsiSuggestList.classList.remove("hidden");
}

async function fetchGsiSuggestions() {
  const keyword = els.gsiKeyword.value.trim();
  selectedGsiSuggestion = null;
  setText(els.gsiSelectedAddress, "주소 후보를 선택해 주세요.");
  if (keyword.length < 2) {
    els.gsiSuggestList.classList.add("hidden");
    return;
  }
  setText(els.gsiSelectedAddress, "캐시 미사용 · realtyprice.kr API에서 실시간 주소 후보를 확인 중입니다.");
  const params = new URLSearchParams({ mode: gsiSearchMode(), q: keyword });
  const response = await fetch(`/api/realtyprice/gsi/suggest?${params.toString()}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "주소 후보 조회 실패");
  renderSuggestions(data.suggestions || []);
}

function formatGsiCell(key, value) {
  if (value === null || value === undefined || value === "") return "";
  if (key === "gakuka_w") {
    const num = Number(String(value).replace(/,/g, ""));
    if (!isNaN(num) && num > 0) return num.toLocaleString("ko-KR") + " 원/㎡";
  }
  return escapeHtml(String(value));
}

function renderGsiRows(rows) {
  if (!rows.length) {
    els.gsiResultHead.innerHTML = "";
    els.gsiResultBody.innerHTML = `<tr><td class="empty">조회 결과가 없습니다.</td></tr>`;
    return;
  }
  const columns = [
    ["base_year", "기준연도"],
    ["addr", "소재지"],
    ["jibun", "지번"],
    ["base_md", "기준일자"],
    ["notice_ymd", "공시일자"],
    ["gakuka_w", "개별공시지가"],
    ["etc_cntn", "비고"],
  ].filter(([key]) => rows.some((row) => key in row));
  const keys = columns.length ? columns : Object.keys(rows[0]).map((key) => [key, key]);
  els.gsiResultHead.innerHTML = `<tr>${keys.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr>`;
  els.gsiResultBody.innerHTML = rows.map((row) => `
    <tr>${keys.map(([key]) => `<td>${formatGsiCell(key, row[key])}</td>`).join("")}</tr>
  `).join("");
}

async function searchGsi() {
  const params = gsiParamsFromForm();
  setText(els.gsiSearchStatus, "조회 중");
  els.gsiResultBody.innerHTML = `<tr><td class="empty">조회 중입니다.</td></tr>`;
  const response = await fetch(`/api/realtyprice/gsi?${new URLSearchParams(params).toString()}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) {
    setText(els.gsiSearchStatus, `실패: ${data.error || "조회 실패"}`);
    els.gsiResultBody.innerHTML = `<tr><td class="empty">${escapeHtml(data.error || "조회 실패")}</td></tr>`;
    return;
  }
  const fetchedAt = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("ko-KR") : "방금";
  setText(els.gsiSearchStatus, `캐시 미사용 · 실시간 최신 조회 완료: ${data.rows.length}건 · ${fetchedAt}`);
  renderGsiRows(data.rows || []);
}

async function poll(jobId) {
  const response = await fetch(`/api/job/${jobId}`);
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || "작업 상태를 읽지 못했습니다.");

  if (job.progress) addLog(job.progress);
  if (/조회|공시지가/.test(job.progress || "")) setStep(2);
  else if (/저장|완료/.test(job.progress || "")) setStep(3);
  else setStep(1);

  if (job.status === "failed") {
    clearInterval(state.timer);
    setServerStatus("실패");
    addLog(job.error || "처리 실패", "error");
    els.processBtn.disabled = false;
    return;
  }

  if (job.status === "done") {
    clearInterval(state.timer);
    setStep(3);
    els.steps.at(-1)?.classList.add("done");
    setServerStatus("완료");
    els.downloadBtn.href = job.downloadUrl;
    els.downloadBtn.classList.remove("disabled");
    els.downloadBtn.classList.add("complete");
    setText(els.downloadBtn, "엑셀 다운로드 가능");
    state.currentJobId = job.id;
    if (els.saveCellsBtn) els.saveCellsBtn.disabled = false;
    if (els.batchRateBtn) els.batchRateBtn.disabled = false;
    setText(els.summaryText, `${job.caseCount || 0}건을 자동정리 탭에 작성했습니다.`);
    setText(els.sheetName, job.sheetName || "자동정리");
    addLog(`완료: ${job.caseCount || 0}건을 ${job.sheetName || "자동정리"} 탭에 기록했습니다.`, "success");
    addLog(`저장 폴더: ${job.savedFolder || "저장 위치를 확인하지 못했습니다."}`, job.savedFolder ? "success" : "error");
    if (job.warnings?.length) {
      job.warnings.forEach((warning) => {
        state.lastProgress = "";
        addLog(`공시지가 조회 실패: ${warning}`, "error");
      });
    }
    const existingHistory = getHistory().find((entry) => entry.jobId === state.pendingHistoryId);
    upsertHistory({
      jobId: state.pendingHistoryId || job.id,
      originalFileId: existingHistory?.originalFileId || "",
      fileName: job.fileName,
      status: "분석 후",
      version: job.savedFileName?.match(/수정v\d+/)?.[0] || "",
      createdAt: new Intl.DateTimeFormat("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date()),
      savedFileName: job.savedFileName,
      downloadUrl: job.downloadUrl,
      expiresAt: job.expiresAt,
    });
    state.pendingHistoryId = null;
    renderPreview(job.preview);
    setText(els.rowCount, `${job.caseCount || job.preview?.length || 0}건`);
    els.processBtn.disabled = false;
    els.processBtn.classList.add("complete");
    setText(els.processBtn, "분석 완료");
  }
}

async function startProcess() {
  if (!state.file) return;
  state.lastProgress = "";
  els.processBtn.disabled = true;
  els.processBtn.classList.remove("complete");
  setText(els.processBtn, "분석 중");
  els.downloadBtn.classList.add("disabled");
  els.downloadBtn.classList.remove("complete");
  setText(els.downloadBtn, "엑셀 다운로드");
  els.downloadBtn.href = "#";
  setServerStatus("처리 중");
  setStep(0);
  if (els.saveCellsBtn) els.saveCellsBtn.disabled = true;
  if (els.batchRateBtn) els.batchRateBtn.disabled = true;
  addLog("엑셀 파일을 서버로 전송하는 중입니다...");

  const form = new FormData();
  form.append("file", state.file);
  const response = await fetch("/api/process", { method: "POST", body: form });
  const data = await response.json();
  if (!response.ok) {
    els.processBtn.disabled = false;
    setServerStatus("오류");
    throw new Error(data.error || "업로드 실패");
  }
  addLog(`작업이 접수되었습니다. (${data.jobId})`);
  state.timer = setInterval(() => poll(data.jobId).catch((error) => {
    clearInterval(state.timer);
    setServerStatus("오류");
    addLog(error.message, "error");
    els.processBtn.disabled = false;
  }), 1200);
  await poll(data.jobId);
}

async function saveCells() {
  if (!state.currentJobId) {
    addLog("먼저 파일 분석을 완료해야 합니다.", "error");
    return;
  }
  const patches = [];
  els.previewBody.querySelectorAll("tr").forEach((tr, rowIndex) => {
    const excelRow = rowIndex + 3;
    tr.querySelectorAll("td[data-col]").forEach((td) => {
      const colIndex = Number(td.dataset.col);
      if (colIndex !== COL_TIME_RATE && colIndex !== COL_TIME_ADJ) return;
      const value = td.textContent.trim();
      if (!value) return;
      const format = colIndex === COL_TIME_RATE ? "0.0000" : "#,##0";
      patches.push({ row: excelRow, col: colIndex + 1, value, format });
    });
  });
  if (!patches.length) {
    addLog("저장할 값이 없습니다. 시점수정치 열에 값을 입력해 주세요.", "error");
    return;
  }
  setText(els.saveCellsBtn, "저장 중...");
  els.saveCellsBtn.disabled = true;
  try {
    const response = await fetch(`/api/patch-cells/${state.currentJobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patches }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "저장 실패");
    addLog(`시점수정 ${patches.length}개 셀을 엑셀에 반영했습니다.`, "success");
  } finally {
    setText(els.saveCellsBtn, "시점수정 저장");
    els.saveCellsBtn.disabled = false;
  }
}

async function runHistoryAnalysis(historyId) {
  const item = getHistory().find((entry) => entry.jobId === historyId);
  if (!item?.originalFileId) {
    addLog("분석할 원본 파일을 찾지 못했습니다.", "error");
    return;
  }
  const original = await getOriginalFile(item.originalFileId);
  if (!original?.blob) {
    addLog("저장된 원본 파일을 찾지 못했습니다.", "error");
    return;
  }
  state.file = new File([original.blob], original.name || item.fileName || "원본.xlsx", {
    type: original.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  state.pendingHistoryId = item.jobId;
  setText(els.fileName, state.file.name);
  setText(els.fileMeta, `${formatBytes(state.file.size)} · 히스토리에서 분석 실행`);
  els.processBtn.disabled = false;
  els.processBtn.classList.remove("complete");
  setText(els.processBtn, "분석 중");
  showView("main");
  await startProcess();
}

els.fileInput.addEventListener("change", (event) => {
  chooseFile(event.target.files[0]).catch((error) => addLog(error.message, "error"));
});

els.historyUploadInput?.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  addOriginalHistory(file, "queued")
    .catch((error) => addLog(error.message, "error"))
    .finally(() => {
      event.target.value = "";
    });
});

els.processBtn.addEventListener("click", () => startProcess().catch((error) => {
  addLog(error.message, "error");
  els.processBtn.disabled = false;
}));

els.downloadBtn.addEventListener("click", (event) => {
  event.preventDefault();
  if (els.downloadBtn.classList.contains("disabled") || !els.downloadBtn.getAttribute("href") || els.downloadBtn.getAttribute("href") === "#") {
    addLog("아직 다운로드할 완료 파일이 없습니다.", "error");
    return;
  }
  downloadResultFile(els.downloadBtn.getAttribute("href")).catch((error) => addLog(error.message, "error"));
});

els.batchRateBtn?.addEventListener("click", () => {
  const input = prompt("모든 행에 적용할 시점수정치를 입력하세요.\n예) 1.0056  (단가 × 시점수정치 = 시점수정)");
  if (!input) return;
  const rate = parseFloat(input.replace(/,/g, ""));
  if (isNaN(rate) || rate <= 0) {
    addLog("유효한 시점수정치를 입력해 주세요. (예: 1.0056)", "error");
    return;
  }
  let count = 0;
  els.previewBody.querySelectorAll(`td[data-col="${COL_TIME_RATE}"]`).forEach((td) => {
    td.textContent = rate;
    td.dispatchEvent(new Event("input", { bubbles: true }));
    count++;
  });
  addLog(`시점수정치 ${rate}를 ${count}개 행에 일괄 적용했습니다.`, "success");
});

els.saveCellsBtn?.addEventListener("click", () => saveCells().catch((error) => addLog(error.message, "error")));

els.gsiPopupBtn.addEventListener("click", () => {
  if (typeof els.gsiDialog.showModal === "function") {
    els.gsiDialog.showModal();
  } else {
    els.gsiDialog.setAttribute("open", "");
  }
});

els.gsiDialogClose.addEventListener("click", () => {
  els.gsiDialog.close();
});

els.gsiKeyword.addEventListener("keydown", (event) => {
  if (els.gsiSuggestList.classList.contains("hidden")) return;
  const buttons = [...els.gsiSuggestList.querySelectorAll("button")];
  if (!buttons.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    buttons[0].focus();
  } else if (event.key === "Escape") {
    els.gsiSuggestList.classList.add("hidden");
  }
});

els.gsiSuggestList.addEventListener("keydown", (event) => {
  const buttons = [...els.gsiSuggestList.querySelectorAll("button")];
  const idx = buttons.indexOf(document.activeElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    buttons[(idx + 1) % buttons.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (idx <= 0) {
      els.gsiKeyword.focus();
    } else {
      buttons[idx - 1].focus();
    }
  } else if (event.key === "Escape") {
    els.gsiSuggestList.classList.add("hidden");
    els.gsiKeyword.focus();
  }
});

els.gsiKeyword.addEventListener("input", () => {
  clearTimeout(gsiSuggestTimer);
  gsiSuggestTimer = setTimeout(() => {
    fetchGsiSuggestions().catch((error) => {
      els.gsiSuggestList.innerHTML = `<div class="suggest-empty">${escapeHtml(error.message)}</div>`;
      els.gsiSuggestList.classList.remove("hidden");
    });
  }, 250);
});

els.gsiSearchForm.querySelectorAll("input[name='gsiSearchMode']").forEach((input) => {
  input.addEventListener("change", () => {
    selectedGsiSuggestion = null;
    setText(els.gsiSelectedAddress, "주소 후보를 선택해 주세요.");
    fetchGsiSuggestions().catch((error) => {
      els.gsiSuggestList.innerHTML = `<div class="suggest-empty">${escapeHtml(error.message)}</div>`;
      els.gsiSuggestList.classList.remove("hidden");
    });
  });
});

els.gsiSuggestList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-suggest-index]");
  if (!button) return;
  const item = els.gsiSuggestList._items?.[Number(button.dataset.suggestIndex)];
  if (!item) return;
  selectedGsiSuggestion = item;
  els.gsiKeyword.value = item.label;
  setText(els.gsiSelectedAddress, `선택: ${item.label}`);
  els.gsiSuggestList.classList.add("hidden");
  els.gsiKeyword.focus();
});

document.addEventListener("click", (event) => {
  if (!els.gsiSuggestList.classList.contains("hidden") &&
      !els.gsiSuggestList.contains(event.target) &&
      event.target !== els.gsiKeyword) {
    els.gsiSuggestList.classList.add("hidden");
  }
});

els.gsiSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchGsi().catch((error) => {
    setText(els.gsiSearchStatus, `실패: ${error.message}`);
    els.gsiResultBody.innerHTML = `<tr><td class="empty">${escapeHtml(error.message)}</td></tr>`;
  });
});

els.officeBtn.addEventListener("click", () => {
  openOfficeEditor().catch((error) => addLog(error.message, "error"));
});

async function openOfficeEditor() {
  if (!state.currentJobId) {
    addLog("먼저 엑셀 처리를 완료해야 Office 365 편집을 열 수 있습니다.", "error");
    return;
  }
  const response = await fetch("/api/m365/status");
  const config = await response.json();
  if (!config.enabled) {
    addLog("M365 연동 설정이 없습니다. Render 환경변수 MS_CLIENT_ID를 설정하고 Azure 앱 Redirect URI에 아래 주소를 등록해야 합니다.", "error");
    addLog(`Redirect URI: ${config.redirectUri}`);
    return;
  }
  addLog("Microsoft 로그인으로 이동합니다. 로그인 후 OneDrive에 업로드하고 Excel Online 편집 화면을 엽니다.");
  window.location.href = `/api/m365/start/${state.currentJobId}`;
}

els.devViewBtn.addEventListener("click", () => {
  showView("dev");
});

els.backToMainBtn.addEventListener("click", () => {
  showView("main");
});

els.historyViewBtn.addEventListener("click", () => {
  renderHistory();
  showView("history");
});

els.historyHidePending?.addEventListener("change", () => {
  renderHistory();
});

els.historyList.addEventListener("click", async (event) => {
  const runButton = event.target.closest("[data-run-history-id]");
  if (runButton) {
    runHistoryAnalysis(runButton.dataset.runHistoryId).catch((error) => addLog(error.message, "error"));
    return;
  }
  const downloadButton = event.target.closest("[data-download-url]");
  if (downloadButton) {
    downloadResultFile(downloadButton.dataset.downloadUrl).catch((error) => addLog(error.message, "error"));
    return;
  }
  const button = event.target.closest("[data-original-id]");
  if (!button) return;
  try {
    const file = await getOriginalFile(button.dataset.originalId);
    if (!file) {
      addLog("원본 파일을 찾지 못했습니다.", "error");
      return;
    }
    downloadBlob(file.name, file.blob);
  } catch (error) {
    addLog(error.message || "원본 다운로드 실패", "error");
  }
});

els.historyPagination.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-page]");
  if (!button || button.disabled) return;
  state.historyPage = Number(button.dataset.historyPage);
  renderHistory();
});

els.brandHomeBtn.addEventListener("click", () => {
  showView("main");
});

function getRequests() {
  try {
    return JSON.parse(localStorage.getItem("tojiFeatureRequests") || "[]");
  } catch {
    return [];
  }
}

function saveRequests(requests) {
  localStorage.setItem("tojiFeatureRequests", JSON.stringify(requests));
}

function renderRequests() {
  const requests = getRequests();
  if (!requests.length) {
    els.requestList.innerHTML = `<div class="empty-list">아직 등록된 기능 요청이 없습니다.</div>`;
    return;
  }
  els.requestList.innerHTML = requests.map((item) => `
    <article class="request-item">
      <h2>${escapeHtml(item.title)}</h2>
      <time>${escapeHtml(item.createdAt)}</time>
      <p>${escapeHtml(item.body)}</p>
      ${item.image ? `<img src="${item.image}" alt="첨부 이미지" />` : ""}
    </article>
  `).join("");
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

els.requestImage.addEventListener("change", async () => {
  const image = await readImage(els.requestImage.files[0]);
  els.imagePreview.innerHTML = image ? `<img src="${image}" alt="첨부 이미지 미리보기" />` : "첨부 이미지 없음";
});

els.requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const image = await readImage(els.requestImage.files[0]);
  const requests = getRequests();
  requests.unshift({
    id: Date.now(),
    title: els.requestTitle.value.trim(),
    body: els.requestBody.value.trim(),
    image,
    createdAt: new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date()),
  });
  saveRequests(requests);
  els.requestForm.reset();
  setText(els.imagePreview, "첨부 이미지 없음");
  renderRequests();
});

els.clearRequestsBtn.addEventListener("click", () => {
  if (!confirm("등록된 기능 요청을 모두 삭제할까요?")) return;
  saveRequests([]);
  renderRequests();
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("dragover");
  });
});

els.dropzone.addEventListener("drop", (event) => chooseFile(event.dataTransfer.files[0]));

const COL_UNIT_PRICE = headers.indexOf("단가(원/㎡)");
const COL_TIME_RATE = headers.indexOf("시점수정치");
const COL_TIME_ADJ = headers.indexOf("시점수정");

els.previewBody.addEventListener("input", (event) => {
  const cell = event.target.closest("td[data-col]");
  if (!cell) return;
  const colIndex = Number(cell.dataset.col);
  if (colIndex !== COL_TIME_RATE && colIndex !== COL_UNIT_PRICE) return;
  const row = cell.closest("tr");
  const rowCells = row.querySelectorAll("td[data-col]");
  const getCol = (idx) => [...rowCells].find((td) => Number(td.dataset.col) === idx);
  const rateCell = getCol(COL_TIME_RATE);
  const unitCell = getCol(COL_UNIT_PRICE);
  const adjCell = getCol(COL_TIME_ADJ);
  if (!rateCell || !unitCell || !adjCell) return;
  const rate = parseFloat(rateCell.textContent.replace(/,/g, ""));
  const unitPrice = parseFloat(unitCell.textContent.replace(/,/g, ""));
  if (!isNaN(rate) && !isNaN(unitPrice) && rate > 0 && unitPrice > 0) {
    adjCell.textContent = Math.round(unitPrice * rate).toLocaleString("ko-KR");
  } else {
    adjCell.textContent = "";
  }
});

const gsiYearInput = els.gsiSearchForm?.querySelector(".gsi-year");
if (gsiYearInput && !gsiYearInput.value) gsiYearInput.value = new Date().getFullYear();

renderHead();
addLog("엑셀 파일 업로드를 기다리는 중입니다.");
renderRequests();
renderHistory();
