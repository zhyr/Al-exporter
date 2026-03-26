/** `scan` command — scan only, no write. */
import os from "node:os";
import path from "node:path";
import { scanAllTools } from "../../core/scan.js";
import { normalizeAll } from "../../core/normalize.js";
import { collectAllVscdbRecords } from "../../core/cursor_sqlite.js";
import log from "../logger.js";

export async function runScan({ workers = 8, json = false, onProgress = null } = {}) {
  const progress = (p, t, msg) => { if (onProgress) onProgress(p, t, msg); };

  progress(0, 100, "Scanning file sources…");
  const rawFiles = await scanAllTools({ workers, onProgress: (d, t, p) => progress(Math.round((d / Math.max(t, 1)) * 60), 100, `Scanning ${path.basename(p)}`) });

  progress(65, 100, "Scanning IDE workspace databases…");
  const sqliteRecords = await collectAllVscdbRecords();

  progress(85, 100, "Normalizing…");
  const fileRecords = normalizeAll(rawFiles);
  const allRecords = [...fileRecords, ...sqliteRecords];
  const sourcesSeen = [...new Set(allRecords.map((r) => r.meta?.source || "unknown"))].sort();
  const warningCount = allRecords.filter((r) => r.meta?.warnings?.length).length;
  const confidenceDist = allRecords.reduce((acc, r) => {
    const c = r.meta?.recognition_confidence || "unknown";
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {});

  const report = {
    total_files: rawFiles.length,
    total_sqlite: sqliteRecords.length,
    total_records: allRecords.length,
    sources_seen: sourcesSeen,
    warning_count: warningCount,
    confidence: confidenceDist,
  };

  progress(100, 100, "Scan complete");

  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    log.info(`Scan complete:`);
    log.info(`  Files: ${rawFiles.length}  SQLite records: ${sqliteRecords.length}  Total: ${allRecords.length}`);
    log.info(`  Sources: ${sourcesSeen.join(", ")}`);
    log.info(`  Confidence: high=${confidenceDist.high || 0}, low=${confidenceDist.low || 0}, unknown=${confidenceDist.unknown || 0}`);
    if (warningCount > 0) log.warn(`  Health warnings in ${warningCount} records — run with --json to inspect`);
  }
  return { ...report, records: allRecords };
}
