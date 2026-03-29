/**
 * AI Exporter HTTP server.
 * Provides REST API + SSE endpoints consumed by the Web UI and CLI `serve`.
 * Binds to 127.0.0.1 by default (loopback-only, no external exposure).
 */

import http from "node:http";
import path from "node:path";
import fs from "fs-extra";
import { fileURLToPath } from "node:url";
import log from "../logger.js";
import {
  createJob, getJob, updateJob, finishJob, failJob, cancelJob,
  addSseListener, removeSseListener,
} from "./store.js";
import { scanAllTools } from "../../core/scan.js";
import { normalizeAll } from "../../core/normalize.js";
import { collectAllVscdbRecords } from "../../core/cursor_sqlite.js";
import { validateAll } from "../../core/schema-validator.js";
import { toTrainingJsonl, toMarkdownAll, computeStats } from "../../core/convert.js";
import os from "node:os";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { AgentTransformer } from "../../adapter/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIEWER_DIR = path.resolve(__dirname, "../../viewer");
const OUTPUT_DIR = path.resolve("./agent-backup");

const EXPORTER_VERSION = "2.0.0";
const SCHEMA_VERSION = "1.0.0";

// ─── Router ───────────────────────────────────────────────────────────────────

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  // CORS headers for dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") return respond(res, 204, null);

  log.debug(`${method} ${pathname}`);

  // ── Favicon
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  // ── Health / Version
  if (method === "GET" && pathname === "/api/health") return respond(res, 200, { status: "ok" });
  if (method === "GET" && pathname === "/api/version") return respond(res, 200, { version: EXPORTER_VERSION, schema_version: SCHEMA_VERSION });

  // ── Scan
  if (method === "POST" && pathname === "/api/scan") return handleScan(req, res);
  if (method === "GET" && /^\/api\/scan\//.test(pathname)) return handleScanResult(req, res, url);

  // ── Export / Import / Convert
  if (method === "POST" && pathname === "/api/export") return handleExport(req, res);
  if (method === "POST" && pathname === "/api/import") return handleImport(req, res);
  if (method === "POST" && pathname === "/api/convert") return handleConvert(req, res);

  // ── Stats
  if (method === "POST" && pathname === "/api/stats") return handleStats(req, res);

  // ── Import file (multipart)
  if (method === "POST" && pathname === "/api/import-file") return handleImportFile(req, res);

  // ── Import to agent (write to agent directories)
  if (method === "POST" && pathname === "/api/import-to-agent") return handleImportToAgent(req, res);

  // ── List supported agents
  if (method === "GET" && pathname === "/api/agents") return handleListAgents(req, res);

  // ── Plugins
  if (method === "POST" && pathname === "/api/plugins/desensitize") return handlePluginDesensitize(req, res);
  if (method === "POST" && pathname === "/api/plugins/privacy") return handlePluginPrivacy(req, res);
  if (method === "POST" && pathname === "/api/plugins/assets") return handlePluginAssets(req, res);
  if (method === "POST" && pathname === "/api/plugins/prune") return handlePluginPrune(req, res);
  if (method === "POST" && pathname === "/api/plugins/chitchat") return handlePluginChitchat(req, res);
  if (method === "POST" && pathname === "/api/plugins/secrets") return handlePluginSecrets(req, res);

  // ── Settings
  if (method === "GET" && pathname === "/api/settings") return handleSettings(req, res);
  if (method === "POST" && pathname === "/api/settings") return handleSettings(req, res);

  // ── Jobs
  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(\/events|\/cancel)?$/);
  if (jobMatch) {
    const jobId = jobMatch[1];
    const sub = jobMatch[2];
    if (sub === "/events" && method === "GET") return handleJobSSE(req, res, jobId);
    if (sub === "/cancel" && method === "POST") return handleJobCancel(req, res, jobId);
    if (!sub && method === "GET") return handleJobStatus(req, res, jobId);
  }
  
  // ── Adapter (Agent Sync)
  const adapterMatch = pathname.match(/^\/api\/adapter\/([^/]+)(\/import|\/export)?$/);
  if (adapterMatch) {
    const agent = adapterMatch[1];
    const action = adapterMatch[2];
    if (method === "GET" && !action) return handleAdapterPreview(req, res, agent);
    if (method === "POST" && action === "/import") return handleAdapterImport(req, res, agent);
    if (method === "GET" && action === "/export") return handleAdapterExport(req, res, agent);
  }

  // ── Threads (paginated)
  if (method === "GET" && pathname === "/api/threads") return handleThreads(req, res, url);

  // ── Static frontend
  return serveStatic(req, res, pathname);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleScan(req, res) {
  const body = await readBody(req);
  const workspace = body.workspace || os.homedir();
  const dataDir = body.dataDir || OUTPUT_DIR;
  const jobId = createJob("scan");
  respond(res, 202, { job_id: jobId });

  // 累计已保存的记录
  let savedRecords = [];

  // Run async - 使用增量扫描
  (async () => {
    try {
      updateJob(jobId, { status: "running", message: "Initializing..." });

      const { scanAllToolsIncremental } = await import("../../core/scan.js");
      
      const files = await scanAllToolsIncremental({
        onProgress: (phase, depth, done, total, msg) => {
          // 阶段进度: 0-25% 第一阶段, 25-50% 第二阶段, etc.
          const baseProgress = (phase - 1) * 25;
          const phaseProgress = total > 0 ? Math.round((done / total) * 25) : 0;
          const progress = Math.min(baseProgress + phaseProgress, phase * 25);
          
          updateJob(jobId, { 
            progress, 
            phase, 
            depth,
            totalFound: done,
            message: `[深度${depth}] ${msg}` 
          });
        },
        onChunk: async (records, info) => {
          // 每阶段完成时实时保存
          const { saveRecordsToDir } = await import("../../core/convert.js");
          await saveRecordsToDir(records, dataDir);
          savedRecords.push(...records);
          
          // 推送实时更新到前端
          const normalized = normalizeAll(records);
          updateJob(jobId, { 
            message: `Depth ${info.depth}: +${records.length} records`,
            realtimeRecords: normalized.slice(0, 20) // 推送前20条
          });
        },
      });

      updateJob(jobId, { progress: 50, message: "Scanning IDE databases..." });

      const sqliteRecords = await collectAllVscdbRecords();

      updateJob(jobId, { progress: 70, message: "Normalizing..." });
      const fileRecords = normalizeAll(files);
      const allRecords = [...savedRecords, ...fileRecords, ...sqliteRecords];

      // 去重
      const uniqueMap = new Map();
      for (const r of allRecords) {
        if (!uniqueMap.has(r.thread_id)) {
          uniqueMap.set(r.thread_id, r);
        }
      }
      const dedupedRecords = Array.from(uniqueMap.values());

      updateJob(jobId, { progress: 85, message: "Saving to disk..." });
      const { saveRecordsToDir } = await import("../../core/convert.js");
      await saveRecordsToDir(dedupedRecords, dataDir);

      const sourcesSeen = [...new Set(dedupedRecords.map((r) => r.meta?.source || "unknown"))].sort();
      const warningCount = dedupedRecords.filter((r) => r.meta?.warnings?.length).length;

      finishJob(jobId, {
        total_files: files.length,
        total_sqlite: sqliteRecords.length,
        total_records: dedupedRecords.length,
        sources_seen: sourcesSeen,
        warning_count: warningCount,
        records: dedupedRecords,
        dataDir: dataDir,
      });
    } catch (err) {
      failJob(jobId, err);
      log.error("Scan failed", { error: err.message });
    }
  })();
}

function handleScanResult(req, res, url) {
  const jobId = url.pathname.replace("/api/scan/", "");
  const job = getJob(jobId);
  if (!job) return respond(res, 404, { error: "Not found" });
  respond(res, 200, { job_id: jobId, status: job.status, result: job.result });
}

async function handleExport(req, res) {
  const body = await readBody(req);
  const jobId = createJob("export");
  respond(res, 202, { job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { status: "running", message: "Starting export..." });
      const { runExport } = await import("../commands/export.js");
      const result = await runExport({
        ...body,
        onProgress: (p, t, msg) => updateJob(jobId, { progress: p, total: t, message: msg }),
      });
      finishJob(jobId, result);
    } catch (err) {
      failJob(jobId, err);
    }
  })();
}

async function handleImport(req, res) {
  const body = await readBody(req);
  const jobId = createJob("import");
  respond(res, 202, { job_id: jobId });
  (async () => {
    try {
      updateJob(jobId, { status: "running" });
      const { runImport } = await import("../commands/import.js");
      finishJob(jobId, await runImport(body));
    } catch (err) { failJob(jobId, err); }
  })();
}

async function handleConvert(req, res) {
  const body = await readBody(req);
  const jobId = createJob("convert");
  respond(res, 202, { job_id: jobId });
  (async () => {
    try {
      const { runConvert } = await import("../commands/convert.js");
      finishJob(jobId, await runConvert(body));
    } catch (err) { failJob(jobId, err); }
  })();
}

async function handlePluginDesensitize(req, res) {
  const body = await readBody(req);
  const dataDir = body.dataDir || serverSettings.dataDir || OUTPUT_DIR;
  const jobId = createJob("plugin-desensitize");
  respond(res, 202, { job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { status: "running", message: "Starting desensitization plugin..." });
      const { runDesensitize } = await import("../../core/plugins/desensitize.js");
      const stats = await runDesensitize(dataDir, (prog) => {
        updateJob(jobId, { progress: prog.progress, phase: prog.phase, message: prog.message });
      });
      finishJob(jobId, { stats });
    } catch (err) {
      failJob(jobId, err);
      log.error("Desensitize plugin failed", { error: err.message });
    }
  })();
}

async function handlePluginPrivacy(req, res) {
  const body = await readBody(req);
  const dataDir = body.dataDir || serverSettings.dataDir || OUTPUT_DIR;
  const jobId = createJob("plugin-privacy");
  respond(res, 202, { job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { status: "running", message: "Starting privacy cleanup plugin..." });
      const { runPrivacyCleanup } = await import("../../core/plugins/privacy.js");
      const stats = await runPrivacyCleanup(dataDir, (prog) => {
        updateJob(jobId, { progress: prog.progress, phase: prog.phase, message: prog.message });
      });
      finishJob(jobId, { stats });
    } catch (err) {
      failJob(jobId, err);
      log.error("Privacy cleanup plugin failed", { error: err.message });
    }
  })();
}

async function handlePluginAssets(req, res) {
  const body = await readBody(req);
  const dataDir = body.dataDir || serverSettings.dataDir || OUTPUT_DIR;
  const jobId = createJob("plugin-assets");
  respond(res, 202, { job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { status: "running", message: "Starting assets cleanup plugin..." });
      const { runAssetsCleanup } = await import("../../core/plugins/assets.js");
      const stats = await runAssetsCleanup(dataDir, (prog) => {
        updateJob(jobId, { progress: prog.progress, phase: prog.phase, message: prog.message });
      });
      finishJob(jobId, { stats });
    } catch (err) {
      failJob(jobId, err);
    }
  })();
}

async function handlePluginPrune(req, res) {
  const body = await readBody(req);
  const dataDir = body.dataDir || serverSettings.dataDir || OUTPUT_DIR;
  const jobId = createJob("plugin-prune");
  respond(res, 202, { job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { status: "running", message: "Starting prune cleanup plugin..." });
      const { runPruneCleanup } = await import("../../core/plugins/prune.js");
      const stats = await runPruneCleanup(dataDir, (prog) => {
        updateJob(jobId, { progress: prog.progress, phase: prog.phase, message: prog.message });
      });
      finishJob(jobId, { stats });
    } catch (err) {
      failJob(jobId, err);
    }
  })();
}

async function handlePluginChitchat(req, res) {
  const body = await readBody(req);
  const dataDir = body.dataDir || serverSettings.dataDir || OUTPUT_DIR;
  const jobId = createJob("plugin-chitchat");
  respond(res, 202, { job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { status: "running", message: "Starting chitchat cleanup plugin..." });
      const { runChitchatCleanup } = await import("../../core/plugins/chitchat.js");
      const stats = await runChitchatCleanup(dataDir, (prog) => {
        updateJob(jobId, { progress: prog.progress, phase: prog.phase, message: prog.message });
      });
      finishJob(jobId, { stats });
    } catch (err) {
      failJob(jobId, err);
    }
  })();
}

async function handlePluginSecrets(req, res) {
  const body = await readBody(req);
  const dataDir = body.dataDir || serverSettings.dataDir || OUTPUT_DIR;
  const jobId = createJob("plugin-secrets");
  respond(res, 202, { job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { status: "running", message: "Starting secrets cleanup plugin..." });
      const { runSecretsCleanup } = await import("../../core/plugins/secrets.js");
      const stats = await runSecretsCleanup(dataDir, (prog) => {
        updateJob(jobId, { progress: prog.progress, phase: prog.phase, message: prog.message });
      });
      finishJob(jobId, { stats });
    } catch (err) {
      failJob(jobId, err);
    }
  })();
}

async function handleStats(req, res) {
  const body = await readBody(req);
  const { input, groupBy = ["project", "source"] } = body;
  const dataDir = input || serverSettings.dataDir || OUTPUT_DIR;
  try {
    const stats = await calculateStatsStreaming(dataDir, groupBy);
    respond(res, 200, stats);
  } catch (err) {
    respond(res, 500, { error: err.message });
  }
}

/** 
 * Memory-efficient stats calculation.
 * Streams through files one by one to avoid OOM.
 */
async function calculateStatsStreaming(dir, groupBy) {
  const groups = {};
  let total_records = 0;
  let total_tokens = 0;
  let total_messages = 0;
  let user_tokens = 0;
  let ai_tokens = 0;
  let max_ai = 0;
  let max_user = 0;

  try {
    const subDirs = await fs.readdir(dir);
    for (const sub of subDirs) {
      const subPath = path.join(dir, sub);
      const st = await fs.stat(subPath).catch(() => null);
      if (!st?.isDirectory()) continue;
      
      const files = await fs.readdir(subPath);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const record = await fs.readJson(path.join(subPath, f));
          total_records++;
          
          // Basic counters
          const rTokens = record.meta?.tokens || 0;
          total_tokens += rTokens;
          const rMsgs = (record.messages || []).length;
          total_messages += rMsgs;

          // Token estimation (simplified for speed/memory if not present)
          let rUserToks = 0;
          let rAiToks = 0;
          
          for (const m of record.messages || []) {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || "");
            const est = Math.ceil(content.length / 4);
            if (m.role === 'user') rUserToks += est;
            else rAiToks += est;
          }

          user_tokens += rUserToks;
          ai_tokens += rAiToks;
          max_ai = Math.max(max_ai, rAiToks);
          max_user = Math.max(max_user, rUserToks);

          // Grouping
          const keys = groupBy.map((g) => {
            if (g === "project") return record.meta?.project || "unknown";
            if (g === "source") return record.meta?.source || "unknown";
            return "unknown";
          });
          const groupKey = keys.join(" | ");
          
          if (!groups[groupKey]) {
            groups[groupKey] = {
              label: Object.fromEntries(groupBy.map((g, i) => [g, keys[i]])),
              threads: 0,
              messages: 0,
              tokens: 0,
              user_tokens: 0,
              ai_tokens: 0
            };
          }
          groups[groupKey].threads++;
          groups[groupKey].messages += rMsgs;
          groups[groupKey].tokens += rTokens;
          groups[groupKey].user_tokens += rUserToks;
          groups[groupKey].ai_tokens += rAiToks;

        } catch { /* skip broken files */ }
      }
    }
  } catch { /* ignore */ }

  return {
    total_records,
    total_tokens,
    total_messages,
    user_tokens,
    ai_tokens,
    max_ai,
    max_user,
    groups: Object.values(groups).sort((a, b) => b.threads - a.threads)
  };
}

async function handleImportFile(req, res) {
  // 解析 multipart 表单数据
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return respond(res, 400, { error: "Content-Type must be multipart/form-data" });
  }

  // 简单解析: 读取整个 body 到 buffer
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const bodyBuffer = Buffer.concat(chunks);
  
  // 提取 boundary
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    return respond(res, 400, { error: "No boundary found" });
  }
  const boundary = boundaryMatch[1];
  
  // 解析 multipart
  const parts = parseMultipart(bodyBuffer, boundary);
  const filePart = parts.find(p => p.filename);
  
  if (!filePart) {
    return respond(res, 400, { error: "No file uploaded" });
  }

  // 解析文件内容
  const content = filePart.data.toString("utf-8");
  const ext = filePart.filename.toLowerCase();
  
  let records = [];
  if (ext.endsWith(".jsonl")) {
    records = content.split("\n").filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } else {
    const parsed = JSON.parse(content);
    records = Array.isArray(parsed) ? parsed : [parsed];
  }

  // 标准化处理
  const alreadyUnified = records.filter(r => r.schema_version && r.thread_id);
  const needsNorm = records.filter(r => !r.schema_version || !r.thread_id);
  const normalized = normalizeAll(needsNorm.map(r => ({
    path: filePart.filename,
    content: JSON.stringify(r),
    mtime: Date.now(),
    size: 0,
  })));

  const allRecords = [
    ...alreadyUnified.map(r => ({ ...r, meta: { ...r.meta, source: r.meta?.source || "imported" } })),
    ...normalized,
  ];

  // 保存到数据目录
  const dataDir = serverSettings.dataDir || OUTPUT_DIR;
  const { saveRecordsToDir } = await import("../../core/convert.js");
  await saveRecordsToDir(allRecords, dataDir);

  respond(res, 200, { total: allRecords.length, written: allRecords.length, output: dataDir });
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from("--" + boundary);
  const endBoundary = Buffer.from("--" + boundary + "--");
  
  let start = 0;
  let idx = buffer.indexOf(boundaryBuffer, start);
  
  while (idx !== -1) {
    const nextIdx = buffer.indexOf(boundaryBuffer, idx + boundaryBuffer.length);
    if (nextIdx === -1) break;
    
    const partData = buffer.slice(idx + boundaryBuffer.length, nextIdx);
    // 去掉 \r\n
    let partStart = 0;
    if (partData[0] === 0x0d && partData[1] === 0x0a) {
      partStart = 2;
    }
    
    // 分离 header 和 body
    const headerEndIdx = partData.indexOf("\r\n\r\n", partStart);
    if (headerEndIdx === -1) {
      idx = nextIdx;
      continue;
    }
    
    const headers = partData.slice(partStart, headerEndIdx).toString();
    const body = partData.slice(headerEndIdx + 4);
    
    // 解析 Content-Disposition
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const nameMatch = headers.match(/name="([^"]+)"/);
    
    parts.push({
      name: nameMatch?.[1] || "file",
      filename: filenameMatch?.[1],
      data: body,
    });
    
    idx = nextIdx;
  }
  
  return parts;
}

async function handleImportToAgent(req, res) {
  const body = await readBody(req);
  const { records, source } = body;
  
  if (!source) {
    return respond(res, 400, { error: "Missing 'source' parameter" });
  }
  
  if (!records || !Array.isArray(records) || records.length === 0) {
    return respond(res, 400, { error: "Missing or empty 'records' array" });
  }
  
  try {
    const { importToAgent, listSupportedAgents } = await import("../../core/import.js");
    const result = await importToAgent(records, source);
    respond(res, 200, result);
  } catch (err) {
    respond(res, 500, { error: err.message });
  }
}

function handleListAgents(req, res) {
  import("../../core/import.js").then(({ listSupportedAgents, getAgentDirs }) => {
    const agents = listSupportedAgents();
    const agentInfo = agents.map(source => ({
      source,
      paths: getAgentDirs(source),
    }));
    respond(res, 200, { agents: agentInfo });
  }).catch(err => {
    respond(res, 500, { error: err.message });
  });
}

// 内存中的设置存储
let serverSettings = {
  dataDir: path.resolve(path.join(os.homedir(), "Downloads/AI-Exporter"))
};

async function handleSettings(req, res) {
  const body = await readBody(req);
  if (req.method === 'GET') {
    respond(res, 200, serverSettings);
  } else {
    // POST: 更新设置
    if (body.dataDir) {
      // 将相对路径转换为绝对路径
      serverSettings.dataDir = path.isAbsolute(body.dataDir) ? body.dataDir : path.resolve(body.dataDir);
    }
    respond(res, 200, serverSettings);
  }
}

function handleJobStatus(req, res, jobId) {
  const job = getJob(jobId);
  if (!job) return respond(res, 404, { error: "Not found" });
  const { _sseListeners, _abortController, ...safe } = job;
  respond(res, 200, safe);
}

function handleJobSSE(req, res, jobId) {
  const job = getJob(jobId);
  if (!job) {
    res.writeHead(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.(); // Flush headers immediately
  res.write(": connected\n\n");

  const send = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.flush?.(); // Flush data immediately
    } catch { /* ignore closed connections */ }
  };

  addSseListener(jobId, send);

  // Send current state immediately
  send({ type: "status", status: job.status, progress: job.progress, total: job.total, message: job.message });

  req.on("close", () => removeSseListener(jobId, send));
}

function handleJobCancel(req, res, jobId) {
  const ok = cancelJob(jobId);
  respond(res, ok ? 200 : 404, { cancelled: ok });
}

async function handleThreads(req, res, url) {
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const size = parseInt(url.searchParams.get("size") || "20", 10);
  const source = url.searchParams.get("source");
  const search = url.searchParams.get("q")?.toLowerCase();
  const dataDir = serverSettings.dataDir || OUTPUT_DIR;

  try {
    const { items, total } = await loadRecordsPaginated(dataDir, { 
      page, size, search, source, onlyMetadata: true 
    });
    respond(res, 200, { total, page, size, items });

  } catch (err) {
    respond(res, 500, { error: err.message });
  }
}

// ─── Static file server ───────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

async function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" || pathname === ""
    ? path.join(VIEWER_DIR, "index.html")
    : path.join(VIEWER_DIR, pathname);

  const safePath = path.resolve(filePath);
  if (!safePath.startsWith(path.resolve(VIEWER_DIR))) {
    return respond(res, 403, { error: "Forbidden" });
  }

  try {
    const content = await fs.readFile(safePath);
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function respond(res, status, body) {
  const payload = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
  });
}

/** Efficient listing with filtering and pagination */
async function loadRecordsPaginated(dir, { page = 1, size = 20, search = null, source = null, onlyMetadata = false }) {
  const offset = (page - 1) * size;
  const matches = [];
  let total = 0;

  try {
    const subDirs = await fs.readdir(dir);
    
    // Flatten file list for sorting (needed for pagination stability)
    const allFilePaths = [];
    for (const sub of subDirs) {
      const subPath = path.join(dir, sub);
      const st = await fs.stat(subPath).catch(() => null);
      if (!st?.isDirectory()) continue;
      const files = await fs.readdir(subPath);
      for (const f of files) {
        if (f.endsWith(".json")) allFilePaths.push(path.join(subPath, f));
      }
    }

    // Sort by name or time if possible? Filenames are often related to time in this ecosystem
    allFilePaths.sort().reverse(); 

    for (const filePath of allFilePaths) {
      try {
        const record = await fs.readJson(filePath);
        
        // Apply filters
        if (source && record.meta?.source !== source) continue;
        if (search) {
          const combined = (
            (record.meta?.prompt || "") + 
            (record.meta?.project || "") + 
            (record.meta?.file_path || "")
          ).toLowerCase();
          if (!combined.includes(search)) continue;
        }

        total++;

        // Only collect items within the requested page range
        if (total > offset && matches.length < size) {
          if (onlyMetadata) {
            delete record.messages;
            delete record.context;
          }
          matches.push(record);
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore dir not found */ }

  return { items: matches, total };
}

async function loadRecordsFromDir(dir, { onlyMetadata = false, search = null, source = null } = {}) {
  // Backwards compatibility for stats and other handlers
  const { items } = await loadRecordsPaginated(dir, { page: 1, size: 100000, search, source, onlyMetadata });
  return items;
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────

/**
 * Start the HTTP server.
 * @param {object} opts
 * @param {string} [opts.host="127.0.0.1"]
 * @param {number} [opts.port=8080]
 * @returns {Promise<http.Server>}
 */
export function startServer({ host = "127.0.0.1", port = 8080 } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      route(req, res).catch((err) => {
        log.error("Unhandled request error", { error: err.message });
        if (!res.headersSent) respond(res, 500, { error: "Internal server error" });
      });
    });

    server.listen(port, host, () => {
      log.info(`AI Exporter server started`, { url: `http://${host}:${port}` });
      resolve(server);
    });

    server.on("error", reject);
  });
}
async function handleAdapterPreview(req, res, agent) {
  try {
    const uas = await AgentTransformer.extractFrom(agent);
    respond(res, 200, uas);
  } catch (err) {
    respond(res, 500, { error: err.message });
  }
}

async function handleAdapterImport(req, res, agent) {
  try {
    const result = await AgentTransformer.importToAntigravity(agent);
    respond(res, 200, result);
  } catch (err) {
    respond(res, 500, { error: err.message });
  }
}

async function handleAdapterExport(req, res, agent) {
  try {
    const bundle = await AgentTransformer.exportTo(agent);
    respond(res, 200, bundle);
  } catch (err) {
    respond(res, 500, { error: err.message });
  }
}
