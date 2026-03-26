/** `stats` command — aggregate statistics from backup dir. */
import { computeStats } from "../../core/convert.js";
import log from "../logger.js";
import fs from "fs-extra";
import path from "node:path";

export async function runStats({ input = "./agent-backup", by = "project,source", json = false } = {}) {
  const groupBy = by.split(",").map((s) => s.trim()).filter(Boolean);
  const records = await loadRecords(input);
  const stats = computeStats(records, groupBy);

  if (json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
  } else {
    log.info(`Stats for ${input}`);
    log.info(`  Total records: ${stats.total_records}  Messages: ${stats.total_messages}  Tokens: ${stats.total_tokens}`);
    log.info(`  Groups (by ${groupBy.join(", ")}):`);
    for (const g of stats.groups) {
      const label = Object.values(g.label).join(" / ");
      log.info(`    ${label}: ${g.threads} threads, ${g.messages} messages`);
    }
  }
  return stats;
}

async function loadRecords(dir) {
  const records = [];
  try {
    const walk = async (d) => {
      const entries = await fs.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".json") && e.name !== "manifest.json") {
          try { records.push(await fs.readJson(full)); } catch { /* skip */ }
        }
      }
    };
    await walk(dir);
  } catch { /* dir may not exist */ }
  return records;
}
