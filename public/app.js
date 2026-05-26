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
  "크롤링상세",
  "크롤링URL",
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
};

const els = {
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  fileName: document.querySelector("#fileName"),
  fileMeta: document.querySelector("#fileMeta"),
  processBtn: document.querySelector("#processBtn"),
  serverStatus: document.querySelector("#serverStatus"),
  progressText: document.querySelector("#progressText"),
  steps: [...document.querySelectorAll("#steps li")],
  downloadBtn: document.querySelector("#downloadBtn"),
  savePath: document.querySelector("#savePath"),
  previewHead: document.querySelector("#previewHead"),
  previewBody: document.querySelector("#previewBody"),
  summaryText: document.querySelector("#summaryText"),
  sheetName: document.querySelector("#sheetName"),
  officeBtn: document.querySelector("#officeBtn"),
};

function setStep(index) {
  els.steps.forEach((step, i) => {
    step.classList.toggle("active", i === index);
    step.classList.toggle("done", i < index);
  });
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
  els.serverStatus.textContent = "파일 선택됨";
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

function renderPreview(rows) {
  renderHead();
  if (!rows?.length) {
    els.previewBody.innerHTML = `<tr><td class="row-head">1</td><td class="empty" colspan="${headers.length}">업로드 후 결과 미리보기가 표시됩니다.</td></tr>`;
    return;
  }

  els.previewBody.innerHTML = rows
    .map((row, rowIndex) => {
      const cells = headers
        .map((header) => `<td contenteditable="true" spellcheck="false">${valueText(row[header])}</td>`)
        .join("");
      return `<tr><td class="row-head">${rowIndex + 1}</td>${cells}</tr>`;
    })
    .join("");
}

async function poll(jobId) {
  const response = await fetch(`/api/job/${jobId}`);
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || "작업 상태를 읽지 못했습니다.");

  els.progressText.textContent = job.progress || "처리 중입니다.";
  if (/조회/.test(job.progress || "")) setStep(2);
  else if (/저장|완료/.test(job.progress || "")) setStep(3);
  else setStep(1);

  if (job.status === "failed") {
    clearInterval(state.timer);
    els.serverStatus.textContent = "실패";
    els.progressText.innerHTML = `<span class="error">${job.error || "처리 실패"}</span>`;
    els.processBtn.disabled = false;
    return;
  }

  if (job.status === "done") {
    clearInterval(state.timer);
    setStep(3);
    els.steps.at(-1).classList.add("done");
    els.serverStatus.textContent = "완료";
    els.downloadBtn.href = job.downloadUrl;
    els.downloadBtn.classList.remove("disabled");
    els.savePath.textContent = job.savedPath ? `저장됨: ${job.savedPath}` : "저장 위치를 확인하지 못했습니다.";
    els.summaryText.textContent = `${job.caseCount || 0}건을 자동정리 탭에 작성했습니다.`;
    els.sheetName.textContent = job.sheetName || "자동정리";
    renderPreview(job.preview);
    els.processBtn.disabled = false;
  }
}

async function startProcess() {
  if (!state.file) return;
  els.processBtn.disabled = true;
  els.downloadBtn.classList.add("disabled");
  els.downloadBtn.href = "#";
  els.savePath.textContent = "저장 위치는 완료 후 표시됩니다.";
  els.serverStatus.textContent = "처리 중";
  els.progressText.textContent = "파일을 업로드하는 중입니다.";
  setStep(0);

  const form = new FormData();
  form.append("file", state.file);
  const response = await fetch("/api/process", { method: "POST", body: form });
  const data = await response.json();
  if (!response.ok) {
    els.processBtn.disabled = false;
    els.serverStatus.textContent = "오류";
    throw new Error(data.error || "업로드 실패");
  }
  state.timer = setInterval(() => poll(data.jobId).catch((error) => {
    clearInterval(state.timer);
    els.serverStatus.textContent = "오류";
    els.progressText.innerHTML = `<span class="error">${error.message}</span>`;
    els.processBtn.disabled = false;
  }), 1200);
  await poll(data.jobId);
}

els.fileInput.addEventListener("change", (event) => chooseFile(event.target.files[0]));
els.processBtn.addEventListener("click", () => startProcess().catch((error) => {
  els.progressText.innerHTML = `<span class="error">${error.message}</span>`;
  els.processBtn.disabled = false;
}));

els.officeBtn.addEventListener("click", () => {
  els.progressText.textContent = "Office 365 편집 연동은 Microsoft 로그인, OneDrive 업로드, Graph API 연결이 필요합니다.";
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
