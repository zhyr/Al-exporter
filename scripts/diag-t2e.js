#!/usr/bin/env node
/**
 * Diagnose T2E loss on real exported JSON.
 * Usage: node scripts/diag-t2e.js <directory-of-json>
 *
 * Reads records that were actually exported (thread_id + messages).
 * Does not synthesize sessions.
 */
import fs from "node:fs";
import path from "node:path";
import { mineEpisodes } from "../core/t2e/mine.js";
import { scoreEpisode } from "../core/t2e/evidence.js";
import { gateEpisodes } from "../core/t2e/gate.js";
import { buildTask } from "../core/t2e/builder.js";
import { verifyTask } from "../core/t2e/verify.js";
import { conformThreadRecord, validateThread } from "../core/schema-validator.js";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/diag-t2e.js <directory-of-exported-json>");
  console.error("Synthetic session benchmarks were removed. Pass a real export directory.");
  process.exit(2);
}

function loadRecords(root) {
  const records = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (name !== "node_modules" && name !== "transfer2eval") walk(full);
        continue;
      }
      if (!name.endsWith(".json") || name === "manifest.json") continue;
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      if (parsed && parsed.thread_id && Array.isArray(parsed.messages)) records.push(parsed);
    }
  };
  walk(path.resolve(dir));
  return records;
}

const records = loadRecords(dir).map((record) => conformThreadRecord(record));
if (records.length === 0) {
  console.error(`No thread records under ${dir}`);
  process.exit(2);
}

let invalid = 0;
for (const record of records) {
  const result = validateThread(record);
  if (!result.valid) {
    invalid++;
    console.error("invalid", record.thread_id, result.errors.join("; "));
  }
}
console.log(`records: ${records.length} invalid: ${invalid}`);

const bySource = {};
for (const record of records) {
  const source = record.meta?.source || "unknown";
  bySource[source] = (bySource[source] || 0) + 1;
}
console.log("bySource:", bySource);

const mined = await mineEpisodes(records);
console.log(`mined: ${mined.length} episodes`);
for (const episode of mined) scoreEpisode(episode);
const gated = gateEpisodes(mined);
console.log(`gate: accepted=${gated.accepted.length} review=${gated.review.length} rejected=${gated.rejected.length}`);

let verified = 0;
let built = 0;
for (const episode of gated.accepted) {
  try {
    buildTask(episode);
    built++;
    const result = verifyTask(episode);
    if (result.passed) verified++;
  } catch (err) {
    console.error("build fail", episode.id, err.message);
  }
}
console.log(`built: ${built} verified: ${verified}`);
if (invalid > 0) process.exit(1);
