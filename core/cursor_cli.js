/**
 * Cursor CLI (`cursor agent`) session reader.
 * Storage: ~/.cursor/chats/<workspace-md5>/<session-uuid>/{store.db, meta.json}
 * Separate source from Cursor IDE (cursor_cli).
 *
 * Blobs are content-addressed; turn graph is protobuf in production.
 * This reader extracts human/assistant text heuristically from blob bytes
 * (user_query tags + printable UTF-8 runs) without reverse-engineering the
 * full protobuf schema. Confidence stays low unless <user_query> is present.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "./normalize.js";
import { cleanInjectedUserText } from "./content.js";

/**
 * @param {string} [home]
 * @returns {string}
 */
export function defaultCursorCliChatsDir(home = os.homedir()) {
  return path.join(home, ".cursor", "chats");
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function pathLooksLikeCursorCli(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  return p.includes("/.cursor/chats/") && (p.endsWith("store.db") || p.endsWith("meta.json"));
}

function makeId(filePath) {
  return crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16);
}

function extractUserQueries(text) {
  const out = [];
  const re = /<user_query>([\s\S]*?)<\/user_query>/gi;
  for (const m of text.matchAll(re)) {
    const q = cleanInjectedUserText(m[1] || "");
    if (q) out.push(q);
  }
  return out;
}

function printableRuns(buf, minLen = 40) {
  const text = buf.toString("utf8");
  const runs = [];
  let cur = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      cur += ch;
    } else if (cur) {
      if (cur.trim().length >= minLen) runs.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim().length >= minLen) runs.push(cur.trim());
  return runs;
}

/**
 * @param {string} storePath
 * @returns {{ messages: object[], warnings: string[], confidence: string }}
 */
export function parseCursorCliStore(storePath) {
  const warnings = [];
  let db;
  try {
    db = new Database(storePath, { readonly: true, fileMustExist: true, timeout: 2000 });
  } catch (err) {
    return { messages: [], warnings: [`cursor_cli store open failed: ${err.message}`], confidence: "unknown" };
  }

  const messages = [];
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    if (!tables.includes("blobs")) {
      warnings.push("cursor_cli store.db has no blobs table");
      return { messages, warnings, confidence: "unknown" };
    }
    const rows = db.prepare("SELECT id, data FROM blobs").all();
    const seen = new Set();
    for (const row of rows) {
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || "");
      const asText = buf.toString("utf8");
      const queries = extractUserQueries(asText);
      for (const q of queries) {
        if (seen.has(`u:${q}`)) continue;
        seen.add(`u:${q}`);
        messages.push({ role: "user", content: q });
      }
      if (queries.length) continue;
      for (const run of printableRuns(buf)) {
        if (/<user_info|<system-reminder|<agent_|tool_call|protobuf/i.test(run)) continue;
        if (seen.has(`a:${run.slice(0, 200)}`)) continue;
        seen.add(`a:${run.slice(0, 200)}`);
        // Prefer assistant-looking prose runs without XML wrappers
        if (run.length >= 80 && !run.includes("<user_query>")) {
          messages.push({ role: "assistant", content: run.slice(0, 20000) });
        }
      }
    }
  } catch (err) {
    warnings.push(`cursor_cli blob read failed: ${err.message}`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  const hasUser = messages.some((m) => m.role === "user");
  return {
    messages,
    warnings,
    confidence: hasUser ? "high" : messages.length ? "low" : "unknown",
  };
}

function readMeta(sessionDir) {
  const metaPath = path.join(sessionDir, "meta.json");
  if (!fs.existsSync(metaPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Collect Cursor CLI sessions under chatsDir into unified thread records.
 * @param {string} [chatsDir]
 * @returns {object[]}
 */
export function collectCursorCliRecords(chatsDir = defaultCursorCliChatsDir()) {
  if (!fs.existsSync(chatsDir)) return [];
  const records = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(chatsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  for (const ws of workspaces) {
    const wsPath = path.join(chatsDir, ws.name);
    let sessions;
    try {
      sessions = fs.readdirSync(wsPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const sess of sessions) {
      const sessionDir = path.join(wsPath, sess.name);
      const storePath = path.join(sessionDir, "store.db");
      if (!fs.existsSync(storePath)) continue;
      const meta = readMeta(sessionDir);
      const parsed = parseCursorCliStore(storePath);
      if (!parsed.messages.length) continue;

      const createdMs = Number(meta.createdAtMs) || fs.statSync(storePath).mtimeMs;
      const cwd = meta.cwd || meta.workspacePath || "";
      const firstUser = parsed.messages.find((m) => m.role === "user");
      const record = {
        schema_version: SCHEMA_VERSION,
        thread_id: makeId(storePath),
        type: "thread",
        session: {
          native_id: sess.name,
          native_id_kind: "uuid",
          native_id_source: "dir.basename",
          cwd: cwd ? String(cwd) : null,
          cwd_source: cwd ? "cursor_cli.meta" : null,
          git_remote: null,
          git_remote_source: null,
          agent_version: meta.version ? String(meta.version) : null,
        },
        messages: parsed.messages,
        context: { files: [], diffs: [] },
        meta: {
          source: "cursor_cli",
          project: cwd ? path.basename(String(cwd)) : ws.name,
          created_at: new Date(createdMs).toISOString(),
          updated_at: new Date(fs.statSync(storePath).mtimeMs).toISOString(),
          file_path: storePath,
          tokens: Math.ceil(parsed.messages.map((m) => m.content).join("").length / 4),
          prompt: (firstUser?.content || sess.name).slice(0, 120),
          recognition_confidence: parsed.confidence,
          extra: {
            session_id: sess.name,
            workspace_key: ws.name,
            kind: "cursor_cli",
          },
          ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}),
        },
      };
      records.push(record);
    }
  }
  return records;
}
