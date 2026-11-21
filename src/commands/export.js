/**
 * `export` command — scan + normalize + idempotent write.
 */

import os from "node:os";
import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { scanAllTools, readZstdText } from "../../core/scan.js";
import { normalizeAll, SCHEMA_VERSION } from "../../core/normalize.js";
import { collectAllVscdbRecords } from "../../core/cursor_sqlite.js";
import { collectCursorCliRecords } from "../../core/cursor_cli.js";
import {
  attachThreadFiles,
  collectCursorGlobalRecords,
  writeCursorAudit,
  writeCursorIndex,
} from "../../core/cursor_global.js";
import { EXPORTER_VERSION } from "../../core/version.js";
import { conformThreadRecord } from "../../core/schema-validator.js";
import {
  exportStatePath,
  loadExportState,
  saveExportState,
  shouldSkipSourceFile,
  rememberSourceFile,
} from "../../core/export-state.js";
import { DESENSITIZE_PATTERNS } from "../../core/plugins/desensitize.js";
import { SECRET_PATTERNS } from "../../core/plugins/secrets.js";
import { PII_PATTERNS } from "../../core/plugins/privacy.js";
import {
  INTEROP_CONTRACT,
  INTEROP_CONTRACT_VERSION,
  INTEROP_FILENAME,
  addInteropRecords,
  buildInteropReport,
  createInteropCounter,
  finalizeRecordInterop,
  resolveDeviceIdentity,
} from "../../core/interop.js";
import log from "../logger.js";
import pLimit from "p-limit";

// Upper bound for a single source file (matches the scanner default). Applies to
// decompressed zstd payloads as well, so one huge rollout cannot exhaust memory.
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

// Combined redaction patterns (API keys + passwords/JWT + PII). In-memory only.
const REDACT_PATTERNS = [
  ...DESENSITIZE_PATTERNS,
  ...SECRET_PATTERNS,
  ...PII_PATTERNS,
];

/**
 * Redact secrets / PII in a single record in place. Returns match counts by type.
 * Operates on meta.prompt, meta.file_path, and every message.content string.
 */
function redactRecord(record) {
  const matches = {};
  const scan = (text) => {
    if (typeof text !== "string") return text;
    let out = text;
    for (const { type, regex } of REDACT_PATTERNS) {
      out = out.replace(regex, () => {
        matches[type] = (matches[type] || 0) + 1;
        return "***REDACTED***";
      });
    }
    return out;
  };
  if (record.meta) {
    if (record.meta.prompt) record.meta.prompt = scan(record.meta.prompt);
    if (record.meta.file_path) record.meta.file_path = scan(record.meta.file_path);
  }
  if (Array.isArray(record.messages)) {
    for (const m of record.messages) {
      if (m && typeof m.content === "string") m.content = scan(m.content);
    }
  }
  return matches;
}

function threadHash(record) {
  return crypto.createHash("sha1").update(JSON.stringify(record)).digest("hex").slice(0, 12);
}
function slugify(str = "") {
  return str.toLowerCase()
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[\\/\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .substring(0, 50).replace(/^_+|_+$/g, "") || "untitled";
}

/**
 * @param {object} opts
 * @param {string}   [opts.output="./agent-backup"]
 * @param {string}   [opts.format="json"]  "json","markdown","training-jsonl"
 * @param {string}   [opts.since]          ISO8601 — only export records after this date
 * @param {number}   [opts.workers=8]
 * @param {boolean}  [opts.redact=false]   Redact secrets/API keys/PII before writing
 * @param {string}   [opts.sourceDevice]   Device id of the machine that owns the agent records
 * @param {boolean}  [opts.cursorGlobal=true] Read modern Cursor desktop Composer (globalStorage state.vscdb)
 * @param {boolean}  [opts.cursorRaw=false]   Persist raw cursorDiskKV bubble rows as JSONL sidecars
 * @param {boolean}  [opts.cursorArtifacts=false] Persist agentKv / checkpoint payloads as files
 * @param {string}   [opts.cursorDb]          Explicit Cursor global state.vscdb path
 * @param {Function} [opts.onProgress]
 */
export async function runExport(opts = {}) {
  const {
    output = "./agent-backup",
    format = "json",
    since = null,
    workers = 8,
    redact = false,
    sourceDevice = null,
    cursorGlobal = true,
    cursorRaw = false,
    cursorArtifacts = false,
    cursorDb = null,
    onProgress = null,
  } = opts;

  const devices = resolveDeviceIdentity({ sourceDevice });

  const progress = (p, t, msg) => {
    if (onProgress) onProgress(p, t, msg);
    else log.info(msg);
  };

  // ── Load previous manifest ────────────────────────────────────────────────
  const manifestPath = path.join(output, "manifest.json");
  let prevManifest = null;
  if (await fs.pathExists(manifestPath)) {
    prevManifest = await fs.readJson(manifestPath).catch(() => null);
  }
  const prevHashes = new Set(prevManifest?.items?.map((i) => i.hash) || []);
  const sinceCutoff = since ? new Date(since).getTime() : null;

  // ── Scan ──────────────────────────────────────────────────────────────────
  progress(5, 100, "Scanning file-based sources…");
  const scannedFiles = await scanAllTools({ workers, metadataOnly: true, onProgress: (d, t, p) => progress(Math.round((d / Math.max(t, 1)) * 30) + 5, 100, `Scanning ${path.basename(p)}`) });
  log.info(`Found ${scannedFiles.length} candidate files`);

  const stateFile = exportStatePath(output);
  const exportState = loadExportState(stateFile);
  // A schema bump adds fields that unchanged source files still need to gain.
  if (exportState.schema_version !== SCHEMA_VERSION && Object.keys(exportState.files).length > 0) {
    log.info(`Export state schema ${exportState.schema_version || "legacy"} → ${SCHEMA_VERSION}: re-exporting all source files`);
    exportState.files = {};
  }
  exportState.schema_version = SCHEMA_VERSION;
  const rawFiles = [];
  const carriedManifestItems = [];
  let stateSkippedFiles = 0;
  for (const f of scannedFiles) {
    if (shouldSkipSourceFile(exportState, f.path, f.mtime, output)) {
      stateSkippedFiles++;
      const entry = exportState.files?.[f.path];
      for (const rel of entry?.outputs || []) {
        const prevItem = prevManifest?.items?.find((i) => i.file === rel);
        if (prevItem) carriedManifestItems.push(prevItem);
        else carriedManifestItems.push({ source: "unknown", thread_id: "", file: rel, hash: `state:${rel}` });
      }
      continue;
    }
    rawFiles.push(f);
  }
  if (stateSkippedFiles > 0) {
    log.info(`Export state skipped ${stateSkippedFiles} unchanged source file(s)`);
  }

  progress(40, 100, "Scanning IDE workspace databases (*.vscdb)…");
  const sqliteRecords = await collectAllVscdbRecords();
  log.info(`SQLite (all IDEs): ${sqliteRecords.length} records`);

  progress(50, 100, "Scanning Cursor CLI chats (store.db)…");
  const cursorCliRecords = collectCursorCliRecords();
  log.info(`Cursor CLI: ${cursorCliRecords.length} records`);

  // ── Normalize + write ─────────────────────────────────────────────────────
  // Source files are read and normalized one at a time, then written
  // immediately. A full-machine export therefore never holds every record (or
  // every decompressed rollout) in memory at once.
  progress(60, 100, "Normalizing and writing records…");
  await fs.ensureDir(output);

  const manifestItems = [...carriedManifestItems];
  const sourcesSeen = new Set(carriedManifestItems.map((i) => i.source).filter(Boolean));
  const interopCounter = createInteropCounter();
  /** @type {Map<string, { mtime_ms: number, thread_ids: string[], outputs: string[] }>} */
  const writtenBySource = new Map();
  let processedRecords = 0;
  let newCount = 0, skippedCount = 0;
  let redactedCount = 0;
  const redactMatches = {};

  const consumeRecords = async (records) => {
    for (const record of records) {
      if (sinceCutoff) {
        const ts = record.meta?.created_at ? new Date(record.meta.created_at).getTime() : 0;
        if (ts < sinceCutoff) continue;
      }

      // Fill session/device/message identity fields before hashing so the
      // written record and its content hash both reflect the contract.
      finalizeRecordInterop(record, { devices });
      addInteropRecords(interopCounter, [record]);
      processedRecords++;

      if (redact) {
        const m = redactRecord(record);
        const n = Object.values(m).reduce((a, b) => a + b, 0);
        if (n > 0) {
          redactedCount++;
          for (const [k, v] of Object.entries(m)) redactMatches[k] = (redactMatches[k] || 0) + v;
        }
      }

      conformThreadRecord(record);
      const hash = threadHash(record);
      const source = record.meta?.source || "unknown";
      sourcesSeen.add(source);
      const srcPath = record.meta?.file_path || "";
      const srcMtime = record.meta?.updated_at
        ? new Date(record.meta.updated_at).getTime()
        : 0;

      if (prevHashes.has(hash)) {
        skippedCount++;
        const relExisting = prevManifest?.items?.find((i) => i.hash === hash)?.file;
        manifestItems.push({ hash, source, thread_id: record.thread_id, ...(relExisting ? { file: relExisting } : {}) });
        if (srcPath && relExisting) {
          const prev = writtenBySource.get(srcPath) || { mtime_ms: srcMtime, thread_ids: [], outputs: [] };
          prev.mtime_ms = srcMtime || prev.mtime_ms;
          prev.thread_ids.push(record.thread_id);
          prev.outputs.push(relExisting);
          writtenBySource.set(srcPath, prev);
        }
        continue;
      }

      const toolDir = path.join(output, source);
      await fs.ensureDir(toolDir);
      const slug = slugify(record.meta?.prompt || record.thread_id);
      const filename = `${source}-${slug}-${hash}.json`;
      const filePath = path.join(toolDir, filename);
      await fs.writeJson(filePath, record, { spaces: 2 });

      const fileContent = await fs.readFile(filePath);
      const sha256 = crypto.createHash("sha256").update(fileContent).digest("hex");
      const rel = path.relative(output, filePath);
      manifestItems.push({ hash, sha256, source, thread_id: record.thread_id, file: rel });
      newCount++;
      if (srcPath) {
        const prev = writtenBySource.get(srcPath) || { mtime_ms: srcMtime, thread_ids: [], outputs: [] };
        prev.mtime_ms = srcMtime || prev.mtime_ms;
        prev.thread_ids.push(record.thread_id);
        prev.outputs.push(rel);
        writtenBySource.set(srcPath, prev);
      }
    }
  };

  for (const f of rawFiles) {
    if (f.zstd) {
      const decoded = await readZstdText(f.path, MAX_SOURCE_BYTES);
      if (!decoded) {
        log.warn(`Skipped ${f.path}: cannot decompress within ${MAX_SOURCE_BYTES} bytes`);
        continue;
      }
      await consumeRecords(normalizeAll([{
        path: f.path,
        content: decoded.text,
        mtime: f.mtime,
        size: decoded.bytes,
      }]));
      continue;
    }
    const content = await fs.readFile(f.path, "utf-8").catch(() => null);
    if (!content || content.trim().length === 0) continue;
    await consumeRecords(normalizeAll([{ path: f.path, content, mtime: f.mtime, size: f.size }]));
  }
  await consumeRecords([...sqliteRecords, ...cursorCliRecords]);

  // ── Modern Cursor desktop Composer (globalStorage/cursorDiskKV) ───────────
  // Read per composer through the snapshot reader, then attach final thread
  // filenames to the cursor index before writing index + audit.
  let cursorGlobalSummary = null;
  if (cursorGlobal) {
    if (cursorRaw && redact) {
      log.warn("--cursor-raw writes original bubble payloads and bypasses --redact; review cursor-raw/ before sharing");
    }
    progress(55, 100, "Reading modern Cursor Composer store (globalStorage)…");
    try {
      cursorGlobalSummary = await collectCursorGlobalRecords({
        dbPath: cursorDb || undefined,
        outputDir: output,
        persistRaw: cursorRaw,
        persistArtifacts: cursorArtifacts,
        onProgress: (msg) => log.info(msg),
        onRecord: (record) => consumeRecords([record]),
      });
    } catch (error) {
      log.warn(`Cursor globalStorage read failed: ${error.message}`);
      cursorGlobalSummary = null;
    }
    if (cursorGlobalSummary) {
      const { index, audit, dbPath, skipped } = cursorGlobalSummary;
      if (skipped) {
        log.info(`Cursor globalStorage skipped: ${skipped}`);
      } else {
        log.info(
          `Cursor Composer: ${audit.counts?.composers_total ?? 0} composers, ` +
          `${index.filter((e) => e.status === "exported").length} exported, ` +
          `${audit.counts?.messages_total ?? 0} messages`,
        );
      }
      attachThreadFiles(index, manifestItems);
      const written = await writeCursorIndex(output, index, audit, {
        db_path: dbPath,
        skipped: skipped || null,
        counts: audit.counts || {},
        coverage: audit.coverage || {},
        alignment: audit.alignment || {},
      });
      const auditPath = await writeCursorAudit(output, audit);
      log.info(`Cursor index: ${path.relative(output, written.indexPath)} (${index.length} entries)`);
      log.info(`Cursor audit: ${path.relative(output, auditPath)}`);
    }
  }

  if (sinceCutoff) log.info(`After --since filter: ${processedRecords} records`);

  for (const [srcPath, entry] of writtenBySource) {
    rememberSourceFile(exportState, srcPath, entry);
  }
  saveExportState(exportState, stateFile);

  if (redact) {
    if (redactedCount > 0) {
      log.warn(`Redacted sensitive data in ${redactedCount} record(s): ${JSON.stringify(redactMatches)}`);
    } else {
      log.info("Redaction scan complete — no secrets or PII detected.");
    }
  }

  // ── Interop capability report ─────────────────────────────────────────────
  // Incremental exports only normalize newly changed source files. Carry the
  // already-written outputs into the capability counters so interop.json keeps
  // describing the whole output directory, not just this batch.
  const exportedAt = new Date().toISOString();
  if (stateSkippedFiles > 0) {
    progress(90, 100, "Reading carried-forward records for interop…");
    const limit = pLimit(Math.max(1, Math.min(workers, 8)));
    await Promise.all(carriedManifestItems.map((item) => limit(async () => {
      if (!item.file) return;
      const carried = await fs.readJson(path.join(output, item.file)).catch(() => null);
      if (carried && typeof carried === "object") addInteropRecords(interopCounter, [carried]);
    })));
  }
  const interop = buildInteropReport(interopCounter, {
    generatedAt: exportedAt,
    exporterVersion: EXPORTER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    devices,
    stateSkippedFiles,
    basis: stateSkippedFiles > 0 ? "all_records_in_output" : "records_written_in_this_export",
  });

  if (interopCounter.records_total === 0) {
    // Incremental re-export may write nothing; keep the last capability report
    // instead of replacing it with an empty one.
    const prevInterop = await fs.readJson(path.join(output, INTEROP_FILENAME)).catch(() => null);
    if (prevInterop) {
      prevInterop.generated_at = exportedAt;
      prevInterop.state_skipped_files = stateSkippedFiles;
      prevInterop.carried_forward = true;
      Object.keys(interop).forEach((key) => delete interop[key]);
      Object.assign(interop, prevInterop);
    }
  }

  // ── Interop capability report ─────────────────────────────────────────────
  progress(93, 100, "Writing interop capabilities…");
  const interopPath = path.join(output, INTEROP_FILENAME);
  const interopBody = `${JSON.stringify(interop, null, 2)}\n`;
  await fs.writeFile(interopPath, interopBody);
  const interopSha256 = crypto.createHash("sha256").update(interopBody).digest("hex");

  // ── Manifest ──────────────────────────────────────────────────────────────
  progress(95, 100, "Writing manifest…");
  const manifest = {
    exporter_version: EXPORTER_VERSION,
    schema_version: SCHEMA_VERSION,
    contract: {
      name: INTEROP_CONTRACT,
      version: INTEROP_CONTRACT_VERSION,
      schema_version: SCHEMA_VERSION,
      capabilities: INTEROP_FILENAME,
      capabilities_sha256: interopSha256,
    },
    exported_at: exportedAt,
    device: {
      source_device_id: devices.source_device_id,
      source_device_id_basis: devices.source_device_id_basis,
      collector_device_id: devices.collector_device_id,
    },
    sources_seen: [...sourcesSeen].sort(),
    total_items: processedRecords + stateSkippedFiles,
    new_items: newCount,
    skipped_items: skippedCount,
    state_skipped_files: stateSkippedFiles,
    items: manifestItems,
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });

  progress(100, 100, "Done");
  log.info(`Export complete — new: ${newCount}, skipped: ${skippedCount}, state_skipped_files: ${stateSkippedFiles}`);
  return {
    output,
    new_items: newCount,
    skipped_items: skippedCount,
    state_skipped_files: stateSkippedFiles,
    total: processedRecords,
    sources_seen: [...sourcesSeen].sort(),
    manifest_path: manifestPath,
    interop_path: interopPath,
    cursor_index_path: cursorGlobalSummary
      ? path.join(output, "cursor-index.jsonl")
      : null,
    cursor_audit_path: cursorGlobalSummary
      ? path.join(output, "audit", "cursor-audit.json")
      : null,
    capabilities: interop.capabilities,
    redacted: redactedCount,
  };
}
