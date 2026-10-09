/**
 * Forge adapter — map Forge run_logs (events.ndjson + legacy *.json) into
 * Al-exporter unified thread records and lightweight UAS config.
 * Used by Al-exporter scan/normalize and Foundry Collector import.
 */
import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import zlib from "node:zlib";
import { createEmptyUAS } from "./schema.js";
import { createHash } from "node:crypto";

const SCHEMA_VERSION = "1.0.0";
const DEFAULT_WORKS = path.join(os.homedir(), ".forge", "works");

/**
 * Extract lightweight Forge config / hooks into Unified Agent Schema.
 * @param {string} [forgeRoot] absolute path to forge repo or project works root
 */
export async function extractForgeConfig(forgeRoot) {
  const uas = createEmptyUAS("forge");
  if (!forgeRoot || !(await fs.pathExists(forgeRoot))) {
    return uas;
  }

  const hooksCandidates = [
    path.join(forgeRoot, ".Forge-agents", "hooks.yaml"),
    path.join(forgeRoot, ".Forge-config", "hooks.yaml"),
    path.join(forgeRoot, "hooks.yaml"),
  ];
  for (const hp of hooksCandidates) {
    if (await fs.pathExists(hp)) {
      uas.context.projectRules = `hooks: ${hp}`;
      uas.agentConfig.systemPrompt = await fs.readFile(hp, "utf8");
      break;
    }
  }

  uas.skills.push(
    { id: "bash", name: "bash", description: "Forge shell / run_command tool" },
    { id: "write", name: "write", description: "Forge write_file / edit tool" },
    { id: "apply_patch", name: "apply_patch", description: "Forge patch tool" }
  );

  return uas;
}

/**
 * Group run_log JSON files under a traces directory into thread-like records.
 * Prefer events.ndjson when present; fall back to legacy per-event *.json.
 * @param {string} tracesRoot e.g. .../project/traces
 */
export async function collectForgeRunLogThreads(tracesRoot, { limit = 20, minBytes = 1000 } = {}) {
  const threads = [];
  if (!(await fs.pathExists(tracesRoot))) return threads;

  const projectId = path.basename(path.dirname(tracesRoot));
  const traceIds = await fs.readdir(tracesRoot);
  for (const tid of traceIds.slice(0, limit)) {
    const traceDir = path.join(tracesRoot, tid);
    const st = await fs.stat(traceDir).catch(() => null);
    if (!st?.isDirectory()) continue;

    const ndjson = path.join(traceDir, "run_logs", "events.ndjson");
    if (await fs.pathExists(ndjson)) {
      const size = (await fs.stat(ndjson)).size;
      if (size < minBytes) continue;
      const record = await eventsNdjsonToRecord(ndjson, { projectId, traceId: tid });
      if (record) threads.push(record);
      continue;
    }

    const gz = path.join(traceDir, "archives", "run_logs.jsonl.gz");
    if (await fs.pathExists(gz)) {
      const record = await gzipJsonlToRecord(gz, { projectId, traceId: tid });
      if (record) threads.push(record);
      continue;
    }

    const runLogs = path.join(traceDir, "run_logs");
    if (!(await fs.pathExists(runLogs))) continue;
    const files = (await fs.readdir(runLogs)).filter((f) => f.endsWith(".json"));
    const events = [];
    for (const f of files.slice(0, 50)) {
      try {
        events.push(JSON.parse(await fs.readFile(path.join(runLogs, f), "utf8")));
      } catch {
        /* skip */
      }
    }
    if (!events.length) continue;
    threads.push({
      id: tid,
      origin: "forge",
      path: runLogs,
      eventCount: events.length,
      events: events.map((e) => ({
        event: e.event,
        layer: e.layer,
        ts: e.ts,
        tool_id: e.payload?.tool_id,
        kind: classifyForgeEvent(e),
      })),
    });
  }
  return threads;
}

/**
 * Export rich Forge traces under ~/.forge/works (or custom root) to Al-exporter
 * unified JSON records under outDir (default agent-backup/forge).
 */
export async function exportForgeWorksTraces({
  worksRoot = DEFAULT_WORKS,
  outDir,
  minBytes = 1000,
} = {}) {
  const resolvedOut =
    outDir || path.join(process.cwd(), "agent-backup", "forge");
  await fs.ensureDir(resolvedOut);

  const results = [];
  if (!(await fs.pathExists(worksRoot))) {
    return { outDir: resolvedOut, results, error: `worksRoot missing: ${worksRoot}` };
  }

  const projects = await fs.readdir(worksRoot);
  for (const projectId of projects) {
    if (projectId.startsWith(".")) continue;
    const tracesRoot = path.join(worksRoot, projectId, "traces");
    if (!(await fs.pathExists(tracesRoot))) continue;

    const traceIds = await fs.readdir(tracesRoot);
    for (const tid of traceIds) {
      const ndjson = path.join(tracesRoot, tid, "run_logs", "events.ndjson");
      if (!(await fs.pathExists(ndjson))) continue;
      const size = (await fs.stat(ndjson)).size;
      if (size < minBytes) continue;

      const record = await eventsNdjsonToRecord(ndjson, { projectId, traceId: tid });
      if (!record) continue;

      const safeProj = projectId.replace(/[^\w.-]+/g, "_");
      const fname = `forge-${safeProj}-${tid.slice(0, 12)}.json`;
      const outPath = path.join(resolvedOut, fname);
      await fs.writeJson(outPath, record, { spaces: 2 });
      results.push({
        projectId,
        traceId: tid,
        bytes: size,
        messages: record.messages.length,
        path: outPath,
        turn_outcome: record.meta?.forge_turn_outcome,
      });
    }
  }

  await fs.writeJson(
    path.join(resolvedOut, "manifest.json"),
    {
      exported_at: new Date().toISOString(),
      worksRoot,
      count: results.length,
      results,
    },
    { spaces: 2 }
  );

  return { outDir: resolvedOut, results };
}

function classifyForgeEvent(e) {
  const ev = String(e.event || "");
  const tool = e.payload?.tool_id || "";
  if (/bash|run_command/i.test(ev) || /bash|run_command/i.test(tool)) return "bash";
  if (/tool|post_tool|function/i.test(ev) || tool) return "function_call";
  if (/llm|model|chat/i.test(ev)) return "llm";
  if (/agent/i.test(ev)) return "agent";
  if (/turn/i.test(ev)) return "turn";
  return "event";
}

async function gzipJsonlToRecord(gzPath, { projectId, traceId }) {
  const buf = await fs.readFile(gzPath);
  let text;
  try {
    text = zlib.gunzipSync(buf).toString("utf8");
  } catch {
    return null;
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const ev = parseJsonLine(t);
    if (ev) events.push(ev);
  }
  return eventsToRecord(events, {
    projectId,
    traceId,
    filePath: gzPath,
  });
}

async function eventsNdjsonToRecord(ndjsonPath, { projectId, traceId }) {
  const text = await fs.readFile(ndjsonPath, "utf8");
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const ev = parseJsonLine(t);
    if (ev) events.push(ev);
  }
  if (!events.length) return null;

  const turnAnchorPath = path.join(path.dirname(ndjsonPath), "turn_anchor.json");
  let turnAnchor = null;
  if (await fs.pathExists(turnAnchorPath)) {
    try {
      turnAnchor = JSON.parse(await fs.readFile(turnAnchorPath, "utf8"));
    } catch {
      /* ignore */
    }
  }

  return eventsToRecord(events, {
    projectId,
    traceId,
    filePath: ndjsonPath,
    turnAnchor,
  });
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    try {
      // salvage first JSON value when trailing junk exists
      let i = 0;
      while (i < line.length && /\s/.test(line[i])) i++;
      if (line[i] !== "{" && line[i] !== "[") return null;
      const { value } = decodeOne(line.slice(i));
      return value;
    } catch {
      return null;
    }
  }
}

function decodeOne(s) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return { value: JSON.parse(s.slice(0, i + 1)), end: i + 1 };
      }
    }
  }
  throw new Error("incomplete");
}

function eventsToRecord(events, { projectId, traceId, filePath, turnAnchor }) {
  const messages = [];
  const models = new Set();
  let softPartial = 0;
  let softComplete = 0;
  let softFailed = 0;
  let browserFailed = 0;
  let browserRequested = 0;
  let dialogueFailed = 0;

  for (const o of events) {
    const ev = o.event || "";
    const pl = o.payload || {};
    const iso = tsToIso(o.ts);

    if (ev === "conversation.message.assistant") {
      const { content, tool_calls } = splitAssistantContent(pl.content || "");
      const msg = { role: "assistant", content, timestamp: iso };
      if (tool_calls.length) msg.tool_calls = tool_calls;
      messages.push(msg);
      if (pl.model_id) models.add(pl.model_id);
      continue;
    }
    if (
      ev === "conversation.message.user" ||
      ev === "conversation.user_message" ||
      ev === "user.message"
    ) {
      messages.push({
        role: "user",
        content: pl.content || pl.text || safeJson(pl).slice(0, 4000),
        timestamp: iso,
      });
      continue;
    }
    if (ev === "conversation.observation") {
      messages.push({
        role: "tool",
        name: pl.tool_id || pl.name || "observation",
        content: safeJson(pl).slice(0, 8000),
        timestamp: iso,
      });
      continue;
    }
    if (ev === "agent.turn_soft_eval") {
      const tc =
        pl.task_completion ||
        pl.verdict ||
        pl.status ||
        (pl.scores && pl.scores.task_completion);
      if (tc === "complete" || tc === "completed" || tc === "success") softComplete++;
      else if (tc === "failed" || tc === "fail") softFailed++;
      else softPartial++;
      continue;
    }
    if (ev === "sandbox.browser.failed") {
      browserFailed++;
      messages.push({
        role: "tool",
        name: "sandbox.browser",
        content: safeJson(pl).slice(0, 4000),
        timestamp: iso,
      });
      continue;
    }
    if (ev === "sandbox.browser.requested") {
      browserRequested++;
      continue;
    }
    if (ev === "dialogue.append_failed") {
      dialogueFailed++;
      messages.push({
        role: "system",
        content: `dialogue.append_failed: ${safeJson(pl).slice(0, 2000)}`,
        timestamp: iso,
      });
      continue;
    }
  }

  // Synthetic user from turn_anchor when chat has no user turn
  if (turnAnchor?.intent && !messages.some((m) => m.role === "user")) {
    messages.unshift({
      role: "user",
      content: String(turnAnchor.intent),
      timestamp: messages[0]?.timestamp || null,
    });
  }

  // Pipeline-only traces: synthesize a compact narrative so Prism still gets a thread
  if (messages.length === 0) {
    const summaryEvents = events
      .slice(0, 40)
      .map((e) => `- ${e.event}${e.layer ? ` [${e.layer}]` : ""}`)
      .join("\n");
    messages.push({
      role: "user",
      content: `Forge trace ${traceId} (project=${projectId}) — no conversation.message; event summary:\n${summaryEvents}`,
      timestamp: tsToIso(events[0]?.ts),
    });
    messages.push({
      role: "assistant",
      content: `Captured ${events.length} Forge runtime events without chat turns.`,
      timestamp: tsToIso(events[events.length - 1]?.ts),
    });
  }

  // Ensure Prism/SFT-friendly roles: prepend user if only tool/system
  if (messages.length && !messages.some((m) => m.role === "user")) {
    messages.unshift({
      role: "user",
      content: `Forge trace ${traceId} @ ${projectId}`,
      timestamp: messages[0]?.timestamp || null,
    });
  }
  if (messages.length && !messages.some((m) => m.role === "assistant")) {
    messages.push({
      role: "assistant",
      content: `Forge runtime transcript (${events.length} events).`,
      timestamp: messages[messages.length - 1]?.timestamp || null,
    });
  }

  let turnOutcome = "unknown";
  if (softFailed > 0 || dialogueFailed > 0) turnOutcome = "failed";
  else if (browserFailed > 0 && softComplete === 0) turnOutcome = "failed";
  else if (softComplete > 0 && softPartial === 0) turnOutcome = "completed";
  else if (softPartial > 0 || softComplete > 0) turnOutcome = "completed";
  else if (messages.some((m) => m.role === "assistant")) turnOutcome = "completed";

  const text = messages.map((m) => m.content || "").join("");
  const tokens = estimateTokens(text);
  const threadId =
    traceId && /^[0-9a-f-]{8,}$/i.test(traceId)
      ? traceId
      : createHash("sha1").update(filePath || `${projectId}/${traceId}`).digest("hex").slice(0, 16);

  return {
    schema_version: SCHEMA_VERSION,
    thread_id: threadId,
    type: "thread",
    messages,
    context: {
      files: (turnAnchor?.files || []).map((file) => (typeof file === "string" ? { path: file } : file)),
      diffs: [],
    },
    meta: {
      source: "forge",
      project: projectId || "unknown",
      created_at: messages[0]?.timestamp || new Date().toISOString(),
      updated_at: messages[messages.length - 1]?.timestamp || new Date().toISOString(),
      file_path: filePath || "",
      tokens,
      prompt: (messages.find((m) => m.role === "user")?.content || "").slice(0, 120),
      recognition_confidence: messages.some((m) => m.role === "assistant" && (m.tool_calls || []).length)
        ? "high"
        : "low",
      forge_trace_id: traceId,
      forge_event_count: events.length,
      forge_turn_outcome: turnOutcome,
      forge_soft_eval: { softComplete, softPartial, softFailed },
      forge_browser: { browserRequested, browserFailed },
    },
    agentConfig: {
      model: models.values().next().value || "",
    },
  };
}

function splitAssistantContent(content) {
  const tool_calls = [];
  let text = content || "";
  const fence = "```forge_responses_tool_calls";
  const idx = text.indexOf(fence);
  if (idx >= 0) {
    const start = idx + fence.length;
    const end = text.indexOf("```", start);
    if (end > start) {
      try {
        const arr = JSON.parse(text.slice(start, end).trim());
        for (const tc of arr || []) {
          tool_calls.push({
            id: tc.id || "",
            function: {
              name: tc.name || "",
              arguments:
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments || {}),
            },
          });
        }
      } catch {
        /* keep raw */
      }
      text = text.slice(0, idx).trim();
    }
  }
  return { content: text, tool_calls };
}

function tsToIso(ts) {
  if (typeof ts !== "number") return null;
  try {
    return new Date(ts * 1000).toISOString();
  } catch {
    return null;
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function estimateTokens(text = "") {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const latin = text.length - cjk;
  return Math.ceil(cjk + latin / 4);
}
