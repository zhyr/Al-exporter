/**
 * Structured logger for AI Exporter.
 * Supports human-readable (pretty) and machine-readable (JSON) output modes.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS["info"];
let jsonMode = false;
let traceId = null;

/**
 * Configure the logger.
 * @param {object} opts
 * @param {string} [opts.level="info"]
 * @param {boolean} [opts.json=false]
 * @param {string}  [opts.traceId]
 */
export function configureLogger({ level = "info", json = false, tid = null } = {}) {
  currentLevel = LEVELS[level] ?? LEVELS["info"];
  jsonMode = json;
  traceId = tid;
}

function emit(level, message, meta = {}) {
  if (LEVELS[level] > currentLevel) return;
  const ts = new Date().toISOString();
  if (jsonMode) {
    const entry = { timestamp: ts, level, message, ...meta };
    if (traceId) entry.trace_id = traceId;
    process.stderr.write(JSON.stringify(entry) + "\n");
  } else {
    const ICONS = { error: "❌", warn: "⚠️ ", info: "ℹ️ ", debug: "🐛" };
    const prefix = `${ICONS[level] || ""} [${ts.slice(11, 19)}]`;
    const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${prefix} ${message}${metaStr}\n`);
  }
}

export const log = {
  error: (msg, meta) => emit("error", msg, meta),
  warn:  (msg, meta) => emit("warn",  msg, meta),
  info:  (msg, meta) => emit("info",  msg, meta),
  debug: (msg, meta) => emit("debug", msg, meta),
};

export default log;
