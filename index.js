#!/usr/bin/env node
/**
 * AI Exporter — main entry point (legacy compat / direct run).
 * For full CLI, use: node src/cli.js <command>
 *
 * This script scans all AI tool directories, normalizes records into the
 * unified schema, writes them to agent-backup/ with idempotent hashing,
 * and generates viewer/data.js for the standalone viewer.
 */

import { scanAllTools } from "./core/scan.js";
import { normalizeAll, SCHEMA_VERSION } from "./core/normalize.js";
import { collectAllVscdbRecords } from "./core/cursor_sqlite.js";
import fs from "fs-extra";
import path from "path";
import crypto from "crypto";

const OUTPUT_DIR   = "./agent-backup";
const VIEWER_DIR   = "./viewer";
const EXPORTER_VERSION = "2.0.0";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function threadHash(record) {
  return crypto.createHash("sha1").update(JSON.stringify(record)).digest("hex").slice(0, 12);
}

function slugify(str = "") {
  return str.toLowerCase()
    .replace(/[\\/\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .substring(0, 50)
    .replace(/^_+|_+$/g, "") || "untitled";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    // ── 1. Load previous manifest ─────────────────────────────────────────
    const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
    let prevManifest = null;
    if (await fs.pathExists(manifestPath)) {
      prevManifest = await fs.readJson(manifestPath).catch(() => null);
    }
    const prevHashes = new Set(prevManifest?.items?.map((i) => i.hash) || []);

    // ── 2. Scan file-based sources ────────────────────────────────────────
    console.log("🔍 Scanning for AI tool data...");
    let scanned = 0;
    const rawFiles = await scanAllTools({
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) {
          process.stdout.write(`\r   📁 Scanned ${done}/${total} files`);
        }
        scanned = done;
      },
    });
    process.stdout.write(`\n   📁 Found ${rawFiles.length} candidate files\n`);

    // ── 3. Scan VS Code–family SQLite (*.vscdb): Cursor, VS Code, Windsurf, … ──
    console.log("🗄️  Scanning IDE workspace databases (*.vscdb)…");
    const sqliteRecords = await collectAllVscdbRecords();
    console.log(`   ✅ Extracted ${sqliteRecords.length} records from SQLite`);

    // ── 4. Normalize file-based records ───────────────────────────────────
    console.log("📊 Normalizing...");
    const fileRecords = normalizeAll(rawFiles);
    const allRecords  = [...fileRecords, ...sqliteRecords];
    console.log(`   📦 Total records: ${allRecords.length}`);

    // ── 5. Idempotent write ───────────────────────────────────────────────
    await fs.ensureDir(OUTPUT_DIR);
    const exportedAt   = new Date().toISOString();
    const manifestItems = [];
    const sourcesSeen  = new Set();
    let newCount = 0, skippedCount = 0;
    const viewerData = [];

    for (const record of allRecords) {
      const hash   = threadHash(record);
      const source = record.meta?.source || "unknown";
      sourcesSeen.add(source);
      viewerData.push(record);

      if (prevHashes.has(hash)) {
        skippedCount++;
        manifestItems.push({ hash, source, thread_id: record.thread_id });
        continue;
      }

      const toolDir  = path.join(OUTPUT_DIR, source);
      await fs.ensureDir(toolDir);
      const slug     = slugify(record.meta?.prompt || record.thread_id);
      const filename = `${source}-${slug}-${hash}.json`;
      const filePath = path.join(toolDir, filename);
      await fs.writeJson(filePath, record, { spaces: 2 });

      // SHA-256 checksum for manifest
      const fileContent = await fs.readFile(filePath);
      const sha256 = crypto.createHash("sha256").update(fileContent).digest("hex");
      manifestItems.push({ hash, sha256, source, thread_id: record.thread_id, file: path.relative(OUTPUT_DIR, filePath) });
      newCount++;
    }

    // ── 6. Write manifest.json ────────────────────────────────────────────
    const manifest = {
      exporter_version: EXPORTER_VERSION,
      schema_version:   SCHEMA_VERSION,
      exported_at:      exportedAt,
      sources_seen:     [...sourcesSeen].sort(),
      total_items:      allRecords.length,
      new_items:        newCount,
      skipped_items:    skippedCount,
      items:            manifestItems,
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    // ── 7. Write viewer/data.js ───────────────────────────────────────────
    await fs.ensureDir(VIEWER_DIR);
    const dataJsContent = `window.EXPORTER_DATA = ${JSON.stringify(viewerData, null, 2)};`;
    await fs.writeFile(path.join(VIEWER_DIR, "data.js"), dataJsContent, "utf-8");

    // ── 8. Open viewer ────────────────────────────────────────────────────
    const viewerPath = path.resolve(path.join(VIEWER_DIR, "index.html"));
    console.log(`\n✅ Export done!`);
    console.log(`   New: ${newCount}  |  Skipped (unchanged): ${skippedCount}  |  Total: ${allRecords.length}`);
    console.log(`   Sources: ${[...sourcesSeen].sort().join(", ")}`);
    console.log(`   Manifest: ${manifestPath}`);
    console.log(`   Viewer:   file://${viewerPath}`);

    // Try to open the viewer in the browser
    try {
      const { default: open } = await import("open").catch(() => ({ default: null }));
      if (open) await open(`file://${viewerPath}`);
    } catch { /* optional */ }

  } catch (err) {
    console.error("❌ Export failed:", err);
    process.exit(1);
  }
})();
