/**
 * `export` command — scan + normalize + idempotent write.
 */

import os from "node:os";
import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { scanAllTools } from "../../core/scan.js";
import { normalizeAll, SCHEMA_VERSION } from "../../core/normalize.js";
import { collectAllVscdbRecords } from "../../core/cursor_sqlite.js";
import { EXPORTER_VERSION } from "../../core/version.js";
import { conformThreadRecord } from "../../core/schema-validator.js";
import { DESENSITIZE_PATTERNS } from "../../core/plugins/desensitize.js";
import { SECRET_PATTERNS } from "../../core/plugins/secrets.js";
import { PII_PATTERNS } from "../../core/plugins/privacy.js";
import log from "../logger.js";

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
 * @param {Function} [opts.onProgress]
 */
export async function runExport(opts = {}) {
  const {
    output = "./agent-backup",
    format = "json",
    since = null,
    workers = 8,
    redact = false,
    onProgress = null,
  } = opts;

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
  const rawFiles = await scanAllTools({ workers, onProgress: (d, t, p) => progress(Math.round((d / Math.max(t, 1)) * 30) + 5, 100, `Scanning ${path.basename(p)}`) });
  log.info(`Found ${rawFiles.length} candidate files`);

  progress(40, 100, "Scanning IDE workspace databases (*.vscdb)…");
  const sqliteRecords = await collectAllVscdbRecords();
  log.info(`SQLite (all IDEs): ${sqliteRecords.length} records`);

  // ── Normalize ─────────────────────────────────────────────────────────────
  progress(60, 100, "Normalizing records…");
  const fileRecords = normalizeAll(rawFiles);
  let allRecords = [...fileRecords, ...sqliteRecords];

  // Apply --since filter
  if (sinceCutoff) {
    allRecords = allRecords.filter((r) => {
      const ts = r.meta?.created_at ? new Date(r.meta.created_at).getTime() : 0;
      return ts >= sinceCutoff;
    });
    log.info(`After --since filter: ${allRecords.length} records`);
  }

  // ── Redact (optional) ──────────────────────────────────────────────────────
  let redactedCount = 0;
  const redactMatches = {};
  if (redact) {
    progress(65, 100, "Redacting secrets & PII…");
    for (const r of allRecords) {
      const m = redactRecord(r);
      const n = Object.values(m).reduce((a, b) => a + b, 0);
      if (n > 0) {
        redactedCount++;
        for (const [k, v] of Object.entries(m)) redactMatches[k] = (redactMatches[k] || 0) + v;
      }
    }
    if (redactedCount > 0) {
      log.warn(`Redacted sensitive data in ${redactedCount} record(s): ${JSON.stringify(redactMatches)}`);
    } else {
      log.info("Redaction scan complete — no secrets or PII detected.");
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  progress(70, 100, "Writing output…");
  await fs.ensureDir(output);
  const exportedAt = new Date().toISOString();
  const manifestItems = [];
  const sourcesSeen = new Set();
  let newCount = 0, skippedCount = 0;

  for (const record of allRecords) {
    conformThreadRecord(record);
    const hash = threadHash(record);
    const source = record.meta?.source || "unknown";
    sourcesSeen.add(source);

    if (prevHashes.has(hash)) {
      skippedCount++;
      manifestItems.push({ hash, source, thread_id: record.thread_id });
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
    manifestItems.push({ hash, sha256, source, thread_id: record.thread_id, file: path.relative(output, filePath) });
    newCount++;
  }

  // ── Manifest ──────────────────────────────────────────────────────────────
  progress(95, 100, "Writing manifest…");
  const manifest = {
    exporter_version: EXPORTER_VERSION,
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    sources_seen: [...sourcesSeen].sort(),
    total_items: allRecords.length,
    new_items: newCount,
    skipped_items: skippedCount,
    items: manifestItems,
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });

  progress(100, 100, "Done");
  log.info(`Export complete — new: ${newCount}, skipped: ${skippedCount}`);
  return { output, new_items: newCount, skipped_items: skippedCount, total: allRecords.length, sources_seen: [...sourcesSeen].sort(), manifest_path: manifestPath, redacted: redactedCount };
}
