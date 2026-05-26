const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const UPLOADS = path.join(ROOT, "uploads");
const OUTPUTS = path.join(ROOT, "outputs");
const PYTHON = process.env.PYTHON_EXE || (process.platform === "win32"
  ? "C:\\Users\\daekyo\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe"
  : "python3");
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || "";
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || "";
const MS_TENANT_ID = process.env.MS_TENANT_ID || "common";
const MS_SCOPES = "offline_access User.Read Files.ReadWrite";
const DOWNLOAD_TTL_DAYS = Number(process.env.DOWNLOAD_TTL_DAYS || 14);

const jobs = new Map();
const authStates = new Map();
const realtyCodeCache = {
  sido: null,
  sigungu: new Map(),
  dongri: new Map(),
  roadInitial: new Map(),
  road: new Map()
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }[ext] || "application/octet-stream";
}

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function publicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return process.env.PUBLIC_BASE_URL || `${proto}://${host}`;
}

function microsoftRedirectUri(req) {
  return `${publicBaseUrl(req)}/auth/microsoft/callback`;
}

function microsoftConfigured(req) {
  return {
    enabled: Boolean(MS_CLIENT_ID),
    clientId: MS_CLIENT_ID,
    tenantId: MS_TENANT_ID,
    redirectUri: microsoftRedirectUri(req),
    scopes: MS_SCOPES
  };
}

function expiresAtFromNow() {
  return new Date(Date.now() + DOWNLOAD_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text };
  }
}

async function postFormJson(url, params) {
  const body = new URLSearchParams(params).toString();
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers,
      body
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(data.error?.message || data.error || `API 호출 실패: ${response.status}`);
    }
    return data;
  } catch (error) {
    const code = String(error?.cause?.code || error?.code || "");
    const message = String(error?.message || "");
    if (!url.startsWith("https://www.realtyprice.kr/") || (!code.includes("SELF_SIGNED_CERT") && message !== "fetch failed")) throw error;
    return postFormJsonWithRelaxedTls(url, body, headers);
  }
}

function postFormJsonWithRelaxedTls(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      method: "POST",
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...headers,
        "Content-Length": Buffer.byteLength(body)
      },
      rejectUnauthorized: false
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(text);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(data.error?.message || data.error || `API 호출 실패: ${res.statusCode}`));
            return;
          }
          resolve(data);
        } catch {
          reject(new Error(text || `API 응답 파싱 실패: ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function realtyList(path, params) {
  const data = await postFormJson(`https://www.realtyprice.kr${path}`, params);
  return data?.model?.list || [];
}

function resetRealtyCodeCache() {
  realtyCodeCache.sido = null;
  realtyCodeCache.sigungu.clear();
  realtyCodeCache.dongri.clear();
  realtyCodeCache.roadInitial.clear();
  realtyCodeCache.road.clear();
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function looseName(value) {
  return compactText(value).replace(/특별시|광역시|특별자치시|특별자치도|자치도|도|시|군|구|읍|면|동|리|로|길/g, "");
}

function keywordMatchesName(keyword, name) {
  const q = compactText(keyword);
  const n = compactText(name);
  const looseQ = looseName(keyword);
  const looseN = looseName(name);
  return q.includes(n) || n.includes(q) || (looseN && looseQ.includes(looseN)) || (looseQ && looseN.includes(looseQ));
}

function splitKeywordNumber(keyword) {
  let text = String(keyword || "").trim();
  let san = "1";
  const sanMatch = text.match(/(?:^|\s)산\s*(\d+(?:-\d+)?)/);
  const numMatch = sanMatch || text.match(/(\d+(?:-\d+)?)(?!.*\d)/);
  let number = numMatch?.[1] || "";
  if (sanMatch) san = "2";
  if (numMatch) text = text.slice(0, numMatch.index).trim();
  const [main = "", sub = "0"] = number.split("-");
  return {
    text,
    number,
    san,
    bun1: main.replace(/\D/g, "").padStart(4, "0"),
    bun2: (sub.replace(/\D/g, "") || "0").padStart(4, "0"),
    build_bun1: main.replace(/\D/g, ""),
    build_bun2: (sub.replace(/\D/g, "") || "0").padStart(5, "0")
  };
}

function gsiParamsForParcel(sido, sigungu, dongri, parsed) {
  return {
    search_detail_gbn: "2",
    notice_year: "",
    notice_year_nm: "",
    sido: sido.CODE,
    sido_nm: sido.NAME,
    sigungu: sigungu.CODE,
    sigungu_nm: sigungu.NAME,
    road_reg: sigungu.CODE,
    road_initial: "",
    road_initial_nm: "",
    road_code: "",
    road_code_nm: "",
    dongri: dongri.CODE,
    dongri_nm: dongri.NAME,
    reg: sigungu.CODE,
    eub: dongri.CODE,
    san: parsed.san,
    bun1: parsed.bun1,
    bun2: parsed.bun2,
    build_bun1: "",
    build_bun2: "00000"
  };
}

function gsiParamsForRoad(sido, sigungu, initial, road, parsed) {
  return {
    search_detail_gbn: "1",
    notice_year: "",
    notice_year_nm: "",
    sido: sido.CODE,
    sido_nm: sido.NAME,
    sigungu: sigungu.CODE,
    sigungu_nm: sigungu.NAME,
    road_reg: sigungu.CODE,
    road_initial: initial.CODE,
    road_initial_nm: initial.NAME,
    road_code: road.ROAD_CODE,
    road_code_nm: road.NAME,
    dongri: "",
    dongri_nm: "",
    reg: sigungu.CODE,
    eub: "",
    san: "1",
    bun1: "0000",
    bun2: "0000",
    build_bun1: parsed.build_bun1,
    build_bun2: parsed.build_bun2 || "00000"
  };
}

function formatParcelSuggestionLabel(row, sido, sigungu, dongri, parsed) {
  const addr = row?.addr || `${sido.NAME} ${sigungu.NAME} ${dongri.NAME}`;
  const jibun = row?.jibun || `${parsed.san === "2" ? "산 " : ""}${parsed.number}`;
  const normalizedAddr = compactText(addr).replace(/번지/g, "");
  const normalizedJibun = compactText(jibun).replace(/번지/g, "");
  if (normalizedJibun && normalizedAddr.includes(normalizedJibun)) return addr;
  return `${addr} ${jibun}`.trim();
}

async function getSidoList() {
  if (!realtyCodeCache.sido) {
    realtyCodeCache.sido = await realtyList("/notice/m/bjd/getSido.do", { notice_year: "" });
  }
  return realtyCodeCache.sido;
}

async function getSigunguList(sidoCode) {
  if (!realtyCodeCache.sigungu.has(sidoCode)) {
    realtyCodeCache.sigungu.set(
      sidoCode,
      await realtyList("/notice/m/bjd/getSigungu.do", { notice_year: "", reg1: sidoCode })
    );
  }
  return realtyCodeCache.sigungu.get(sidoCode);
}

async function getDongriList(sigunguCode) {
  if (!realtyCodeCache.dongri.has(sigunguCode)) {
    realtyCodeCache.dongri.set(
      sigunguCode,
      await realtyList("/notice/m/bjd/getDongri.do", { notice_year: "", reg: sigunguCode })
    );
  }
  return realtyCodeCache.dongri.get(sigunguCode);
}

async function getRoadInitialList(sigunguCode) {
  if (!realtyCodeCache.roadInitial.has(sigunguCode)) {
    realtyCodeCache.roadInitial.set(
      sigunguCode,
      await realtyList("/notice/m/road/getRoadInitial.do", { reg: sigunguCode })
    );
  }
  return realtyCodeCache.roadInitial.get(sigunguCode);
}

async function getRoadList(sigunguCode, initialCode) {
  const key = `${sigunguCode}:${initialCode}`;
  if (!realtyCodeCache.road.has(key)) {
    realtyCodeCache.road.set(
      key,
      await realtyList("/notice/m/road/getRoad.do", { reg: sigunguCode, road_initial: initialCode })
    );
  }
  return realtyCodeCache.road.get(key);
}

async function candidateRegions(keyword) {
  const q = compactText(keyword);
  const parsed = splitKeywordNumber(keyword);
  const hasRegionText = compactText(parsed.text).length >= 2;
  const sidos = await getSidoList();
  const sidoMatches = sidos.filter((sido) => keywordMatchesName(q, sido.NAME)).slice(0, 3);
  const selectedSidos = sidoMatches.length ? sidoMatches : sidos;
  const regions = [];
  for (const sido of selectedSidos) {
    const sigungus = await getSigunguList(sido.CODE);
    const sigunguMatches = sigungus.filter((sigungu) => keywordMatchesName(q, sigungu.NAME)).slice(0, 12);
    const orderedSigungus = [...(sigunguMatches.length ? sigunguMatches : (hasRegionText ? sigungus.slice(0, 10) : sigungus))];
    for (const sigungu of orderedSigungus) {
      regions.push({ sido, sigungu });
      if (regions.length >= (hasRegionText ? 24 : 260)) return regions;
    }
  }
  return regions;
}

async function suggestParcel(keyword) {
  const parsed = splitKeywordNumber(keyword);
  const q = compactText(parsed.text || keyword);
  const hasNumber = Boolean(parsed.number && parsed.bun1 !== "0000");
  const hasRegionText = compactText(parsed.text).length >= 2;
  if (hasNumber && !hasRegionText) {
    return [];
  }
  const suggestions = [];
  const candidates = [];
  for (const { sido, sigungu } of await candidateRegions(keyword)) {
    const dongris = await getDongriList(sigungu.CODE);
    const matches = dongris.filter((dongri) => {
      return keywordMatchesName(q, dongri.NAME) || keywordMatchesName(q, sigungu.NAME);
    }).slice(0, 12);
    for (const dongri of (matches.length ? matches : (hasRegionText ? dongris.slice(0, 5) : dongris))) {
      candidates.push({ sido, sigungu, dongri });
    }
  }

  if (hasNumber) {
    const batchSize = 12;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const checked = await Promise.all(batch.map(async ({ sido, sigungu, dongri }) => {
        const params = gsiParamsForParcel(sido, sigungu, dongri, parsed);
        const rows = await realtyList("/notice/m/gsi/getList.do", params);
        if (!rows.length) return null;
        return {
          mode: "parcel",
          label: formatParcelSuggestionLabel(rows[0], sido, sigungu, dongri, parsed),
          detail: `${rows.length}건 · 캐시 미사용 실시간 확인`,
          params
        };
      }));
      suggestions.push(...checked.filter(Boolean));
      if (suggestions.length >= 12) return suggestions.slice(0, 12);
    }
    return suggestions.slice(0, 12);
  }

  for (const { sido, sigungu, dongri } of candidates.slice(0, 12)) {
    suggestions.push({
        mode: "parcel",
        label: `${sido.NAME} ${sigungu.NAME} ${dongri.NAME}${parsed.number ? ` ${parsed.san === "2" ? "산 " : ""}${parsed.number}` : ""}`,
        detail: "행정동 후보",
        params: gsiParamsForParcel(sido, sigungu, dongri, parsed)
    });
  }
  return suggestions;
}

async function suggestRoad(keyword) {
  const parsed = splitKeywordNumber(keyword);
  const q = compactText(parsed.text || keyword);
  const suggestions = [];
  for (const { sido, sigungu } of await candidateRegions(keyword)) {
    const initials = await getRoadInitialList(sigungu.CODE);
    for (const initial of initials) {
      const roads = await getRoadList(sigungu.CODE, initial.CODE);
      const matches = roads.filter((road) => {
        return keywordMatchesName(q, road.NAME);
      }).slice(0, 6);
      for (const road of matches) {
        const params = gsiParamsForRoad(sido, sigungu, initial, road, parsed);
        if (parsed.build_bun1) {
          const rows = await realtyList("/notice/m/gsi/getList.do", params);
          if (!rows.length) continue;
        }
        suggestions.push({
          mode: "road",
          label: `${sido.NAME} ${sigungu.NAME} ${road.NAME}${parsed.number ? ` ${parsed.number}` : ""}`,
          detail: parsed.build_bun1 ? "캐시 미사용 실시간 확인" : "도로명 후보",
          params
        });
        if (suggestions.length >= 12) return suggestions;
      }
    }
  }
  return suggestions;
}

async function enrichGsiParams(params) {
  const enriched = { ...params };
  if (enriched.search_detail_gbn === "1" && enriched.sido && enriched.sigungu && enriched.road_reg && enriched.road_code) {
    return enriched;
  }
  if (enriched.sido && enriched.sigungu && enriched.dongri && enriched.reg && enriched.eub) {
    return enriched;
  }

  const sido = (await getSidoList()).find((row) => row.NAME === enriched.sido_nm);
  if (!sido) throw new Error(`시도 코드를 찾지 못했습니다: ${enriched.sido_nm || ""}`);

  const sigungu = (await getSigunguList(sido.CODE)).find((row) => row.NAME === enriched.sigungu_nm);
  if (!sigungu) throw new Error(`시군구 코드를 찾지 못했습니다: ${enriched.sigungu_nm || ""}`);

  const dongri = (await getDongriList(sigungu.CODE)).find((row) => row.NAME === enriched.dongri_nm);
  if (!dongri) throw new Error(`읍면동 코드를 찾지 못했습니다: ${enriched.dongri_nm || ""}`);

  return {
    ...enriched,
    sido: sido.CODE,
    sido_nm: sido.NAME,
    sigungu: sigungu.CODE,
    sigungu_nm: sigungu.NAME,
    road_reg: sigungu.CODE,
    road_initial: enriched.road_initial || "",
    road_initial_nm: enriched.road_initial_nm || "",
    road_code: enriched.road_code || "",
    road_code_nm: enriched.road_code_nm || "",
    dongri: dongri.CODE,
    dongri_nm: dongri.NAME,
    reg: sigungu.CODE,
    eub: dongri.CODE,
  };
}

function parseMultipart(buffer, contentTypeHeader) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || "");
  if (!match) throw new Error("multipart boundary missing");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer.slice(cursor, cursor + 2).toString() === "--") break;
    if (buffer.slice(cursor, cursor + 2).toString() === "\r\n") cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd === -1) break;
    const rawHeaders = buffer.slice(cursor, headerEnd).toString("utf8");
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    let data = buffer.slice(headerEnd + 4, next);
    if (data.slice(-2).toString() === "\r\n") data = data.slice(0, -2);
    const name = /name="([^"]+)"/.exec(rawHeaders)?.[1];
    const filename = /filename="([^"]*)"/.exec(rawHeaders)?.[1];
    parts.push({ name, filename, data });
    cursor = next;
  }
  return parts;
}

function safeFileName(name) {
  const ext = path.extname(name || "").toLowerCase() || ".xlsx";
  return `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`;
}

function todayKorea() {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(new Date());
}

async function nextDownloadOutputPath() {
  const date = todayKorea();
  const baseDir = path.join(os.homedir(), "Downloads", "토지거래 정리");
  const datedDir = path.join(baseDir, `토지거래 정리 ${date}`);
  await fsp.mkdir(datedDir, { recursive: true });

  for (let version = 1; version < 1000; version += 1) {
    const fileName = `토지거래 정리 ${date} 수정v${version}.xlsx`;
    const candidate = path.join(datedDir, fileName);
    try {
      await fsp.access(candidate);
    } catch {
      return { outputPath: candidate, date, version, fileName, folder: datedDir };
    }
  }
  throw new Error("사용 가능한 수정버전 파일명을 찾지 못했습니다.");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(PUBLIC, pathname));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function startJob(req, res) {
  await fsp.mkdir(UPLOADS, { recursive: true });
  await fsp.mkdir(OUTPUTS, { recursive: true });

  const body = await readBody(req);
  const parts = parseMultipart(body, req.headers["content-type"]);
  const file = parts.find((part) => part.name === "file" && part.filename);
  if (!file) return sendJson(res, 400, { error: "엑셀 파일을 찾지 못했습니다." });

  const jobId = crypto.randomBytes(8).toString("hex");
  const input = path.join(UPLOADS, safeFileName(file.filename));
  const saveTarget = await nextDownloadOutputPath();
  const output = saveTarget.outputPath;
  const summary = path.join(OUTPUTS, `${jobId}-summary.json`);
  await fsp.writeFile(input, file.data);

  jobs.set(jobId, {
    id: jobId,
    status: "running",
    fileName: file.filename,
    progress: "업로드 완료. 원본 분석을 시작합니다.",
    preview: [],
    warnings: [],
    output,
    savedFileName: saveTarget.fileName,
    savedFolder: saveTarget.folder,
    savedPath: saveTarget.outputPath,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAtFromNow()
  });

  const child = spawn(PYTHON, [path.join(ROOT, "processor.py"), input, output, summary], {
    cwd: ROOT,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    const job = jobs.get(jobId);
    if (job && text) job.progress = text.split(/\r?\n/).at(-1);
  });

  child.stderr.on("data", (chunk) => {
    const job = jobs.get(jobId);
    if (job) job.progress = chunk.toString("utf8").trim().split(/\r?\n/).at(-1);
  });

  child.on("close", async (code) => {
    const job = jobs.get(jobId);
    if (!job) return;
    if (code !== 0) {
      job.status = "failed";
      job.error = job.progress || "처리 중 오류가 발생했습니다.";
      return;
    }
    try {
      const parsed = JSON.parse(await fsp.readFile(summary, "utf8"));
      Object.assign(job, parsed, {
        status: "done",
        progress: "처리 완료. 엑셀 다운로드가 가능합니다.",
        downloadUrl: `/api/download/${jobId}`,
        savedFileName: saveTarget.fileName,
        savedFolder: saveTarget.folder,
        savedPath: saveTarget.outputPath,
        expiresAt: job.expiresAt
      });
    } catch (error) {
      job.status = "failed";
      job.error = `결과 요약을 읽지 못했습니다: ${error.message}`;
    }
  });

  sendJson(res, 202, { jobId });
}

async function handleJob(req, res, id) {
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { error: "작업을 찾지 못했습니다." });
  sendJson(res, 200, job);
}

async function download(req, res, id) {
  const job = jobs.get(id);
  if (!job || job.status !== "done") {
    sendJson(res, 404, { error: "다운로드할 완료 파일을 찾지 못했습니다. 서버가 재시작된 경우 다시 분석해 주세요." });
    return;
  }
  if (job.expiresAt && Date.now() > Date.parse(job.expiresAt)) {
    sendJson(res, 410, { error: "다운로드 가능 기간이 만료되었습니다. 다시 분석해 주세요." });
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(job.output),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(job.savedFileName || `토지거래_자동정리_${id}.xlsx`)}`
  });
  fs.createReadStream(job.output).pipe(res);
}

async function openOutputFolder(req, res, id) {
  const job = jobs.get(id);
  if (!job || job.status !== "done" || !job.savedFolder) {
    sendJson(res, 404, { error: "열 수 있는 저장 폴더가 없습니다." });
    return;
  }
  if (process.platform !== "win32") {
    sendJson(res, 400, { error: "배포 서버에서는 사용자 PC의 로컬 폴더를 직접 열 수 없습니다. 다운로드한 파일은 브라우저 다운로드 폴더에서 확인해 주세요." });
    return;
  }
  spawn("explorer.exe", [job.savedFolder], { detached: true, stdio: "ignore" }).unref();
  sendJson(res, 200, { ok: true, folder: job.savedFolder });
}

async function m365Status(req, res) {
  sendJson(res, 200, microsoftConfigured(req));
}

async function m365Start(req, res, id) {
  if (!MS_CLIENT_ID) {
    sendJson(res, 400, {
      error: "M365 연동을 사용하려면 Render 환경변수 MS_CLIENT_ID를 먼저 설정해야 합니다.",
      redirectUri: microsoftRedirectUri(req)
    });
    return;
  }
  const job = jobs.get(id);
  if (!job || job.status !== "done") {
    sendJson(res, 404, { error: "먼저 엑셀 처리를 완료한 뒤 Office 365 편집을 실행해 주세요." });
    return;
  }

  const state = crypto.randomBytes(18).toString("hex");
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  authStates.set(state, {
    jobId: id,
    codeVerifier,
    redirectUri: microsoftRedirectUri(req),
    createdAt: Date.now()
  });

  const authUrl = new URL(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", MS_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", microsoftRedirectUri(req));
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", MS_SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function exchangeMicrosoftToken(code, authState) {
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    scope: MS_SCOPES,
    code,
    redirect_uri: authState.redirectUri,
    grant_type: "authorization_code",
    code_verifier: authState.codeVerifier
  });
  if (MS_CLIENT_SECRET) params.set("client_secret", MS_CLIENT_SECRET);

  const response = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Microsoft 토큰 발급에 실패했습니다.");
  }
  return data.access_token;
}

async function uploadToOneDrive(accessToken, filePath, fileName) {
  const buffer = await fsp.readFile(filePath);
  const graphPath = encodeURIComponent(fileName);
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${graphPath}:/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": contentType(filePath)
    },
    body: buffer
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error?.message || data.error || "OneDrive 업로드에 실패했습니다.");
  }
  return data;
}

async function microsoftCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) {
    sendJson(res, 400, { error, description: url.searchParams.get("error_description") });
    return;
  }
  const authState = authStates.get(state);
  authStates.delete(state);
  if (!code || !authState) {
    sendJson(res, 400, { error: "Microsoft 로그인 상태값을 확인하지 못했습니다. 다시 시도해 주세요." });
    return;
  }
  if (Date.now() - authState.createdAt > 10 * 60 * 1000) {
    sendJson(res, 400, { error: "Microsoft 로그인 시간이 만료되었습니다. 다시 시도해 주세요." });
    return;
  }

  const job = jobs.get(authState.jobId);
  if (!job || job.status !== "done") {
    sendJson(res, 404, { error: "업로드할 완료 파일을 찾지 못했습니다." });
    return;
  }

  try {
    const accessToken = await exchangeMicrosoftToken(code, authState);
    const item = await uploadToOneDrive(accessToken, job.output, job.savedFileName || path.basename(job.output));
    res.writeHead(302, { Location: item.webUrl || publicBaseUrl(req) });
    res.end();
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function patchCells(req, res, id) {
  const job = jobs.get(id);
  if (!job || job.status !== "done") {
    return sendJson(res, 404, { error: "완료된 작업을 찾지 못했습니다." });
  }
  let patches;
  try {
    const body = await readBody(req);
    patches = JSON.parse(body.toString("utf8")).patches;
    if (!Array.isArray(patches)) throw new Error("patches 배열이 필요합니다.");
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [path.join(ROOT, "patcher.py"), job.output], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stdin.write(JSON.stringify(patches), "utf8");
    child.stdin.end();
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => {
      if (code !== 0) {
        sendJson(res, 500, { error: stderr.trim() || "셀 저장에 실패했습니다." });
      } else {
        sendJson(res, 200, { ok: true, downloadUrl: `/api/download/${id}` });
      }
      resolve();
    });
  });
}

async function verifyGsi(req, res, url) {
  const params = Object.fromEntries(url.searchParams.entries());
  const fetchedAt = new Date().toISOString();
  try {
    const enrichedParams = await enrichGsiParams(params);
    const data = await postFormJson("https://www.realtyprice.kr/notice/m/gsi/getList.do", enrichedParams);
    sendJson(res, 200, {
      source: "realtyprice.kr",
      freshness: "real-time",
      fetchedAt,
      notice: "캐시를 사용하지 않고 realtyprice.kr API에서 실시간 조회만 사용한 값입니다.",
      method: "POST",
      endpoint: "https://www.realtyprice.kr/notice/m/gsi/getList.do",
      searchPage: "https://www.realtyprice.kr/notice/m/gsi/search.do",
      params: enrichedParams,
      rows: data?.model?.list || [],
      raw: data
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error.message,
      freshness: "real-time",
      fetchedAt,
      method: "POST",
      endpoint: "https://www.realtyprice.kr/notice/m/gsi/getList.do",
      searchPage: "https://www.realtyprice.kr/notice/m/gsi/search.do",
      params
    });
  }
}

async function suggestGsi(req, res, url) {
  const mode = url.searchParams.get("mode") === "road" ? "road" : "parcel";
  const keyword = url.searchParams.get("q") || "";
  const fetchedAt = new Date().toISOString();
  if (keyword.trim().length < 2) {
    sendJson(res, 200, { mode, keyword, freshness: "real-time", fetchedAt, suggestions: [] });
    return;
  }
  try {
    const suggestions = mode === "road"
      ? await suggestRoad(keyword)
      : await suggestParcel(keyword);
    sendJson(res, 200, {
      mode,
      keyword,
      freshness: "real-time-api-verified",
      fetchedAt,
      endpoint: "https://www.realtyprice.kr/notice/m/gsi/getList.do",
      suggestions
    });
  } catch (error) {
    sendJson(res, 502, { mode, keyword, freshness: "real-time", fetchedAt, error: error.message, suggestions: [] });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/process") return startJob(req, res);
    if (req.method === "GET" && url.pathname.startsWith("/api/job/")) return handleJob(req, res, url.pathname.split("/").pop());
    if (req.method === "GET" && url.pathname.startsWith("/api/download/")) return download(req, res, url.pathname.split("/").pop());
    if (req.method === "POST" && url.pathname.startsWith("/api/open-folder/")) return openOutputFolder(req, res, url.pathname.split("/").pop());
    if (req.method === "GET" && url.pathname === "/api/m365/status") return m365Status(req, res);
    if (req.method === "GET" && url.pathname.startsWith("/api/m365/start/")) return m365Start(req, res, url.pathname.split("/").pop());
    if (req.method === "POST" && url.pathname.startsWith("/api/patch-cells/")) return patchCells(req, res, url.pathname.split("/").pop());
    if (req.method === "GET" && url.pathname === "/api/realtyprice/gsi/suggest") return suggestGsi(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/realtyprice/gsi") return verifyGsi(req, res, url);
    if (req.method === "GET" && url.pathname === "/auth/microsoft/callback") return microsoftCallback(req, res, url);
    return serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`http://${HOST}:${PORT}`);
});
