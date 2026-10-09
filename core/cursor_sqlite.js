/**
 * Cursor / VSCode SQLite reader — reads conversation data from *.vscdb files.
 * These are LevelDB/IndexedDB-backed key-value stores wrapped in SQLite by VSCode.
 *
 * Supports:
 *   - Classic aiChat / conversation keys
 *   - Cursor Composer (composerData)
 *   - Roo-Cline tasks
 *   - aiService prompt history
 */

import Database from "better-sqlite3";
import fs from "fs-extra";
import crypto from "crypto";
import { glob } from "glob";
import pLimit from "p-limit";
import { SCHEMA_VERSION } from "./normalize.js";
import { vscdbWorkspaceAbsPaths } from "./utils.js";
import { expandMessageList } from "./content.js";

// Keys to query from the ItemTable
// Use exact match (key = 'xxx') for specific keys, LIKE for patterns
const EXACT_KEYS = [
  "composer.composerData",
  "aiService.generations",
  "memento/webviewView.augment-chat",
];

const LIKE_PATTERNS = [
  "%conversation%",
  "%aiChat%",
  "%chat%",
  "%composer%",
  "%aiService%",
  "%workbench.panel.aichat%",
  "%roo-cline%",
  "%github.copilot%",
  "%aichat%",
  "%memento%",
];

/**
 * Infer which IDE / agent product owns this *.vscdb path (Cursor, VS Code, Windsurf, …).
 * Order matters: more specific app folders before generic `/code/`.
 */
export function inferSourceFromVscdbPath(dbPath) {
  const p = dbPath.replace(/\\/g, "/").toLowerCase();
  // WorkBuddy family (before generic Code/CodeBuddy rules)
  if (p.includes("/workbuddy cn/")) return "workbuddy";
  if (p.includes("/workbuddy/")) return "workbuddy";
  // ZCode (Zhipu Z.ai) — must precede generic /code/ rule
  if (p.includes("/zcode/")) return "zcode";
  if (p.includes("/antigravity/")) return "antigravity";
  if (p.includes("/windsurf/")) return "windsurf";
  if (p.includes("/vscodium/")) return "vscode_copilot";
  // Trae Work before Trae — "trae" is a substring of every Trae Work path
  if (p.includes("/trae work cn/") || p.includes("/trae-work/") || p.includes("/traework/")) return "traework";
  if (p.includes("/trae work/")) return "traework";
  if (p.includes("/trae cn/")) return "trae";
  if (p.includes("/trae/")) return "trae";
  if (p.includes("/codebuddy/")) return "codebuddy";
  if (p.includes("/qoder/")) return "qoder";
  if (p.includes("/augment/")) return "augment";
  if (p.includes("/claude/")) return "claude_code";
  if (p.includes("/cursor/")) return "cursor";
  if (p.includes("/code - insiders/")) return "vscode_copilot";
  if (p.includes("/code/")) return "vscode_copilot";
  return "cursor";
}

/**
 * All known VS Code–family workspaceStorage roots (per OS). Missing dirs are skipped.
 */
export function getVscdbWorkspaceRootCandidates() {
  return vscdbWorkspaceAbsPaths();
}

/**
 * Discover *.vscdb under all IDE workspaceStorage dirs and read conversations.
 */
export async function collectAllVscdbRecords() {
  const roots = getVscdbWorkspaceRootCandidates();
  const seen = new Set();
  const allPaths = [];
  for (const root of roots) {
    if (!(await fs.pathExists(root))) continue;
    const files = await findVscdbFiles(root).catch(() => []);
    for (const f of files) {
      if (!seen.has(f)) {
        seen.add(f);
        allPaths.push(f);
      }
    }
  }
  return readAllCursorSqlite(allPaths);
}

/**
 * Find all *.vscdb files under a root directory (up to depth levels).
 * @param {string} rootDir
 * @param {number} [maxDepth=3]
 * @returns {Promise<string[]>}
 */
export async function findVscdbFiles(rootDir, maxDepth = 3) {
  try {
    const files = await glob("**/*.vscdb", {
      cwd: rootDir,
      absolute: true,
      nodir: true,
      maxDepth,
      ignore: ["**/node_modules/**"],
    });
    return files;
  } catch {
    return [];
  }
}

/**
 * Read all vscdb files concurrently with a concurrency limit.
 * @param {string[]} dbPaths
 * @param {number} [workers=4]
 * @returns {Promise<Array>}  Unified schema records
 */
export async function readAllCursorSqlite(dbPaths, workers = 4) {
  const limit = pLimit(workers);
  const allResults = await Promise.all(
    dbPaths.map((p) => limit(() => readCursorSqlite(p)))
  );
  return allResults.flat();
}

/**
 * Read conversations from a single Cursor/VSCode *.vscdb file.
 * Returns unified schema records.
 * @param {string} dbPath
 * @returns {Array}
 */
export function readCursorSqlite(dbPath) {
  const results = [];
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return results; // Not a valid SQLite file
  }

  try {
    // Build query: exact match for specific keys, LIKE for patterns
    const exactPlaceholders = EXACT_KEYS.map(() => "key = ?").join(" OR ");
    const likePlaceholders = LIKE_PATTERNS.map(() => "key LIKE ?").join(" OR ");
    const whereClause = exactPlaceholders && likePlaceholders
      ? `(${exactPlaceholders}) OR (${likePlaceholders})`
      : exactPlaceholders || `(${likePlaceholders})`;
    
    const stmt = db.prepare(
      `SELECT key, value FROM ItemTable WHERE ${whereClause} LIMIT 2000`
    );
    const rows = stmt.all(...EXACT_KEYS, ...LIKE_PATTERNS);

    for (const row of rows) {
      try {
        const raw =
          typeof row.value === "string"
            ? row.value
            : row.value?.toString("utf-8");
        if (!raw || raw.length < 10) continue;

        const parsed = JSON.parse(raw);
        const { messages, createdAt, updatedAt } = extractMessages(parsed, row.key);
        if (messages.length === 0) continue;

        const firstUser = messages.find((m) => m.role === "user");
        const prompt = firstUser?.content?.slice(0, 120) || row.key;
        const textContent = messages.map((m) => m.content || "").join("");
        const tokens = estimateTokens(textContent);
        const threadId = crypto
          .createHash("sha1")
          .update(dbPath + row.key)
          .digest("hex")
          .slice(0, 16);

        results.push({
          schema_version: SCHEMA_VERSION,
          thread_id: threadId,
          type: "thread",
          messages,
          context: { files: [], diffs: [] },
          meta: {
            source: inferSourceFromVscdbPath(dbPath),
            project: inferProjectFromPath(dbPath),
            created_at: createdAt || inferTimestampFromKey(row.key),
            updated_at: updatedAt || createdAt || inferTimestampFromKey(row.key),
            file_path: dbPath,
            sqlite_key: row.key,
            tokens,
            prompt,
            recognition_confidence: EXACT_KEYS.includes(row.key) ? "high" : "low",
          },
        });
      } catch {
        // Skip malformed rows
      }
    }
  } catch {
    // Table might not exist — not all vscdb are conversation stores
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  return results;
}

// ─── Message extractors ───────────────────────────────────────────────────────

function extractMessages(parsed, key = "") {
  let createdAt = null;
  let updatedAt = null;

  // 0. Cursor composer.composerData: { allComposers: [{ name, conversation: [...] }] }
  if (key === "composer.composerData" && Array.isArray(parsed?.allComposers)) {
    const allMessages = [];
    for (const composer of parsed.allComposers) {
      if (Array.isArray(composer.conversation)) {
        allMessages.push(...expandMessageList(composer.conversation));
        if (composer.createdAt && !createdAt) createdAt = new Date(composer.createdAt).toISOString();
        if (composer.lastUpdatedAt) updatedAt = new Date(composer.lastUpdatedAt).toISOString();
      }
    }
    if (allMessages.length > 0) {
      return { messages: allMessages, createdAt, updatedAt };
    }
  }

  // 0a. aiService.generations: { "0": { unixMs, textDescription }, ... }
  if (key === "aiService.generations" && parsed && typeof parsed === "object") {
    const entries = Object.values(parsed).filter(g => g?.textDescription);
    if (entries.length > 0) {
      // Each entry is an AI generation (textDescription describes what was produced).
      // No user prompt is stored in this key, so all entries are assistant messages.
      const messages = entries.map((g) => ({
        role: "assistant",
        content: g.textDescription || "",
        ...(g.unixMs ? { timestamp: new Date(g.unixMs).toISOString() } : {}),
      }));
      if (entries[0]?.unixMs) createdAt = new Date(entries[0].unixMs).toISOString();
      if (entries[entries.length - 1]?.unixMs) updatedAt = new Date(entries[entries.length - 1].unixMs).toISOString();
      return { messages, createdAt, updatedAt };
    }
  }

  // 1. Cursor Composer schema: { composerData: { conversation: [...] } }
  if (parsed?.composerData?.conversation) {
    const conv = parsed.composerData.conversation;
    if (Array.isArray(conv) && conv.length > 0) {
      const messages = expandMessageList(conv);
      createdAt = conv[0]?.timestamp || null;
      updatedAt = conv[conv.length - 1]?.timestamp || null;
      return { messages, createdAt, updatedAt };
    }
  }

  // 2. Cursor tabs schema: { tabs: [{ bubbles: [{ type, rawText }] }] }
  if (Array.isArray(parsed?.tabs) && parsed.tabs[0]?.bubbles) {
    const messages = [];
    for (const tab of parsed.tabs) {
      const startTime = tab.bubbles?.[0]?.timingInfo?.clientStartTime;
      if (!createdAt && startTime) createdAt = new Date(startTime).toISOString();
      for (const bubble of tab.bubbles || []) {
        messages.push(...expandMessageList([{
          role: bubble.type === "ai" ? "assistant" : "user",
          content: bubble.rawText || bubble.text || bubble.content || "",
        }]));
      }
      const lastTime = tab.bubbles?.[tab.bubbles.length - 1]?.timingInfo?.clientStartTime;
      if (lastTime) updatedAt = new Date(lastTime).toISOString();
    }
    if (messages.length > 0) return { messages, createdAt, updatedAt };
  }

  // 3. Standard messages array: { messages: [{ role, content }] }
  if (Array.isArray(parsed?.messages) && parsed.messages[0]?.role) {
    const messages = expandMessageList(parsed.messages);
    createdAt = parsed.messages[0]?.timestamp || null;
    updatedAt = parsed.messages[parsed.messages.length - 1]?.timestamp || null;
    return { messages, createdAt, updatedAt };
  }

  // 4. Conversation/history arrays
  const candidateArrays = [
    parsed?.conversation,
    parsed?.history,
    parsed?.convo,
  ];
  for (const arr of candidateArrays) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    if (arr[0]?.role || arr[0]?.type) {
      const messages = expandMessageList(arr);
      createdAt = arr[0]?.timestamp || null;
      updatedAt = arr[arr.length - 1]?.timestamp || null;
      return { messages, createdAt, updatedAt };
    }
  }

  // 5. Roo-Cline task format: { taskHistory: [...] } or { messages: [{role,ts,content}] }
  if (Array.isArray(parsed?.taskHistory)) {
    const messages = expandMessageList(parsed.taskHistory.map((m) => ({
      role: m.role || "user",
      content: m.content || m.text || "",
      ...(m.ts ? { timestamp: new Date(m.ts * 1000).toISOString() } : {}),
    })));
    if (messages.length > 0) {
      updatedAt = messages[messages.length - 1]?.timestamp || null;
      return { messages, createdAt, updatedAt };
    }
  }

  return { messages: [], createdAt, updatedAt };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inferTimestampFromKey(key = "") {
  // Some Cursor keys embed unix timestamps: "aiChat.1704067200000"
  const tsMatch = key.match(/(\d{13})/);
  if (tsMatch) {
    try {
      return new Date(parseInt(tsMatch[1], 10)).toISOString();
    } catch { /* ignore */ }
  }
  return new Date().toISOString();
}

function estimateTokens(text = "") {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const latin = text.length - cjk;
  return Math.ceil(cjk + latin / 4);
}

function inferProjectFromPath(dbPath) {
  const parts = dbPath.replace(/\\/g, "/").split("/");
  const WORKSPACE_PARENTS = ["work", "projects", "workspace", "repos", "dev"];
  const workIdx = parts.findIndex((p) => WORKSPACE_PARENTS.includes(p));
  if (workIdx >= 0 && parts[workIdx + 1]) return parts[workIdx + 1];
  // workspaceStorage hash dir → look at the hash's parent for hints
  return parts[Math.max(0, parts.length - 2)] || "cursor";
}
