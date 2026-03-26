import os from "os";
import path from "path";
import fs from "fs-extra";
import { glob } from "glob";
import pLimit from "p-limit";
import { isInterestingFile, safeReadHeader, detectByMagic } from "./utils.js";

const HOME = os.homedir();

// ─── Path patterns to scan (per-tool) ────────────────────────────────────────
const PATH_PATTERNS = [
  // Cursor
  "Library/Application Support/Cursor/User/workspaceStorage",
  "Library/Application Support/Cursor/User/globalStorage",
  "Library/Application Support/Cursor/User/History",
  ".cursor",
  ".config/Cursor",

  // Claude / Claude Code
  ".claude",
  ".claude.json",
  ".config/claude",
  "Library/Application Support/ClaudeCode",
  "Library/Application Support/Claude",
  ".claude/projects",

  // OpenCode / Codex
  ".opencode",
  ".config/opencode",
  ".local/share/opencode/storage",
  ".openai",
  ".codex",

  // Antigravity
  ".antigravity",
  ".gemini/antigravity",
  "Library/Application Support/Antigravity/User/History",
  "Library/Application Support/Antigravity/User/workspaceStorage",
  "Library/Application Support/Antigravity/User/globalStorage",

  // Kiro
  ".kiro",
  ".local/share/kiro-cli",
  "Library/Application Support/kiro/User/globalStorage/kiro.kiroagent",

  // iFlow
  ".iflow",
  ".config/iflow",
  ".iflow/projects",

  // Qoder
  ".qoder",
  ".qcoder",
  ".config/qoder",
  "Library/Application Support/Qoder/User/History",
  "Library/Application Support/Qoder/User/workspaceStorage",
  "Library/Application Support/Qoder/User/globalStorage",

  // CodeBuddy
  ".codebuddy",
  ".config/codebuddy",
  "Library/Application Support/CodeBuddy/User/History",
  "Library/Application Support/CodeBuddy/User/workspaceStorage",
  "Library/Application Support/CodeBuddy/User/globalStorage",
  "Library/Application Support/CodeBuddy CN/User/History",
  "Library/Application Support/CodeBuddy CN/User/workspaceStorage",
  "Library/Application Support/CodeBuddy CN/User/globalStorage",

  // Trae
  ".trae",
  ".config/trae",
  "Library/Application Support/Trae CN/User/History",
  "Library/Application Support/Trae CN/User/workspaceStorage",
  "Library/Application Support/Trae CN/User/globalStorage",

  // Augment
  ".augment",
  ".config/augment",
  "Library/Application Support/Augment",

  // Windsurf
  ".windsurf",
  ".config/windsurf",
  "Library/Application Support/Windsurf/User/workspaceStorage",
  ".codeium/windsurf",
  ".codeium/windsurf/memories",

  // Zed
  ".config/zed/conversations",
  ".local/share/zed/threads",

  // Aider
  ".aider.chat.history.md",

  // Generic agent paths
  ".config/Code/User/workspaceStorage",
  "Library/Application Support/Code/User/workspaceStorage",
  "Library/Application Support/Code/User/globalStorage",
  "Library/Application Support/Code - Insiders/User/workspaceStorage",
  "Library/Application Support/Code - Insiders/User/globalStorage",

  // Continue.dev / Gemini CLI
  ".continue",
  ".gemini",

  // Roo-Cline
  "Library/Application Support/Cursor/User/globalStorage/rooveterinaryinc.roo-cline/tasks",

  // GitHub Copilot
  ".github/copilot",
  "Library/Application Support/Copilot",
  ".config/Copilot",

  // Tabnine
  ".tabnine",
  ".tabnine-vals",
  ".config/Tabnine",

  // Amazon Q
  ".aws/amazonq",
  ".aws/codewhisperer",
  ".config/Amazon",

  // DeepSeek
  ".deepseek",
  ".config/deepseek",

  // 通义灵码
  ".tongyi",
  ".config/tongyi",
  "Library/Application Support/Tongyi",

  // 讯飞 iFlyCode
  ".iflycode",
  ".config/iflycode",

  // Fitten Code
  ".fitten",
  ".config/fitten",

  // Devin
  ".devin",
  ".config/devin",
  "Library/Application Support/Devin",

  // Replit
  ".replit",
  ".config/replit",
  ".local/share/replit",

  // Lovable / Bolt.new
  ".lovable",
  ".bolt",
  ".config/lovable",
  ".config/bolt",

  // v0
  ".v0",
  ".config/v0",

  // Mintlify
  ".mintlify",
  ".config/mintlify",

  // Safurai
  ".safurai",
  ".config/safurai",

  // Warp
  ".warp",
  ".config/warp",
  "Library/Application Support/Warp",
  "Library/Application Support/com.rdejong.warp-mcp",
];

const GLOB_EXTENSIONS = "**/*.{json,jsonl,md,txt,log,mdc,cursorrules,yaml,yml}";

const GLOB_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/resources/**",
  "**/static/**",
  "**/extensions/**",
  "**/*.tmlanguage",
  "**/*.l10n.json",
  "**/*.nls.json",
  "**/*.png",
  "**/*.jpg",
  "**/*.svg",
  "**/*.css",
  "**/*.node",
  "**/*.vsixmanifest",
  "**/*.crx",
  "**/*.asar",
  "**/package.json",
  "**/tsconfig*.json",
  "**/*.map",
];

// 需要深度扫描的目录
const DEEP_SCAN_PATTERNS = [
  ".cursor", ".claude", ".antigravity", ".gemini", ".augment",
  ".kiro", ".codex", ".opencode", ".qoder", ".codebuddy",
  ".trae", ".windsurf", ".iflow", ".continue", ".deepseek",
  ".tongyi", ".devin", ".replit"
];

/**
 * 获取目录的基础扫描深度
 */
function getBaseDepth(pattern) {
  if (pattern.includes("workspaceStorage") || pattern.includes("globalStorage")) {
    return 2;
  }
  return 3;
}

/**
 * 获取目录的最大扫描深度
 */
function getMaxDepth(pattern) {
  for (const deep of DEEP_SCAN_PATTERNS) {
    if (pattern.startsWith(deep)) return 10;
  }
  return 6;
}

/**
 * 扫描单个深度的文件
 */
async function scanAtDepth(fullRoot, depth, seenPaths) {
  try {
    const stat = await fs.stat(fullRoot);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  try {
    const files = await glob(GLOB_EXTENSIONS, {
      cwd: fullRoot,
      absolute: true,
      nodir: true,
      maxDepth: depth,
      ignore: GLOB_IGNORE,
    }).catch(() => []);

    const paths = [];
    for (const f of files) {
      if (!seenPaths.has(f)) {
        seenPaths.add(f);
        paths.push(f);
      }
    }
    return paths;
  } catch (err) {
    console.warn(`[scan] Skipping ${fullRoot}: ${err.message}`);
    return [];
  }
}

/**
 * 读取并过滤文件
 */
async function processFiles(filePaths, { workers = 8, maxFileSizeBytes = 10 * 1024 * 1024, onProgress = null }) {
  const limit = pLimit(workers);
  const results = [];
  let processed = 0;
  const total = filePaths.length;

  await Promise.all(
    filePaths.map((filePath) =>
      limit(async () => {
        try {
          const st = await fs.stat(filePath);
          processed++;
          if (onProgress) onProgress(processed, total, filePath);

          if (st.size > maxFileSizeBytes) return;

          const ext = path.extname(filePath).toLowerCase();
          let headerContent = null;
          if (ext === ".json" || ext === "") {
            headerContent = await safeReadHeader(filePath, 512);
            if (!headerContent) return;
            if (ext === "") {
              const magic = detectByMagic(headerContent);
              if (!magic.includes("json") && !magic.includes("markdown")) return;
            }
          }

          if (!isInterestingFile(filePath, headerContent)) return;

          const content = await fs.readFile(filePath, "utf-8").catch(() => null);
          if (!content || content.trim().length === 0) return;

          results.push({
            path: filePath,
            content,
            mtime: st.mtimeMs,
            size: st.size,
          });
        } catch {
          // skip unreadable files
        }
      })
    )
  );

  return results;
}

/**
 * 分段增量扫描 - 螺旋递增深度
 * @param {object} opts
 * @param {number} [opts.workers=8]
 * @param {number} [opts.maxFileSizeBytes=10*1024*1024]
 * @param {string[]} [opts.extraPatterns]
 * @param {Function} [opts.onProgress] - 每次扫描完成回调 (phase, depth, found, total)
 * @param {Function} [opts.onChunk] - 每阶段完成回调 (records) - 可用于实时保存
 * @returns {Promise<Array>} 所有扫描到的文件
 */
export async function scanAllToolsIncremental({
  workers = 8,
  maxFileSizeBytes = 10 * 1024 * 1024,
  extraPatterns = [],
  onProgress = null,
  onChunk = null,
} = {}) {
  const patterns = [...PATH_PATTERNS, ...extraPatterns];
  const allResults = [];
  const seenPaths = new Set();

  // 螺旋深度序列: 4, 6, 8, 10
  const depths = [4, 6, 8, 10];
  
  for (let i = 0; i < depths.length; i++) {
    const depth = depths[i];
    const phase = i + 1;
    
    if (onProgress) onProgress(phase, depth, 0, 0, "Starting...");

    // 并行扫描所有目录的当前深度
    const allPathsAtDepth = [];
    
    await Promise.all(
      patterns.map(async (pattern) => {
        const fullRoot = path.join(HOME, pattern);
        const baseDepth = getBaseDepth(pattern);
        const maxDepth = getMaxDepth(pattern);
        
        // 如果当前深度超过目录的最大深度，跳过
        if (depth > maxDepth) return;
        
        const paths = await scanAtDepth(fullRoot, depth, seenPaths);
        allPathsAtDepth.push(...paths);
      })
    );

    // 处理当前深度的文件
    if (allPathsAtDepth.length > 0) {
      if (onProgress) onProgress(phase, depth, 0, allPathsAtDepth.length, "Processing files...");
      
      const results = await processFiles(allPathsAtDepth, {
        workers,
        maxFileSizeBytes,
        onProgress: (done, total, p) => {
          if (onProgress) onProgress(phase, depth, done, total, `Scanning ${path.basename(p)}`);
        }
      });

      allResults.push(...results);
      
      // 实时回调已处理的记录
      if (onChunk && results.length > 0) {
        onChunk(results, { phase, depth, totalFound: allResults.length });
      }
    }

    if (onProgress) onProgress(phase, depth, allResults.length, allPathsAtDepth.length, "Phase complete");
  }

  return allResults;
}

/**
 * 传统一次性扫描 (兼容旧接口)
 */
export async function scanAllTools({
  workers = 8,
  maxFileSizeBytes = 10 * 1024 * 1024,
  extraPatterns = [],
  onProgress = null,
} = {}) {
  // 使用增量扫描，一次性返回所有结果
  return scanAllToolsIncremental({
    workers,
    maxFileSizeBytes,
    extraPatterns,
    onProgress: onProgress ? (phase, depth, found, total, msg) => {
      // 转换旧格式的回调
      onProgress(found, total, msg || "");
    } : null,
  });
}