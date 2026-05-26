const http = require("node:http");
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

const jobs = new Map();
const authStates = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
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
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: new URLSearchParams(params)
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error?.message || data.error || `API 호출 실패: ${response.status}`);
  }
  return data;
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
    savedPath: saveTarget.outputPath
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
        savedPath: saveTarget.outputPath
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
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(job.output),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(job.savedFileName || `토지거래_자동정리_${id}.xlsx`)}`
  });
  fs.createReadStream(job.output).pipe(res);
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

async function verifyGsi(req, res, url) {
  const params = Object.fromEntries(url.searchParams.entries());
  try {
    const data = await postFormJson("https://www.realtyprice.kr/notice/m/gsi/getList.do", params);
    sendJson(res, 200, {
      source: "realtyprice.kr",
      method: "POST",
      endpoint: "https://www.realtyprice.kr/notice/m/gsi/getList.do",
      searchPage: "https://www.realtyprice.kr/notice/m/gsi/search.do",
      params,
      rows: data?.model?.list || [],
      raw: data
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error.message,
      method: "POST",
      endpoint: "https://www.realtyprice.kr/notice/m/gsi/getList.do",
      searchPage: "https://www.realtyprice.kr/notice/m/gsi/search.do",
      params
    });
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
    if (req.method === "GET" && url.pathname === "/api/m365/status") return m365Status(req, res);
    if (req.method === "GET" && url.pathname.startsWith("/api/m365/start/")) return m365Start(req, res, url.pathname.split("/").pop());
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
