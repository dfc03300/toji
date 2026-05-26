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

function renderParams(params) {
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  paramsEl.textContent = entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}

function renderRows(rows) {
  if (!rows.length) {
    bodyEl.innerHTML = `<tr><td class="empty">조회결과가 없습니다.</td></tr>`;
    return;
  }
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  headEl.innerHTML = `<tr>${keys.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr>`;
  bodyEl.innerHTML = rows.map((row) => `
    <tr>${keys.map((key) => `<td>${escapeHtml(row[key])}</td>`).join("")}</tr>
  `).join("");
}

async function load() {
  const params = new URLSearchParams(window.location.search);
  renderParams(params);
  const response = await fetch(`/api/realtyprice/gsi?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) {
    statusEl.textContent = `실패: ${data.error || "조회 실패"}`;
    bodyEl.innerHTML = `<tr><td class="empty">${escapeHtml(data.error || "조회 실패")}</td></tr>`;
    return;
  }
  statusEl.textContent = `성공: ${data.rows.length}건`;
  renderRows(data.rows);
}

load().catch((error) => {
  statusEl.textContent = `실패: ${error.message}`;
  bodyEl.innerHTML = `<tr><td class="empty">${escapeHtml(error.message)}</td></tr>`;
});
