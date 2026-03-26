/** `import` command — import external JSONL/JSON dumps and normalize into unified schema. */
import fs from "fs-extra";
import path from "node:path";
import { normalizeAll, SCHEMA_VERSION } from "../../core/normalize.js";
import { validateAll } from "../../core/schema-validator.js";
import log from "../logger.js";
import crypto from "node:crypto";

export async function runImport({ input, output = "./agent-backup/imported", validate = false } = {}) {
  if (!input) throw new Error("--input is required");

  const raw = await fs.readFile(input, "utf-8");
  const ext = path.extname(input).toLowerCase();

  let records = [];
  if (ext === ".jsonl") {
    records = raw.split("\n").filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } else {
    const parsed = JSON.parse(raw);
    records = Array.isArray(parsed) ? parsed : [parsed];
  }

  // Attempt to normalize non-unified records
  const alreadyUnified = records.filter((r) => r.schema_version && r.thread_id);
  const needsNorm = records.filter((r) => !r.schema_version || !r.thread_id);
  const normalized = normalizeAll(needsNorm.map((r) => ({
    path: input, content: JSON.stringify(r), mtime: Date.now(), size: 0,
  })));

  const allRecords = [
    ...alreadyUnified.map((r) => ({ ...r, meta: { ...r.meta, source: r.meta?.source || "imported" } })),
    ...normalized,
  ];

  if (validate) {
    const result = validateAll(allRecords);
    log.info(`Validation: ${result.valid}/${result.total} valid`);
    if (result.invalid > 0) {
      result.results.filter((r) => !r.valid).forEach((r) => log.warn(`Record ${r.thread_id}: ${r.errors.join(", ")}`));
    }
  }

  await fs.ensureDir(output);
  let written = 0;
  for (const record of allRecords) {
    const hash = crypto.createHash("sha1").update(JSON.stringify(record)).digest("hex").slice(0, 12);
    const file = path.join(output, `imported-${hash}.json`);
    if (!await fs.pathExists(file)) {
      await fs.writeJson(file, record, { spaces: 2 });
      written++;
    }
  }

  log.info(`Import complete — written: ${written}/${allRecords.length}`);
  return { input, total: allRecords.length, written, output };
}
