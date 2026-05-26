const formEl = document.querySelector("#verifyForm");
const statusEl = document.querySelector("#verifyStatus");
const paramsEl = document.querySelector("#verifyParams");
const headEl = document.querySelector("#resultHead");
const bodyEl = document.querySelector("#resultBody");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function splitJibun(value) {
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

function renderParams(params) {
  paramsEl.textContent = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function renderRows(rows) {
  if (!rows.length) {
    headEl.innerHTML = "";
    bodyEl.innerHTML = `<tr><td class="empty">조회결과가 없습니다.</td></tr>`;
    return;
  }
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  headEl.innerHTML = `<tr>${keys.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr>`;
  bodyEl.innerHTML = rows.map((row) => `
    <tr>${keys.map((key) => `<td>${escapeHtml(row[key])}</td>`).join("")}</tr>
  `).join("");
}

function paramsFromForm() {
  const data = new FormData(formEl);
  const jibun = splitJibun(data.get("jibun"));
  return {
    search_detail_gbn: "2",
    notice_year: data.get("notice_year") || "",
    notice_year_nm: "",
    sido_nm: data.get("sido_nm") || "",
    sigungu_nm: data.get("sigungu_nm") || "",
    dongri_nm: data.get("dongri_nm") || "",
    san: jibun.san,
    bun1: jibun.bun1,
    bun2: jibun.bun2,
    build_bun1: "",
    build_bun2: "00000",
  };
}

function fillFormFromQuery() {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of params.entries()) {
    const input = formEl.elements[key];
    if (input) input.value = value;
  }
  if (!formEl.elements.jibun.value && params.get("bun1")) {
    const main = String(Number(params.get("bun1")));
    const sub = String(Number(params.get("bun2") || "0"));
    const prefix = params.get("san") === "2" ? "산 " : "";
    formEl.elements.jibun.value = sub === "0" ? `${prefix}${main}` : `${prefix}${main}-${sub}`;
  }
}

async function search(params) {
  renderParams(params);
  statusEl.textContent = "조회 중";
  bodyEl.innerHTML = `<tr><td class="empty">조회 중입니다.</td></tr>`;
  const response = await fetch(`/api/realtyprice/gsi?${new URLSearchParams(params).toString()}`);
  const data = await response.json();
  if (!response.ok) {
    statusEl.textContent = `실패: ${data.error || "조회 실패"}`;
    bodyEl.innerHTML = `<tr><td class="empty">${escapeHtml(data.error || "조회 실패")}</td></tr>`;
    return;
  }
  statusEl.textContent = `성공: ${data.rows.length}건`;
  renderRows(data.rows);
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  search(paramsFromForm()).catch((error) => {
    statusEl.textContent = `실패: ${error.message}`;
    bodyEl.innerHTML = `<tr><td class="empty">${escapeHtml(error.message)}</td></tr>`;
  });
});

fillFormFromQuery();
if (window.location.search) {
  search(Object.fromEntries(new URLSearchParams(window.location.search).entries()));
} else {
  renderParams(paramsFromForm());
}
