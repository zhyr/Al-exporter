import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const SECRET_PATTERNS = [
  { type: "Password_Variable", regex: /(?:password|passwd|pwd|secret|key)\s*[:=]\s*["']([^"']{3,})["']/gi },
  { type: "JWT_Token", regex: /ey[a-zA-Z0-9_-]{10,}\.ey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
];

async function getAllFiles(dir) {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...(await getAllFiles(full)));
      else if (e.name.endsWith(".json")) files.push(full);
    }
  } catch {}
  return files;
}

export async function runSecretsCleanup(dataDir, onProgress) {
  if (onProgress) onProgress({ phase: 1, message: "Listing files..." });
  const filePaths = await getAllFiles(dataDir);
  
  const totalFiles = filePaths.length;
  const stats = {
    totalRecordsScanned: totalFiles,
    filesModified: 0,
    matches: {},
  };
  
  if (onProgress) onProgress({ phase: 2, message: "Scanning for secrets...", progress: 0 });

  const pLimit = limit(5);
  let totalProcessed = 0;

  await Promise.all(filePaths.map((filePath) => pLimit(async () => {
    try {
      const r = await fs.readJson(filePath);
      let modified = false;

      const scanAndReplace = (text) => {
        if (typeof text !== "string") return text;
        let newText = text;
        let textModified = false;
        for (const { type, regex } of SECRET_PATTERNS) {
          newText = newText.replace(regex, (match, group1) => {
            stats.matches[type] = (stats.matches[type] || 0) + 1;
            textModified = true;
            if (group1) {
              return match.replace(group1, "***PASSWORD_MASKED***");
            }
            return "***SECRET_MASKED***";
          });
        }
        if (textModified) modified = true;
        return newText;
      };

      if (r.meta?.prompt) r.meta.prompt = scanAndReplace(r.meta.prompt);
      if (Array.isArray(r.messages)) {
        for (let i = 0; i < r.messages.length; i++) {
          if (r.messages[i].content) r.messages[i].content = scanAndReplace(r.messages[i].content);
        }
      }

      if (modified) {
        stats.filesModified++;
        await fs.writeJson(filePath, r, { spaces: 2 });
      }
    } catch { /* skip corrupted */ }

    totalProcessed++;
    if (onProgress && totalProcessed % 50 === 0) {
      onProgress({
        phase: 2, 
        message: `Scanning secrets...`, 
        progress: Math.round((totalProcessed / totalFiles) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "Secrets scan complete.", progress: 100 });
  return stats;
}
