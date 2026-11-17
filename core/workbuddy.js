/**
 * WorkBuddy session transcript adapter.
 * Observed on WorkBuddy desktop (macOS): projects/<cwd>/<session-uuid>.jsonl
 * plus workbuddy.db for titles / deleted_at.
 * Keeps tool calls for Al-exporter's evidence path.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { cleanInjectedUserText } from "./content.js";

const SESSION_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function pathLooksLikeWorkBuddySession(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  if (!(p.includes("/.workbuddy/") || p.includes("/.workbuddy-ai/") || p.includes("/workbuddy/"))) {
    return false;
  }
  if (!p.includes("/projects/")) return false;
  if (!p.endsWith(".jsonl")) return false;
  return SESSION_ID_RE.test(path.basename(filePath, ".jsonl"));
}

/**
 * Default WorkBuddy project roots and DB candidates.
 * @param {string} [home]
 * @returns {{ projectDirs: string[], dbPaths: string[] }}
 */
export function workbuddyDefaultRoots(home = os.homedir()) {
  return {
    projectDirs: [
      path.join(home, ".workbuddy-ai", "projects"),
      path.join(home, ".workbuddy", "projects"),
    ],
    dbPaths: [
      path.join(home, ".workbuddy-ai", "workbuddy.db"),
      path.join(home, ".workbuddy", "workbuddy.db"),
    ],
  };
}

/**
 * @param {string} dbPath
 * @returns {Map<string, { title: string, deleted: boolean }>|null}
 */
export function loadWorkBuddyMeta(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 2000 });
  } catch {
    return null;
  }
  try {
    const cols = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((r) => r.name));
    if (!cols.has("id")) return null;
    const wanted = ["title", "custom_title", "deleted_at"].filter((c) => cols.has(c));
    const select = ["id", ...wanted].join(", ");
    const meta = new Map();
    for (const row of db.prepare(`SELECT ${select} FROM sessions`).all()) {
      const title = String(row.custom_title || row.title || "").trim();
      const deleted = row.deleted_at != null && Number(row.deleted_at) > 0;
      meta.set(String(row.id), { title, deleted });
    }
    return meta;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function stampMs(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return {};
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return { timestamp: new Date(ms).toISOString() };
}

function userTextFromParts(content) {
  if (typeof content === "string") return cleanInjectedUserText(content);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const raw = String(entry.text || entry.content || "");
    const cleaned = cleanInjectedUserText(raw);
    if (cleaned) parts.push(cleaned);
  }
  return parts.join("\n").trim();
}

function assistantTextFromParts(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "output_text" || entry.type === "text" || entry.text) {
      const text = String(entry.text || "").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function modelOf(item) {
  const provider = item?.providerData;
  if (!provider || typeof provider !== "object") return null;
  const model = String(provider.model || provider.requestModelName || "").trim();
  return model || null;
}

/**
 * Parse a WorkBuddy session JSONL body into normalize-ready extraction.
 * @param {string} content
 * @param {string} filePath
 * @param {Map<string, { title: string, deleted: boolean }>|null} [meta]
 * @returns {{ messages: object[], context: object, prompt: string|null, confidence: string, warnings: string[], sessions?: object[], deleted?: boolean, title?: string }|null}
 */
export function parseWorkBuddyJsonl(content, filePath, meta = null) {
  const sessionId = path.basename(filePath, ".jsonl");
  const info = meta?.get(sessionId);
  if (info?.deleted) {
    return {
      messages: [],
      context: { files: [], diffs: [] },
      prompt: null,
      confidence: "high",
      warnings: ["workbuddy session marked deleted_at in workbuddy.db"],
      deleted: true,
    };
  }

  const messages = [];
  const warnings = [];
  let aiTitle = "";
  let cwd = "";
  let firstUser = "";
  let lineNo = 0;

  for (const line of String(content || "").split("\n")) {
    lineNo += 1;
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      warnings.push("Skipped invalid WorkBuddy JSONL line");
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.cwd) cwd = String(item.cwd);
    const stamp = stampMs(item.timestamp);
    const identity = {
      ...(item.id != null ? { id: String(item.id), id_source: "event.id" } : {}),
      line: lineNo,
    };

    if (item.type === "ai-title") {
      aiTitle = String(item.aiTitle || "").trim() || aiTitle;
      continue;
    }
    if (item.type === "function_call") {
      const name = item.name || item.tool || "tool";
      const args = item.arguments ?? item.input ?? item.args ?? "";
      const argText = typeof args === "string" ? args : JSON.stringify(args);
      messages.push({
        role: "assistant",
        content: `[Tool Use] ${name}${argText ? `\n${argText}` : ""}`,
        ...stamp,
        ...identity,
        meta: { kind: "tool_use", name: String(name) },
        tool_call: {
          name: String(name),
          status: typeof item.status === "string" && item.status.trim() ? item.status.trim() : null,
          call_id: item.callId != null ? String(item.callId) : null,
          phase: "call",
        },
        ...(modelOf(item) ? { model: modelOf(item) } : {}),
      });
      continue;
    }
    if (item.type === "function_call_result") {
      const body = typeof item.output === "string"
        ? item.output
        : JSON.stringify(item.output ?? item.result ?? item.content ?? "");
      messages.push({
        role: "user",
        content: `[Tool Result] ${body}`,
        ...stamp,
        ...identity,
        meta: { kind: "tool_result", ...(item.name ? { name: String(item.name) } : {}) },
        tool_call: {
          name: item.name != null ? String(item.name) : null,
          status: typeof item.status === "string" && item.status.trim() ? item.status.trim() : null,
          call_id: item.callId != null ? String(item.callId) : null,
          phase: "result",
        },
      });
      continue;
    }
    if (item.type !== "message") continue;

    if (item.role === "user") {
      const text = userTextFromParts(item.content);
      if (!text) continue;
      if (!firstUser) firstUser = text;
      messages.push({ role: "user", content: text, ...stamp, ...identity });
      continue;
    }
    if (item.role === "assistant") {
      const text = assistantTextFromParts(item.content);
      const model = modelOf(item);
      if (!text) continue;
      messages.push({
        role: "assistant",
        content: text,
        ...stamp,
        ...identity,
        ...(model ? { model } : {}),
      });
    }
  }

  if (messages.length === 0) {
    return {
      messages: [],
      context: { files: [], diffs: [] },
      prompt: null,
      confidence: "unknown",
      warnings,
    };
  }

  const title = (info?.title || aiTitle || firstUser.split("\n")[0] || "").slice(0, 120);
  return {
    messages,
    context: { files: [], diffs: [] },
    prompt: firstUser.slice(0, 120) || title || null,
    confidence: firstUser ? "high" : "low",
    warnings,
    sessions: [{ id: sessionId, messages }],
    title,
    projectDirectory: cwd,
    sessionMeta: {
      native_id: sessionId,
      native_id_kind: "uuid",
      native_id_source: "file.basename",
      ...(cwd ? { cwd, cwd_source: "workbuddy.record" } : {}),
    },
  };
}
