const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT || 5180);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const UPLOADS = path.join(ROOT, "uploads");
const OUTPUTS = path.join(ROOT, "outputs");
const PYTHON = process.env.PYTHON_EXE || "C:\\Users\\daekyo\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";

const jobs = new Map();

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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
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
    return serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${PORT}`);
});
