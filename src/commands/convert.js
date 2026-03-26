/** `convert` command — transform backup dir to a target format. */
import fs from "fs-extra";
import path from "node:path";
import { toTrainingJsonl, toMarkdownAll, computeStats } from "../../core/convert.js";
import log from "../logger.js";

/**
 * @param {object} opts
 * @param {string} opts.input   Path to backup dir or single JSON file
 * @param {string} [opts.to="training-jsonl"]  "training-jsonl"|"sharegpt"|"multiturn"|"markdown"
 * @param {string} [opts.output]  Output file path (stdout if omitted)
 * @param {string} [opts.template="sft-v1"]     Template name for training JSONL
 */
export async function runConvert({ input, to = "training-jsonl", output, template = "sft-v1" } = {}) {
  if (!input) throw new Error("--input is required");

  const records = await loadRecords(input);
  log.info(`Loaded ${records.length} records from ${input}`);

  let content = "";
  if (to === "markdown") {
    content = toMarkdownAll(records);
  } else {
    const style = to === "sharegpt" ? "sharegpt" : to === "multiturn" ? "multiturn" : "sft";
    content = toTrainingJsonl(records, { style });
  }

  if (output) {
    await fs.ensureDir(path.dirname(output));
    await fs.writeFile(output, content, "utf-8");
    log.info(`Written to ${output}`);
  } else {
    process.stdout.write(content + "\n");
  }

  return { records: records.length, format: to, output: output || "stdout" };
}

async function loadRecords(input) {
  const stat = await fs.stat(input);
  if (stat.isFile()) return [await fs.readJson(input)];
  // Directory: read all .json files recursively
  const records = [];
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".json") && e.name !== "manifest.json") {
        try { records.push(await fs.readJson(full)); } catch { /* skip */ }
      }
    }
  };
  await walk(input);
  return records;
}
