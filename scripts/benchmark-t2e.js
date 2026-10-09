#!/usr/bin/env node
/**
 * Time the T2E pipeline on real exported JSON.
 * Usage: node scripts/benchmark-t2e.js <directory-of-json> [outDir]
 *
 * Does not synthesize sessions. A timing number from invented chats is not a benchmark.
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline } from "../core/t2e/index.js";
import { conformThreadRecord } from "../core/schema-validator.js";

const dir = process.argv[2];
const outDir = process.argv[3] || "";
if (!dir) {
  console.error("Usage: node scripts/benchmark-t2e.js <directory-of-exported-json> [outDir]");
  console.error("Synthetic session benchmarks were removed. Pass a real export directory.");
  process.exit(2);
}

function loadRecords(root) {
  const records = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) {
        if (name !== "node_modules" && name !== "transfer2eval") walk(full);
        continue;
      }
      if (!name.endsWith(".json") || name === "manifest.json") continue;
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      if (parsed && parsed.thread_id && Array.isArray(parsed.messages)) {
        records.push(conformThreadRecord(parsed));
      }
    }
  };
  walk(path.resolve(dir));
  return records;
}

const records = loadRecords(dir);
if (records.length === 0) {
  console.error(`No thread records under ${dir}`);
  process.exit(2);
}

const started = Date.now();
const result = await runPipeline({
  normalized: records,
  outDir: outDir || undefined,
  onProgress: (stage, detail) => console.log(stage, detail),
});
console.log(JSON.stringify({
  records: records.length,
  ms: Date.now() - started,
  stats: result.stats,
}, null, 2));
