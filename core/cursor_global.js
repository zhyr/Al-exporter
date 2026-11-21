/**
 * Cursor globalStorage reader — modern desktop Composer store.
 *
 * Cursor ≥ 0.45 keeps desktop Composer conversations in
 *   <userData>/globalStorage/state.vscdb
 * inside two SQLite tables:
 *   - composerHeaders  (generated typed table, one row per composer)
 *   - cursorDiskKV     (key/value: composerData, bubbleId, checkpointId, agentKv…)
 *
 * This module:
 *   1. snapshots the database (main file + `-wal`/`-shm`) before parsing so a
 *      live WAL checkpoint cannot tear a read;
 *   2. rebuilds every composer's message stream in Cursor's own order
 *      (`fullConversationHeadersOnly` → `conversationMap` → `bubbleId` rows);
 *   3. keeps the original record (key + payload) addressable through the index
 *      and, on request, writes raw sidecars and agentKv/artifact binaries;
 *   4. emits an index (`cursor-index.jsonl`) and an audit report that reconcile
 *      headers ↔ composerData ↔ exported threads ↔ agent transcript sessions.
 *
 * The reader is read-only: it never writes to Cursor's storage.
 */

import Database from "better-sqlite3";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SCHEMA_VERSION } from "./normalize.js";
import { contentToString } from "./content.js";

export const CURSOR_INDEX_FILENAME = "cursor-index.jsonl";
export const CURSOR_INDEX_MANIFEST_FILENAME = "cursor-index.json";
export const CURSOR_AUDIT_RELPATH = path.join("audit", "cursor-audit.json");
export const CURSOR_ARTIFACT_DIR = "cursor-artifacts";
export const CURSOR_RAW_DIR = "cursor-raw";

/** Default cap per composer to keep one runaway DB from exhausting memory. */
const DEFAULT_MAX_BUBBLES_PER_COMPOSER = 20000;

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Candidate `state.vscdb` paths for Cursor global storage, per platform.
 * @param {{ platform?: string, home?: string }} [opts]
 * @returns {string[]}
 */
export function cursorGlobalDbCandidates({ platform = process.platform, home = os.homedir() } = {}) {
  const out = [];
  if (platform === "darwin") {
    out.push(path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"));
    out.push(path.join(home, "Library/Application Support/Cursor Nightly/User/globalStorage/state.vscdb"));
  } else if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData/Roaming");
    out.push(path.join(appData, "Cursor/User/globalStorage/state.vscdb"));
  } else {
    out.push(path.join(home, ".config/Cursor/User/globalStorage/state.vscdb"));
  }
  return out;
}

/** First existing Cursor global database, or null. */
export async function findCursorGlobalDb(opts = {}) {
  for (const candidate of cursorGlobalDbCandidates(opts)) {
    if (await fs.pathExists(candidate)) return candidate;
  }
  return null;
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

function sha256FileSync(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Copy the database (and its WAL sidecars) into a private temp directory and
 * open the copy read-only. Copying before opening guarantees that writes made
 * by a running Cursor — including pages still only in `-wal` — cannot change
 * the bytes mid-parse.
 */
export async function openSnapshot(dbPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aex-cursor-global-"));
  const snapshot = path.join(tempDir, path.basename(dbPath));
  const originals = { db: dbPath, wal: `${dbPath}-wal`, shm: `${dbPath}-shm` };
  const copied = [];
  const hashes = {};
  for (const [kind, source] of Object.entries(originals)) {
    if (!(await fs.pathExists(source))) continue;
    const target = kind === "db" ? snapshot : `${snapshot}-${kind}`;
    await fs.copyFile(source, target);
    copied.push(kind);
    hashes[kind] = { sha256: sha256FileSync(source), bytes: (await fs.stat(source)).size };
  }
  let db;
  try {
    db = new Database(snapshot, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
  } catch (error) {
    await fs.remove(tempDir).catch(() => {});
    throw new Error(`cannot open Cursor global storage snapshot: ${error.message}`);
  }
  return {
    db,
    dbPath,
    snapshot,
    copied,
    hashes,
    async close() {
      try { db.close(); } catch { /* ignore */ }
      await fs.remove(tempDir).catch(() => {});
    },
  };
}

// ─── SQLite helpers ──────────────────────────────────────────────────────────

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
}

function tableColumns(db, name) {
  if (!tableExists(db, name)) return [];
  return db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all().map((c) => c.name);
}

function toText(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

function parseJson(value) {
  const text = toText(value);
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function toIso(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function estimateTokens(text = "") {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const latin = text.length - cjk;
  return Math.ceil(cjk + latin / 4);
}

function slugify(value = "") {
  return String(value).toLowerCase()
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[\\/?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .substring(0, 60).replace(/^_+|_+$/g, "") || "untitled";
}

function fileUriToPath(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("file://")) {
    try { return decodeURIComponent(value.replace(/^file:\/\//, "")); } catch { return null; }
  }
  return value;
}

// ─── Bubble body extraction ──────────────────────────────────────────────────

const MESSAGE_KEYS = ["text", "toolFormerData", "codeBlocks", "thinking", "richText"];

/**
 * Bubble payloads are wrapped differently across Cursor versions. Find the
 * first object that looks like a message body instead of assuming a fixed
 * envelope shape.
 */
function findMessageNode(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 8)) {
      const found = findMessageNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (MESSAGE_KEYS.some((key) => key in node)) return node;
  for (const key of ["bubble", "message", "data", "document", "value", "payload", "content", "entries"]) {
    if (node[key] && typeof node[key] === "object") {
      const found = findMessageNode(node[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function stringifyValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function extractToolCall(node) {
  const data = node?.toolFormerData;
  if (!data || typeof data !== "object") return null;
  const name = data.tool || data.name || data.toolName || "unknown";
  const callId = data.toolCallId || data.callId || data.id || null;
  const status = data.status || data.resultStatus || null;
  const params = stringifyValue(data.params ?? data.parameters ?? data.input);
  const result = stringifyValue(data.result ?? data.output ?? data.resultText ?? null);
  return { name: String(name), callId: callId ? String(callId) : null, status: status ? String(status) : null, params, result };
}

function extractThinking(node) {
  const raw = node?.thinking;
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (raw.text) return stringifyValue(raw.text);
  return stringifyValue(raw);
}

function extractCodeBlocks(node) {
  const blocks = node?.codeBlocks || node?.codeblocks;
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const p = fileUriToPath(block.uri || block.file || block.path || block.relativePath || block.uriPath);
    const snippet = stringifyValue(block.content ?? block.text ?? block.value ?? "");
    if (p || snippet) out.push({ ...(p ? { path: p } : {}), ...(snippet ? { snippet } : {}) });
  }
  return out;
}

function bubbleTypeOf(node) {
  const raw = node?.type ?? node?.messageType ?? node?.role;
  if (raw === 1 || raw === "1" || raw === "human" || raw === "user") return 1;
  if (raw === 2 || raw === "2" || raw === "ai" || raw === "assistant") return 2;
  return 0;
}

// ─── Composer parsing ────────────────────────────────────────────────────────

function readComposerHeaders(db) {
  const headers = new Map();
  if (!tableExists(db, "composerHeaders")) return headers;
  const cols = tableColumns(db, "composerHeaders");
  const select = cols.filter((c) => c !== "value");
  const rows = db.prepare(`SELECT ${select.map((c) => `"${c}"`).join(", ")}${cols.includes("value") ? ', "value"' : ""} FROM composerHeaders`).all();
  for (const row of rows) {
    const composerId = row.composerId || row.composer_id || row.id;
    if (!composerId) continue;
    const value = row.value != null ? parseJson(row.value) : null;
    headers.set(String(composerId), { row, value: value && typeof value === "object" ? value : null });
  }
  return headers;
}

function readRemoteAgentHeaderIds(db) {
  if (!tableExists(db, "remoteAgentHeaders")) return [];
  try {
    return db.prepare("SELECT composerId FROM remoteAgentHeaders").all().map((r) => String(r.composerId));
  } catch {
    return [];
  }
}

function composerDataQuery(db) {
  return db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
}

function bubbleRowsFor(db, composerId, limit) {
  return db.prepare("SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid LIMIT ?")
    .all(`bubbleId:${composerId}:%`, limit);
}

function kvRowsForPrefix(db, prefix) {
  try {
    return db.prepare("SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid").all(`${prefix}%`);
  } catch {
    return [];
  }
}

/**
 * Split a `bubbleId:<composerId>:<bubbleId>` key. Composer ids can contain
 * colons in theory, so resolve using the known composer id rather than a
 * naive split.
 */
function bubbleIdFromKey(key, composerId) {
  const prefix = `bubbleId:${composerId}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key.split(":").pop();
}

function buildMessages({ composerId, bubbleRows, conversationMap, order, persistRaw, rawWriter, stats }) {
  const messages = [];
  const contextFiles = [];
  const rowById = new Map();
  for (const row of bubbleRows) rowById.set(bubbleIdFromKey(row.key, composerId), row);

  const orderedIds = [];
  const seen = new Set();
  const pushId = (id) => {
    if (typeof id !== "string" || !id || seen.has(id)) return;
    seen.add(id);
    orderedIds.push(id);
  };
  for (const id of order) pushId(id);
  for (const id of rowById.keys()) pushId(id);
  if (conversationMap && typeof conversationMap === "object") {
    for (const id of Object.keys(conversationMap)) pushId(id);
  }

  for (const bubbleId of orderedIds) {
    const row = rowById.get(bubbleId) || null;
    let parsed;
    let rawKey = row?.key || null;
    if (row) {
      parsed = parseJson(row.value);
      if (parsed === undefined) stats.unparsableBubbles++;
    } else if (conversationMap && bubbleId in conversationMap) {
      parsed = conversationMap[bubbleId];
      stats.messagesFromConversationMap++;
      rawKey = `composerData.conversationMap:${bubbleId}`;
    } else {
      stats.missingBubbles++;
      continue;
    }
    const node = findMessageNode(parsed);
    if (!node) {
      stats.emptyBubbles++;
      continue;
    }

    if (persistRaw && rawWriter && row) {
      rawWriter({ key: row.key, value: row.value });
    }

    const type = bubbleTypeOf(node);
    const text = contentToString(node.text ?? node.richText ?? "");
    const thinking = extractThinking(node);
    const tool = extractToolCall(node);
    const codeBlocks = extractCodeBlocks(node);
    const timestamp = toIso(node.createdAt || node.timestamp || node.timingInfo?.clientStartTime);

    if (text || thinking || tool || codeBlocks.length) {
      const meta = {
        cursor: {
          key: rawKey,
          bubble_id: bubbleId,
          bubble_type: type,
          ...(node.tokenCount != null ? { token_count: node.tokenCount } : {}),
        },
      };
      if (thinking) meta.cursor.thinking = thinking;
      if (tool) meta.cursor.tool = { name: tool.name, status: tool.status, call_id: tool.callId };

      const role = type === 1 ? "user" : type === 2 ? "assistant" : "unknown";
      const placeholder = text || (thinking ? "" : tool ? `[Tool Use] ${tool.name}` : "[Code Block]");
      if (placeholder || thinking) {
        messages.push({
          role,
          content: placeholder,
          ...(timestamp ? { timestamp } : {}),
          id: bubbleId,
          id_source: "cursor.bubble_id",
          meta,
        });
      }
      if (tool) {
        messages.push({
          role: "tool",
          content: `[Tool Use] ${tool.name}${tool.params ? `\n${tool.params}` : ""}`,
          ...(timestamp ? { timestamp } : {}),
          id: bubbleId,
          id_source: "cursor.bubble_id.tool_use",
          tool_call: { name: tool.name, status: tool.status, call_id: tool.callId, phase: "call" },
          meta,
        });
        if (tool.result) {
          messages.push({
            role: "tool",
            content: `[Tool Result] ${tool.name}\n${tool.result}`,
            ...(timestamp ? { timestamp } : {}),
            id: bubbleId,
            id_source: "cursor.bubble_id.tool_result",
            tool_call: { name: tool.name, status: tool.status, call_id: tool.callId, phase: "result" },
            meta,
          });
          stats.toolResults++;
        }
        stats.toolCalls++;
      }
      if (thinking) stats.thinkingBubbles++;
      for (const block of codeBlocks) contextFiles.push(block);
    } else {
      stats.emptyBubbles++;
    }
  }
  return { messages, contextFiles };
}

// ─── Workspace resolution ────────────────────────────────────────────────────

function workspaceStorageRoots(globalDbPath) {
  const userRoot = path.dirname(path.dirname(globalDbPath)); // .../User
  return [path.join(userRoot, "workspaceStorage")];
}

function resolveWorkspaceFolder(workspaceId, roots, cache) {
  if (!workspaceId) return null;
  if (cache.has(workspaceId)) return cache.get(workspaceId);
  let folder = null;
  for (const root of roots) {
    const workspaceJson = path.join(root, String(workspaceId), "workspace.json");
    try {
      if (!fs.existsSync(workspaceJson)) continue;
      const parsed = JSON.parse(fs.readFileSync(workspaceJson, "utf8"));
      const uri = parsed.folder || parsed.workspace;
      if (uri) { folder = fileUriToPath(uri); break; }
    } catch { /* keep looking */ }
  }
  cache.set(workspaceId, folder);
  return folder;
}

function projectFromCwd(cwd, fallback) {
  if (cwd) {
    const base = path.basename(String(cwd).replace(/[\\/]+$/, ""));
    if (base) return base;
  }
  return fallback || "cursor";
}

// ─── KV inventory / artifacts ────────────────────────────────────────────────

function kvNamespaceInventory(db) {
  if (!tableExists(db, "cursorDiskKV")) return [];
  try {
    return db.prepare(`
      SELECT CASE
               WHEN instr(key, ':') > 0 THEN substr(key, 1, instr(key, ':') - 1)
               ELSE key
             END AS namespace,
             COUNT(*) AS rows,
             COALESCE(SUM(LENGTH(value)), 0) AS bytes
      FROM cursorDiskKV
      GROUP BY namespace
      ORDER BY rows DESC
    `).all();
  } catch {
    return [];
  }
}

const PERSISTED_KV_NAMESPACES = [
  "agentKv:artifact:",
  "agentKv:blob:",
  "agentKv:checkpoint:",
  "agentKv:bubbleCheckpoint:",
  "checkpointId:",
];

function isUtf8Json(buffer) {
  if (!Buffer.isBuffer(buffer)) return typeof buffer === "string";
  if (buffer.includes(0)) return false;
  const text = buffer.toString("utf8");
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

function writeKvPayload(outDir, relPath, value) {
  fs.ensureDirSync(path.dirname(path.join(outDir, relPath)));
  if (isUtf8Json(value)) {
    fs.writeFileSync(path.join(outDir, relPath), toText(value));
    return { encoding: "utf8" };
  }
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  fs.writeFileSync(path.join(outDir, relPath), buffer);
  return { encoding: "binary", bytes: buffer.length };
}

// ─── Transcript alignment ────────────────────────────────────────────────────

/**
 * Collect session UUIDs from Cursor's agent transcript tree
 * (`~/.cursor/projects/<project>/agent-transcripts/<uuid>/`). Directory names
 * only — transcript file contents are handled by the file-based scanner.
 */
export async function scanCursorTranscriptSessionIds({ home = os.homedir(), limit = 20000 } = {}) {
  const roots = [path.join(home, ".cursor/projects"), path.join(home, ".cursor/agent-transcripts")];
  const ids = new Set();
  let scannedDirs = 0;
  for (const root of roots) {
    if (!(await fs.pathExists(root))) continue;
    let projectDirs = [];
    try { projectDirs = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const transcriptsRoot = root.endsWith("agent-transcripts")
        ? root
        : path.join(root, projectDir.name, "agent-transcripts");
      let sessionDirs = [];
      try { sessionDirs = await fs.readdir(transcriptsRoot, { withFileTypes: true }); } catch { continue; }
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;
        scannedDirs++;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionDir.name)) {
          ids.add(sessionDir.name.toLowerCase());
        }
        if (ids.size >= limit) break;
      }
      if (ids.size >= limit) break;
    }
    if (ids.size >= limit) break;
  }
  return { ids: [...ids], scanned_dirs: scannedDirs, limit_reached: ids.size >= limit };
}

// ─── Main reader ─────────────────────────────────────────────────────────────

/**
 * Read every desktop Composer from Cursor global storage.
 *
 * @param {object} opts
 * @param {string}  [opts.dbPath]               explicit state.vscdb path
 * @param {string}  [opts.outputDir]            enables raw/artifact sidecars
 * @param {boolean} [opts.persistRaw=false]     write raw cursorDiskKV rows per composer
 * @param {boolean} [opts.persistArtifacts=false] write agentKv/checkpoint payloads
 * @param {number}  [opts.maxBubblesPerComposer]
 * @param {boolean} [opts.includeTranscripts=true] align with ~/.cursor/projects
 * @param {(record: object, entry: object) => Promise<void>|void} [opts.onRecord]
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<{ records: object[], index: object[], audit: object, dbPath: string|null, skipped: string|null }>}
 */
export async function collectCursorGlobalRecords(opts = {}) {
  const {
    outputDir = null,
    persistRaw = false,
    persistArtifacts = false,
    maxBubblesPerComposer = DEFAULT_MAX_BUBBLES_PER_COMPOSER,
    includeTranscripts = true,
    onRecord = null,
    onProgress = null,
  } = opts;

  const progress = (msg) => { if (onProgress) onProgress(msg); };
  const dbPath = opts.dbPath || (await findCursorGlobalDb());
  const dbExists = dbPath ? await fs.pathExists(dbPath) : false;
  if (!dbPath || !dbExists) {
    return {
      records: [],
      index: [],
      dbPath: null,
      skipped: "cursor-global-not-found",
      audit: {
        generated_at: new Date().toISOString(),
        skipped: "cursor-global-not-found",
        candidates: cursorGlobalDbCandidates(),
      },
    };
  }

  progress(`Snapshotting Cursor global storage (${dbPath})…`);
  const snap = await openSnapshot(dbPath);
  const records = [];
  const index = [];
  const audit = {
    generated_at: new Date().toISOString(),
    db_path: dbPath,
    snapshot_copied: snap.copied,
    source_hashes: snap.hashes,
    schema: {},
    counts: {},
    coverage: {},
    namespaces: [],
    alignment: {},
    issues: [],
    composers: [],
  };

  try {
    const db = snap.db;
    audit.schema = {
      user_version: db.pragma("user_version", { simple: true }),
      journal_mode: db.pragma("journal_mode", { simple: true }),
      has_item_table: tableExists(db, "ItemTable"),
      has_cursor_disk_kv: tableExists(db, "cursorDiskKV"),
      has_composer_headers: tableExists(db, "composerHeaders"),
      has_remote_agent_headers: tableExists(db, "remoteAgentHeaders"),
      composer_header_columns: tableColumns(db, "composerHeaders"),
      cursor_disk_kv_columns: tableColumns(db, "cursorDiskKV"),
    };
    if (!audit.schema.has_cursor_disk_kv) {
      audit.skipped = "cursorDiskKV-missing";
      audit.issues.push("cursorDiskKV table not found; this is a pre-Composer or non-Cursor database");
      return { records, index, audit, dbPath, skipped: audit.skipped };
    }

    audit.namespaces = kvNamespaceInventory(db);
    const headers = readComposerHeaders(db);
    const headerIds = [...headers.keys()];
    const remoteIds = readRemoteAgentHeaderIds(db);
    const composerRows = composerDataQuery(db);
    const composerIds = [];
    const composerDataById = new Map();
    for (const row of composerRows) {
      const id = row.key.slice("composerData:".length);
      const parsed = parseJson(row.value);
      if (parsed === undefined) {
        audit.issues.push(`unparsable composerData JSON: ${row.key}`);
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        audit.issues.push(`empty composerData: ${row.key}`);
        continue;
      }
      composerIds.push(id);
      composerDataById.set(id, parsed);
    }

    const roots = workspaceStorageRoots(dbPath);
    const workspaceCache = new Map();

    // agentKv / checkpoint inventory per composer (counts always; payloads optional)
    const artifactStats = new Map();
    for (const prefix of PERSISTED_KV_NAMESPACES) {
      const rows = kvRowsForPrefix(db, prefix);
      for (const row of rows) {
        const rest = row.key.slice(prefix.length);
        const composerId = rest.includes(":") ? rest.slice(0, rest.indexOf(":")) : rest;
        const entry = artifactStats.get(composerId) || { blobs: 0, checkpoints: 0, artifacts: 0, bytes: 0, files: [] };
        const size = Buffer.isBuffer(row.value) ? row.value.length : Buffer.byteLength(String(row.value ?? ""));
        entry.bytes += size;
        if (prefix === "agentKv:artifact:") entry.artifacts++;
        else if (prefix === "agentKv:blob:") entry.blobs++;
        else entry.checkpoints++;
        if (persistArtifacts && outputDir) {
          const namespace = prefix.replace(/:$/, "").replace(/:/g, "_");
          const rel = path.join(CURSOR_ARTIFACT_DIR, slugify(composerId), `${namespace}-${slugify(rest.slice(composerId.length + 1) || composerId)}.bin`);
          const written = writeKvPayload(outputDir, rel, row.value);
          entry.files.push({ key: row.key, file: rel.replace(/\\/g, "/"), ...written });
        }
        artifactStats.set(composerId, entry);
      }
    }

    const allComposerIds = [...new Set([...headerIds, ...composerIds, ...remoteIds])].sort();
    let exported = 0;
    let empty = 0;
    let errors = 0;
    let headersWithoutData = 0;
    let dataWithoutHeader = 0;
    const missingBubbleIdLists = [];

    for (const composerId of allComposerIds) {
      const header = headers.get(composerId) || null;
      const headerValue = header?.value || {};
      const data = composerDataById.get(composerId) || null;
      if (!data) headersWithoutData++;
      if (data && !header) dataWithoutHeader++;

      const merged = { ...(data || {}), ...(headerValue || {}) };
      const createdAt = toIso(merged.createdAt ?? header?.row?.createdAt ?? header?.row?.created_at ?? data?.createdAt);
      const updatedAt = toIso(merged.lastUpdatedAt ?? header?.row?.lastUpdatedAt ?? header?.row?.last_updated_at ?? data?.lastUpdatedAt) || createdAt;

      const stats = {
        unparsableBubbles: 0,
        missingBubbles: 0,
        emptyBubbles: 0,
        toolCalls: 0,
        toolResults: 0,
        thinkingBubbles: 0,
        messagesFromConversationMap: 0,
      };

      const bubbleRows = data
        ? bubbleRowsFor(db, composerId, maxBubblesPerComposer).map((r) => ({ ...r, composerId }))
        : [];
      if (data) stats.missingBubbles += 0; // missing computed against order below

      const order = Array.isArray(merged.fullConversationHeadersOnly)
        ? merged.fullConversationHeadersOnly.map((h) => h && h.bubbleId).filter(Boolean)
        : [];
      const conversationMap = merged.conversationMap && typeof merged.conversationMap === "object" ? merged.conversationMap : null;

      // Detect ordered ids that have neither a bubble row nor a conversationMap body.
      const rowIds = new Set(bubbleRows.map((r) => bubbleIdFromKey(r.key, composerId)));
      const mapIds = conversationMap ? new Set(Object.keys(conversationMap)) : new Set();
      const missingOrdered = order.filter((id) => !rowIds.has(id) && !mapIds.has(id));

      let rawWriter = null;
      if (persistRaw && outputDir) {
        const rel = path.join(CURSOR_RAW_DIR, slugify(composerId), "bubbles.jsonl");
        const target = path.join(outputDir, rel);
        fs.ensureDirSync(path.dirname(target));
        fs.removeSync(target);
        rawWriter = (item) => {
          const value = item.value;
          const isBinary = Buffer.isBuffer(value) && !isUtf8Json(value);
          fs.appendFileSync(target, `${JSON.stringify({
            key: item.key,
            encoding: isBinary ? "base64" : "utf8",
            value: isBinary ? value.toString("base64") : toText(value),
          })}\n`);
        };
      }

      const { messages, contextFiles } = buildMessages({
        composerId,
        bubbleRows,
        conversationMap,
        order,
        persistRaw,
        rawWriter,
        stats,
      });

      const workspaceId = merged.workspaceIdentifier?.id || merged.workspaceId || header?.row?.workspaceId;
      const cwd = resolveWorkspaceFolder(workspaceId, roots, workspaceCache);
      const isSubagent = merged.isSubagent === true
        || (Array.isArray(merged.subagentComposerIds) && merged.subagentComposerIds.length > 0)
        || Boolean(merged.subagentInfo)
        || /(^|:)task-/.test(composerId) || composerId.startsWith("task-");
      const parentComposerId = merged.subagentInfo?.parentComposerId
        || merged.subagentInfo?.parent_composer_id
        || merged.parentComposerId
        || null;
      const model = merged.modelConfig?.modelName || merged.modelName || merged.model || null;
      const firstUser = messages.find((m) => m.role === "user");
      const prompt = firstUser?.content?.slice(0, 120) || merged.name || composerId;
      const threadId = crypto.createHash("sha1").update(`cursor:composer:${composerId}`).digest("hex").slice(0, 16);

      const createdFallback = createdAt || updatedAt || new Date(fs.statSync(dbPath).mtimeMs).toISOString();
      const firstTimestamp = messages.find((m) => m.timestamp)?.timestamp || null;
      const artifacts = artifactStats.get(composerId) || null;

      const record = {
        schema_version: SCHEMA_VERSION,
        thread_id: threadId,
        type: "thread",
        session: {
          native_id: composerId,
          native_id_kind: isSubagent ? "composer_subagent" : "composer",
          native_id_source: "cursor.globalStorage.cursorDiskKV",
          cwd: cwd || null,
          cwd_source: cwd ? "cursor.workspaceStorage.workspace_json" : null,
          git_remote: null,
          git_remote_source: null,
          agent_version: null,
        },
        messages,
        context: { files: contextFiles, diffs: [] },
        meta: {
          source: "cursor",
          project: projectFromCwd(cwd, "cursor"),
          created_at: createdFallback,
          updated_at: updatedAt || createdFallback,
          model: model ? String(model) : null,
          file_path: dbPath,
          sqlite_key: `composerData:${composerId}`,
          tokens: estimateTokens(messages.map((m) => m.content || "").join("")),
          prompt,
          recognition_confidence: data ? "high" : "low",
          source_detail: "cursor.globalStorage.cursorDiskKV",
          warnings: [
            ...(data ? [] : ["composerData row missing; header-only composer"]),
          ],
          extra: {
            cursor: {
              composer_id: composerId,
              name: merged.name || null,
              subtitle: merged.subtitle || null,
              unified_mode: merged.unifiedMode || null,
              force_mode: merged.forceMode || null,
              is_archived: merged.isArchived === true,
              is_draft: merged.isDraft === true,
              is_subagent: isSubagent,
              parent_composer_id: parentComposerId,
              sub_composer_ids: Array.isArray(merged.subComposerIds) ? merged.subComposerIds : [],
              subagent_composer_ids: Array.isArray(merged.subagentComposerIds) ? merged.subagentComposerIds : [],
              workspace_id: workspaceId || null,
              bubble_rows: bubbleRows.length,
              ordered_bubbles: order.length,
              messages_from_conversation_map: stats.messagesFromConversationMap,
              missing_ordered_bubbles: missingOrdered.length,
              tool_calls: stats.toolCalls,
              tool_results: stats.toolResults,
              thinking_bubbles: stats.thinkingBubbles,
              code_block_files: contextFiles.length,
              conversation_map_present: Boolean(conversationMap),
              full_conversation_headers_present: order.length > 0,
              header_present: Boolean(header),
              composer_data_present: Boolean(data),
              first_bubble_at: firstTimestamp,
              artifacts: artifacts ? {
                blobs: artifacts.blobs,
                checkpoints: artifacts.checkpoints,
                artifact_count: artifacts.artifacts,
                bytes: artifacts.bytes,
                files: artifacts.files,
              } : null,
            },
          },
        },
      };

      const entry = {
        composer_id: composerId,
        thread_id: threadId,
        name: merged.name || null,
        project: cwd ? path.basename(cwd) : null,
        cwd: cwd || null,
        workspace_id: workspaceId || null,
        model,
        created_at: createdFallback,
        updated_at: updatedAt || createdFallback,
        is_archived: merged.isArchived === true,
        is_draft: merged.isDraft === true,
        is_subagent: isSubagent,
        parent_composer_id: parentComposerId,
        header_present: Boolean(header),
        composer_data_present: Boolean(data),
        bubble_count: bubbleRows.length,
        ordered_bubble_count: order.length,
        message_count: messages.length,
        user_message_count: messages.filter((m) => m.role === "user").length,
        assistant_message_count: messages.filter((m) => m.role === "assistant").length,
        tool_calls: stats.toolCalls,
        thinking_bubbles: stats.thinkingBubbles,
        code_block_files: contextFiles.length,
        messages_from_conversation_map: stats.messagesFromConversationMap,
        missing_ordered_bubbles: missingOrdered.length,
        missing_bubble_ids_sample: missingOrdered.slice(0, 20),
        unparsable_bubbles: stats.unparsableBubbles,
        empty_bubbles: stats.emptyBubbles,
        status: messages.length > 0 ? "exported" : (data ? "empty" : "header_only"),
        thread_file: null,
        thread_hash: null,
        artifacts: artifacts ? {
          blobs: artifacts.blobs,
          checkpoints: artifacts.checkpoints,
          artifact_count: artifacts.artifacts,
          bytes: artifacts.bytes,
          files: artifacts.files,
        } : null,
      };

      if (missingOrdered.length > 0 && missingBubbleIdLists.length < 25) {
        missingBubbleIdLists.push({ composer_id: composerId, missing: missingOrdered.slice(0, 20), total: missingOrdered.length });
      }

      index.push(entry);
      if (entry.status === "exported") exported++;
      else if (entry.status === "empty") empty++;
      else headersWithoutData += data ? 0 : 0;

      if (onRecord) await onRecord(record, entry);
      else records.push(record);
    }

    // Bubble rows that belong to no known composer (deleted composer, stray key).
    let orphanBubbleRows = 0;
    try {
      const known = new Set(allComposerIds);
      const rows = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all();
      for (const row of rows) {
        const rest = row.key.slice("bubbleId:".length);
        const id = rest.slice(0, rest.indexOf(":"));
        if (!known.has(id)) orphanBubbleRows++;
      }
    } catch { /* ignore */ }
    if (orphanBubbleRows > 0) {
      audit.issues.push(`${orphanBubbleRows} bubble rows belong to composers without a header or composerData row`);
    }

    audit.counts = {
      composer_headers: headerIds.length,
      remote_agent_headers: remoteIds.length,
      composer_data_rows: composerIds.length,
      composers_total: allComposerIds.length,
      threads_exported: exported,
      threads_empty: empty,
      threads_error: errors,
      subagent_composers: index.filter((e) => e.is_subagent).length,
      archived_composers: index.filter((e) => e.is_archived).length,
      draft_composers: index.filter((e) => e.is_draft).length,
      messages_total: index.reduce((a, e) => a + e.message_count, 0),
      tool_calls_total: index.reduce((a, e) => a + e.tool_calls, 0),
      thinking_bubbles_total: index.reduce((a, e) => a + e.thinking_bubbles, 0),
      artifact_files_persisted: index.reduce((a, e) => a + (e.artifacts?.files?.length || 0), 0),
      artifact_bytes_total: index.reduce((a, e) => a + (e.artifacts?.bytes || 0), 0),
      orphan_bubble_rows: orphanBubbleRows,
      headers_without_composer_data: headersWithoutData,
      composer_data_without_header: dataWithoutHeader,
      missing_ordered_bubbles_total: index.reduce((a, e) => a + e.missing_ordered_bubbles, 0),
    };

    audit.coverage = {
      header_ids_with_thread: index.filter((e) => e.header_present && e.status === "exported").length,
      header_ids_without_thread: headerIds.filter((id) => !index.some((e) => e.composer_id === id && e.status === "exported")).length,
      composer_data_ids_with_thread: index.filter((e) => e.composer_data_present && e.status === "exported").length,
      composer_data_ids_without_thread: composerIds.filter((id) => !index.some((e) => e.composer_id === id && e.status === "exported")).length,
    };
    if (missingBubbleIdLists.length > 0) audit.missing_ordered_bubbles = missingBubbleIdLists;

    if (includeTranscripts) {
      progress("Aligning composer index with Cursor agent transcripts…");
      const transcripts = await scanCursorTranscriptSessionIds();
      const composerIdSet = new Set(allComposerIds.map((id) => id.toLowerCase()));
      const matched = transcripts.ids.filter((id) => composerIdSet.has(id));
      const transcriptOnly = transcripts.ids.filter((id) => !composerIdSet.has(id));
      audit.alignment = {
        transcript_sessions_found: transcripts.ids.length,
        transcript_dirs_scanned: transcripts.scanned_dirs,
        transcript_limit_reached: transcripts.limit_reached,
        composer_ids_matching_transcript: matched.length,
        composer_ids_without_transcript: allComposerIds.length - matched.length,
        transcript_sessions_without_composer: transcriptOnly.length,
        transcript_only_sample: transcriptOnly.slice(0, 20),
        note: "Desktop composers and agent transcripts use independent ids; matching ids are a strong signal, absence is not proof of loss.",
      };
    }

    audit.composers = index.map((e) => ({
      composer_id: e.composer_id,
      thread_id: e.thread_id,
      status: e.status,
      is_subagent: e.is_subagent,
      parent_composer_id: e.parent_composer_id,
      bubble_count: e.bubble_count,
      message_count: e.message_count,
      thread_file: e.thread_file,
    }));
    return { records, index, audit, dbPath, skipped: null };
  } finally {
    await snap.close();
  }
}

// ─── Index / audit writing ───────────────────────────────────────────────────

/**
 * Attach written thread files from the export manifest to index entries.
 * Called after the export loop so the index can point at final filenames.
 */
export function attachThreadFiles(index, manifestItems) {
  const byThread = new Map();
  for (const item of manifestItems) {
    if (item?.thread_id && item?.file) byThread.set(item.thread_id, item);
  }
  for (const entry of index) {
    const item = byThread.get(entry.thread_id);
    if (item) {
      entry.thread_file = item.file;
      entry.thread_hash = item.hash || null;
    }
  }
  return index;
}

/**
 * Write `cursor-index.jsonl` and `cursor-index.json`.
 */
export async function writeCursorIndex(outputDir, index, audit, extra = {}) {
  await fs.ensureDir(outputDir);
  const lines = index.map((entry) => JSON.stringify(entry)).join("\n");
  const body = lines ? `${lines}\n` : "";
  const indexPath = path.join(outputDir, CURSOR_INDEX_FILENAME);
  await fs.writeFile(indexPath, body);
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const summary = {
    generated_at: new Date().toISOString(),
    db_path: audit?.db_path || null,
    schema_version: SCHEMA_VERSION,
    index_sha256: sha256,
    entries: index.length,
    by_status: index.reduce((acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    }, {}),
    ...extra,
  };
  await fs.writeJson(path.join(outputDir, CURSOR_INDEX_MANIFEST_FILENAME), summary, { spaces: 2 });
  return { indexPath, manifestPath: path.join(outputDir, CURSOR_INDEX_MANIFEST_FILENAME), sha256 };
}

/** Write `audit/cursor-audit.json`. */
export async function writeCursorAudit(outputDir, audit) {
  const auditPath = path.join(outputDir, CURSOR_AUDIT_RELPATH);
  await fs.ensureDir(path.dirname(auditPath));
  await fs.writeJson(auditPath, audit, { spaces: 2 });
  return auditPath;
}
