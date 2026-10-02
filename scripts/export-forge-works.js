#!/usr/bin/env node
/**
 * Export rich Forge traces from ~/.forge/works into agent-backup/forge.
 * Usage: node scripts/export-forge-works.js [--works <path>] [--out <dir>] [--min-bytes N]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportForgeWorksTraces } from "../adapter/forge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--works") args.works = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--min-bytes") args.minBytes = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const outDir = args.out
  ? path.resolve(args.out)
  : path.join(root, "agent-backup", "forge");

const result = await exportForgeWorksTraces({
  worksRoot: args.works,
  outDir,
  minBytes: args.minBytes ?? 1000,
});

console.log(JSON.stringify(result, null, 2));
if (!result.results?.length) process.exitCode = 1;
