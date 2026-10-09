import os from "os";
import fs from "fs-extra";
import path from "path";

/**
 * Safely read a file as UTF-8. Returns null on error.
 */
export async function safeRead(file) {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read only the first N bytes of a file (for header sniffing).
 * Returns null on error.
 */
export async function safeReadHeader(file, bytes = 512) {
  try {
    const fd = await fs.open(file, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    await fd.close();
    return buf.slice(0, bytesRead).toString("utf-8");
  } catch {
    return null;
  }
}

// Common keyword patterns for quick header checks
const CHAT_KEYWORDS = [
  "messages", "history", "threads", "conversation", "role", "assistant",
  "plan", "mcp", "convo", "chat", "session", "bubbles", "aiChat",
  // Forge / agent runtime run_logs
  "trace_id", "tool_id", "payload", "agent_start", "agent_end", "lane_task", "event",
];

/**
 * Determine if a file is worth full reading based on:
 * 1. Extension allow-list
 * 2. Path keyword matching
 * 3. For JSON: header content check (first 512 bytes)
 */
export function isInterestingFile(file, headerContent = null) {
  const f = file.toLowerCase();

  // Exclude build artifacts and noise
  if (
    f.endsWith(".map") || f.endsWith(".ts") || f.endsWith(".js") ||
    f.endsWith(".html") || f.endsWith(".css") || f.endsWith(".node") ||
    f.endsWith(".vsixmanifest") || f.endsWith(".tmlanguage")
  ) return false;
  if (f.includes("package.json") || f.includes("tsconfig.json")) return false;
  if (f.includes("node_modules")) return false;

  const validNames = [
    "history", "conversation", "thread", "agent", "plan", "task",
    "walkthrough", "rules", ".cursorrules", ".mdc", "chat", "convo",
    "session", "run", "log", "settings", "config", "storage", "mcp",
    "bubbles", "aichat", "aiservice", "composer", ".jsonl",
  ];

  const pathOk = validNames.some((name) => f.includes(name));
  // Allow .jsonl files without additional path check
  if (!pathOk && !f.endsWith(".jsonl")) return false;

  // For JSON files, do a quick keyword check on header content (if provided)
  if (f.endsWith(".json") && headerContent) {
    const lower = headerContent.toLowerCase();
    const hasKeys = CHAT_KEYWORDS.some((k) => lower.includes(k));
    if (!hasKeys) return false;
  }

  return true;
}

// ─── Tool / Source Detection ──────────────────────────────────────────────────

/** Map from path-keyword → schema meta.source enum value (per §6.1) */
const TOOL_RULES = [
  // Must come before generic "code" checks
  ["roo-cline", "cline"],
  ["cline", "cline"],
  // Cursor before vscode (Cursor IS vscode-based)
  ["cursor", "cursor"],
  ["composer", "cursor"],
  // Claude
  ["claudecode", "claude_code"],
  ["claude", "claude_code"],
  // OpenAI / Codex
  ["openai", "codex"],
  ["codex", "codex"],
  ["opencode", "codex"],
  // Augment
  ["augment", "augment"],
  // Antigravity
  ["antigravity", "antigravity"],
  // iFlow
  ["iflow", "iflow"],
  // Trae Work before Trae — "trae" is a substring of every Trae Work path
  ["trae work", "traework"],
  ["trae-work", "traework"],
  ["traework", "traework"],
  ["trae", "trae"],
  // Forge (HaxiTAG) — specific path markers only
  ["forge-e2e", "forge"],
  [".forge-agents", "forge"],
  [".forge-config", "forge"],
  [".forge/works", "forge"],
  ["forge.app", "forge"],
  ["haxitag forge", "forge"],
  // WorkBuddy (Tencent, CodeBuddy work line) — before CodeBuddy
  ["workbuddy", "workbuddy"],
  // CodeBuddy
  ["codebuddy", "codebuddy"],
  // ZCode (Zhipu Z.ai Agent IDE) — before generic VS Code rules
  ["zcode", "zcode"],
  // Qoder / QCoder
  ["qoder", "qoder"],
  ["qcoder", "qoder"],
  ["qualcoder", "qoder"],
  // Kiro
  ["kiro", "kiro"],
  // Windsurf
  ["windsurf", "windsurf"],
  // VS Code Copilot
  ["vscode_copilot", "vscode_copilot"],
  // Generic: VS Code (after Cursor / Windsurf checks)
  ["code/user", "vscode_copilot"],
  [".vscode", "vscode_copilot"],
  // Zed
  ["zed", "zed"],
  // JetBrains
  ["jetbrains", "unknown"],
  // Aider
  ["aider", "unknown"],
];

/**
 * Detect the AI tool from a file path.
 * Returns a value in the §6.1 meta.source enum.
 */
export function detectTool(filePath) {
  const p = filePath.toLowerCase().replace(/\\/g, "/");
  for (const [keyword, source] of TOOL_RULES) {
    if (p.includes(keyword)) return source;
  }
  return "unknown";
}

// ─── IDE data directories (scan + vscdb share this list) ─────────────────────

/** Dot-home dirs and a few XDG session roots that are not `Application Support/<App>`. */
const IDE_DOT_DIRS = [
  ".codebuddy",
  ".config/codebuddy",
  ".workbuddy",
  ".config/workbuddy",
  ".zcode",
  ".config/zcode",
  ".trae",
  ".trae-work",
  ".traework",
  ".config/trae",
  ".config/Trae/User/workspaceStorage",
  ".config/Trae Work/User/workspaceStorage",
  ".config/Trae Work CN/User/workspaceStorage",
];

/** Products whose default data dir we scan for chat / session / log files. */
const NEW_IDE_APPS = [
  "CodeBuddy",
  "CodeBuddy CN",
  "WorkBuddy",
  "WorkBuddy CN",
  "ZCode",
  "Trae",
  "Trae CN",
  "Trae Work",
  "Trae Work CN",
];

/** VS Code-family apps whose workspaceStorage may hold state.vscdb. */
const VSCDB_APPS = [
  "Cursor",
  "Code",
  "Code - Insiders",
  "Windsurf",
  "VSCodium",
  "Antigravity",
  "Qoder",
  ...NEW_IDE_APPS,
];

const APP_DATA_SUBS = ["User/History", "User/workspaceStorage", "User/globalStorage"];

function appDataRelative(platform, app, sub) {
  if (platform === "win32") return path.join("AppData", "Roaming", app, sub);
  if (platform === "linux") return path.join(".config", app, sub);
  return path.join("Library", "Application Support", app, sub);
}

/**
 * Home-relative directories to scan for CodeBuddy / WorkBuddy / ZCode / Trae.
 * Existing Cursor / Claude / Codex patterns stay in scan.js; this list is additive.
 * @param {string} [platform]
 * @returns {string[]}
 */
export function ideScanRelativeDirs(platform = os.platform()) {
  const dirs = [...IDE_DOT_DIRS];
  for (const app of NEW_IDE_APPS) {
    for (const sub of APP_DATA_SUBS) dirs.push(appDataRelative(platform, app, sub));
  }
  // macOS also honors XDG-style ~/.config/<App> (portable / Linux-layout installs)
  if (platform === "darwin") {
    for (const app of NEW_IDE_APPS) {
      for (const sub of APP_DATA_SUBS) dirs.push(path.join(".config", app, sub));
    }
  }
  return [...new Set(dirs)];
}

/**
 * Absolute workspaceStorage roots that may contain *.vscdb.
 * @param {string} [platform]
 * @param {string} [home]
 * @param {string} [appData] Windows %APPDATA%
 * @returns {string[]}
 */
export function vscdbWorkspaceAbsPaths(
  platform = os.platform(),
  home = os.homedir(),
  appData = process.env.APPDATA,
) {
  const rels = [];
  for (const app of VSCDB_APPS) {
    if (platform === "win32") {
      rels.push(path.join(app, "User", "workspaceStorage"));
    } else if (platform === "linux") {
      rels.push(path.join(".config", app, "User", "workspaceStorage"));
    } else {
      rels.push(path.join("Library", "Application Support", app, "User", "workspaceStorage"));
      rels.push(path.join(".config", app, "User", "workspaceStorage"));
    }
  }
  if (platform === "win32") {
    const base = appData || path.join(home, "AppData", "Roaming");
    return [...new Set(rels.map((r) => path.join(base, r)))];
  }
  return [...new Set(rels.map((r) => path.join(home, r)))];
}

/**
 * Detect content type from magic bytes / first-char heuristics.
 * Used for files without a clear extension.
 */
export function detectByMagic(content) {
  if (!content || content.length === 0) return "unknown";
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{")) return "json";
  if (trimmed.startsWith("[")) return "json-array";
  if (trimmed.startsWith("---")) return "yaml-or-markdown";
  if (trimmed.startsWith("#")) return "markdown";
  // BOM
  if (content.startsWith("\uFEFF")) return "text-bom";
  return "text";
}
