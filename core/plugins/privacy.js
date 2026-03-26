import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const PII_PATTERNS = [
  { type: "ID_Card", regex: /(?<!\d)(?:[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX])(?!\d)/g },
  { type: "Phone", regex: /(?<!\d)(?:1[3-9]\d{9})(?!\d)/g },
  { type: "Bank_Card", regex: /(?<!\d)(?:[1-9]\d{12,18})(?!\d)/g },
  { type: "Email", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
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

export async function runPrivacyCleanup(dataDir, onProgress) {
  if (onProgress) onProgress({ phase: 1, message: "Listing files..." });
  const filePaths = await getAllFiles(dataDir);
  
  const totalFiles = filePaths.length;
  const stats = {
    totalRecordsScanned: totalFiles,
    filesModified: 0,
    matches: {},
  };
  
  if (onProgress) onProgress({ phase: 2, message: "Scanning for PII...", progress: 0 });

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
        for (const { type, regex } of PII_PATTERNS) {
          newText = newText.replace(regex, () => {
            stats.matches[type] = (stats.matches[type] || 0) + 1;
            textModified = true;
            return `***PII_MASKED***`;
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
        message: `Processing PII...`, 
        progress: Math.round((totalProcessed / totalFiles) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "PII cleanup complete.", progress: 100 });
  return stats;
}
