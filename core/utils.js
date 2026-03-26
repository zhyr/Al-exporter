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
  // Trae
  ["trae", "trae"],
  // CodeBuddy
  ["codebuddy", "codebuddy"],
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
