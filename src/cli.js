#!/usr/bin/env node
/**
 * AI Exporter CLI — unified entry point.
 * Usage: node src/cli.js <command> [options]
 *        npx ai-exporter <command> [options]
 */

import { configureLogger, log } from "./logger.js";

const HELP = `
AI Exporter v2.0.0
Export, backup, and analyze AI coding tool conversations.

Usage:
  ai-exporter <command> [options]

Commands:
  export    Scan + normalize + write backup (default)
  scan      Scan and report only (no file write)
  convert   Convert backup to training JSONL / Markdown
  stats     Aggregate statistics from backup
  import    Import external JSONL/JSON into unified schema
  serve     Start local Web UI at http://127.0.0.1:8080

Global Options:
  --log-level <level>    debug | info | warn | error  (default: info)
  --log-format json      Output structured JSON logs
  --help, -h             Show this help

export Options:
  --output <dir>         Output directory  (default: ./agent-backup)
  --format <fmt>         json | markdown | training-jsonl  (default: json)
  --since <ISO8601>      Only export records newer than this date
  --workers <n>          Concurrent file workers  (default: 8)

scan Options:
  --json                 Output machine-readable JSON to stdout
  --workers <n>          Concurrent file workers

convert Options:
  --input <path>         Backup dir or single .json file  (required)
  --to <format>          training-jsonl | sharegpt | multiturn | markdown
  --output <file>        Output file (default: stdout)

stats Options:
  --input <path>         Backup dir  (default: ./agent-backup)
  --by <dims>            Comma-separated: project,source,month,type
  --json                 Output JSON to stdout

import Options:
  --input <file>         .json or .jsonl file to import  (required)
  --output <dir>         Output dir  (default: ./agent-backup/imported)
  --validate             Validate records against JSON Schema

serve Options:
  --host <host>          Bind host  (default: 127.0.0.1)
  --port <port>          Bind port  (default: 8080)
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // Configure logger from global flags
  configureLogger({
    level: args["log-level"] || "info",
    json: args["log-format"] === "json",
  });

  const cmd = args._[0] || "export";

  if (args.help || cmd === "help") {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  try {
    switch (cmd) {
      case "export": {
        const { runExport } = await import("./commands/export.js");
        const result = await runExport({
          output:  args.output  || "./agent-backup",
          format:  args.format  || "json",
          since:   args.since   || null,
          workers: args.workers ? parseInt(args.workers, 10) : 8,
        });
        log.info(`✅ Done  new=${result.new_items}  skipped=${result.skipped_items}  total=${result.total}`);
        break;
      }
      case "scan": {
        const { runScan } = await import("./commands/scan.js");
        await runScan({ json: args.json === true, workers: args.workers ? parseInt(args.workers, 10) : 8 });
        break;
      }
      case "convert": {
        const { runConvert } = await import("./commands/convert.js");
        await runConvert({ input: args.input, to: args.to || "training-jsonl", output: args.output });
        break;
      }
      case "stats": {
        const { runStats } = await import("./commands/stats.js");
        await runStats({ input: args.input || "./agent-backup", by: args.by || "project,source", json: args.json === true });
        break;
      }
      case "import": {
        const { runImport } = await import("./commands/import.js");
        await runImport({ input: args.input, output: args.output, validate: args.validate === true });
        break;
      }
      case "serve": {
        const { runServe } = await import("./commands/serve.js");
        await runServe({ host: args.host || "127.0.0.1", port: parseInt(args.port || "8080", 10) });
        break;
      }
      default:
        log.error(`Unknown command: ${cmd}. Run --help for usage.`);
        process.exit(1);
    }
  } catch (err) {
    log.error(err.message, { stack: err.stack });
    process.exit(1);
  }
}

main();
