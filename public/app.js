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
};

const els = {
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  fileName: document.querySelector("#fileName"),
  fileMeta: document.querySelector("#fileMeta"),
  processBtn: document.querySelector("#processBtn"),
  serverStatus: document.querySelector("#serverStatus"),
  steps: [...document.querySelectorAll("#steps span")],
  downloadBtn: document.querySelector("#downloadBtn"),
  savePath: document.querySelector("#savePath"),
  copyPathBtn: document.querySelector("#copyPathBtn"),
  previewHead: document.querySelector("#previewHead"),
  previewBody: document.querySelector("#previewBody"),
  summaryText: document.querySelector("#summaryText"),
  sheetName: document.querySelector("#sheetName"),
  officeBtn: document.querySelector("#officeBtn"),
  devViewBtn: document.querySelector("#devViewBtn"),
  historyViewBtn: document.querySelector("#historyViewBtn"),
  backToMainBtn: document.querySelector("#backToMainBtn"),
  backFromHistoryBtn: document.querySelector("#backFromHistoryBtn"),
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
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
};

function nowTime() {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function todayLabel() {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit" }).format(new Date());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function setStep(index) {
  els.steps.forEach((step, i) => {
    step.classList.toggle("active", i === index);
    step.classList.toggle("done", i < index);
  });
}

function setServerStatus(text) {
  if (els.serverStatus) els.serverStatus.textContent = text;
}

function showView(view) {
  els.mainView.classList.toggle("hidden", view !== "main");
  els.devView.classList.toggle("hidden", view !== "dev");
  els.historyView.classList.toggle("hidden", view !== "history");
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

function upsertHistory(item) {
  const history = getHistory().filter((entry) => entry.jobId !== item.jobId);
  history.unshift(item);
  saveHistory(history.slice(0, 100));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  if (!history.length) {
    els.historyList.innerHTML = `<div class="empty-list">아직 작업 히스토리가 없습니다.</div>`;
    return;
  }
  els.historyList.innerHTML = history.map((item) => {
    const expired = item.expiresAt && Date.now() > Date.parse(item.expiresAt);
    const download = expired
      ? `<span class="history-expired">만료됨</span>`
      : `<a href="${item.downloadUrl}" download>다운로드</a>`;
    return `
      <div class="history-item">
        <div><strong>${escapeHtml(item.fileName || "-")}</strong><span>업로드 파일</span></div>
        <div><strong>${escapeHtml(item.version || "-")}</strong><span>버전</span></div>
        <div><strong>${escapeHtml(item.createdAt || "-")}</strong><span>작업일시</span></div>
        <div><strong>${escapeHtml(item.savedFileName || "-")}</strong><span>다운로드 파일</span></div>
        <div>${download}<br><span>${escapeHtml(item.expiresAt ? `만료 ${item.expiresAt.slice(0, 10)}` : "")}</span></div>
      </div>
    `;
  }).join("");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function chooseFile(file) {
  if (!file) return;
  state.file = file;
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${formatBytes(file.size)} · 업로드 준비 완료`;
  els.processBtn.disabled = false;
  els.processBtn.classList.remove("complete");
  els.processBtn.textContent = "파일 분석";
  setServerStatus("파일 선택");
  addLog(`Selected file: ${file.name} (${formatBytes(file.size)})`);
  upsertHistory({
    jobId: `pending-${Date.now()}`,
    fileName: file.name,
    version: "분석 전",
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
  if (header === "개별공시지가") return /^조회완료/.test(String(row["크롤링상태"] || ""));
  return false;
}

function renderPreview(rows) {
  renderHead();
  els.rowCount.textContent = `${rows?.length || 0} rows`;
  if (!rows?.length) {
    els.previewBody.innerHTML = `<tr><td class="row-head">1</td><td class="empty" colspan="${headers.length}">업로드 후 결과 미리보기가 표시됩니다.</td></tr>`;
    return;
  }

  els.previewBody.innerHTML = rows
    .map((row, rowIndex) => {
      const cells = headers
        .map((header) => {
          const className = isCrawledCell(header, row) ? " class=\"crawled\"" : "";
          return `<td${className} contenteditable="true" spellcheck="false">${escapeHtml(valueText(row[header]))}</td>`;
        })
        .join("");
      return `<tr><td class="row-head">${rowIndex + 1}</td>${cells}</tr>`;
    })
    .join("");
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
    els.downloadBtn.textContent = "엑셀 다운로드 가능";
    state.currentJobId = job.id;
    els.savePath.textContent = job.savedPath || "저장 위치를 확인하지 못했습니다.";
    els.summaryText.textContent = `${job.caseCount || 0}건을 자동정리 탭에 작성했습니다.`;
    els.sheetName.textContent = job.sheetName || "자동정리";
    addLog(`Completed: ${job.caseCount || 0} rows written to ${job.sheetName || "자동정리"}`, "success");
    upsertHistory({
      jobId: job.id,
      fileName: job.fileName,
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
    renderPreview(job.preview);
    els.processBtn.disabled = false;
    els.processBtn.classList.add("complete");
    els.processBtn.textContent = "분석 완료";
  }
}

async function startProcess() {
  if (!state.file) return;
  state.lastProgress = "";
  els.processBtn.disabled = true;
  els.processBtn.classList.remove("complete");
  els.processBtn.textContent = "분석 중";
  els.downloadBtn.classList.add("disabled");
  els.downloadBtn.classList.remove("complete");
  els.downloadBtn.textContent = "엑셀 다운로드";
  els.downloadBtn.href = "#";
  els.savePath.textContent = "저장 위치는 완료 후 표시됩니다.";
  setServerStatus("처리 중");
  setStep(0);
  addLog("Uploading workbook...");

  const form = new FormData();
  form.append("file", state.file);
  const response = await fetch("/api/process", { method: "POST", body: form });
  const data = await response.json();
  if (!response.ok) {
    els.processBtn.disabled = false;
    setServerStatus("오류");
    throw new Error(data.error || "업로드 실패");
  }
  addLog(`Job accepted: ${data.jobId}`);
  state.timer = setInterval(() => poll(data.jobId).catch((error) => {
    clearInterval(state.timer);
    setServerStatus("오류");
    addLog(error.message, "error");
    els.processBtn.disabled = false;
  }), 1200);
  await poll(data.jobId);
}

els.fileInput.addEventListener("change", (event) => chooseFile(event.target.files[0]));
els.processBtn.addEventListener("click", () => startProcess().catch((error) => {
  addLog(error.message, "error");
  els.processBtn.disabled = false;
}));

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

els.backFromHistoryBtn.addEventListener("click", () => {
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
  els.imagePreview.textContent = "첨부 이미지 없음";
  renderRequests();
});

els.clearRequestsBtn.addEventListener("click", () => {
  if (!confirm("등록된 기능 요청을 모두 삭제할까요?")) return;
  saveRequests([]);
  renderRequests();
});

els.clearHistoryBtn.addEventListener("click", () => {
  if (!confirm("작업 히스토리를 모두 삭제할까요?")) return;
  saveHistory([]);
  renderHistory();
});

els.savePath.addEventListener("click", async () => {
  if (!state.currentJobId) {
    addLog("아직 열 저장 경로가 없습니다.", "error");
    return;
  }
  const response = await fetch(`/api/open-folder/${state.currentJobId}`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) {
    addLog(result.error || "저장 폴더를 열지 못했습니다.", "error");
    return;
  }
  addLog(`Opened folder: ${result.folder}`);
});

els.copyPathBtn.addEventListener("click", async (event) => {
  event.stopPropagation();
  const text = els.savePath.textContent.trim();
  if (!text || text === "완료 후 표시" || text === "저장 위치는 완료 후 표시됩니다.") {
    addLog("복사할 저장 경로가 아직 없습니다.", "error");
    return;
  }
  await navigator.clipboard.writeText(text);
  addLog("저장 경로를 클립보드에 복사했습니다.");
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

renderHead();
addLog("Waiting for workbook upload.");
renderRequests();
renderHistory();
