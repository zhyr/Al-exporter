import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const ASSET_PATTERNS = [
  { type: "DB_URI", regex: /(?:mysql|postgresql|mongodb|redis|mssql):\/\/[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+(?::\d+)?\/[a-zA-Z0-9_.-]*/g },
  { type: "Internal_IP", regex: /(?<!\d)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\d)/g },
  { type: "RSA_Private_Key", regex: /-----BEGIN RSA PRIVATE KEY-----[\s\S]+?-----END RSA PRIVATE KEY-----/g },
  { type: "Certificate", regex: /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g },
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

export async function runAssetsCleanup(dataDir, onProgress) {
  if (onProgress) onProgress({ phase: 1, message: "Listing files..." });
  const filePaths = await getAllFiles(dataDir);
  
  const totalFiles = filePaths.length;
  const stats = {
    totalRecordsScanned: totalFiles,
    filesModified: 0,
    matches: {},
  };
  
  if (onProgress) onProgress({ phase: 2, message: "Scanning for corporate assets...", progress: 0 });

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
        for (const { type, regex } of ASSET_PATTERNS) {
          newText = newText.replace(regex, () => {
            stats.matches[type] = (stats.matches[type] || 0) + 1;
            textModified = true;
            return `***ASSET_MASKED***`;
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
        message: `Processing assets...`, 
        progress: Math.round((totalProcessed / totalFiles) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "Assets cleanup complete.", progress: 100 });
  return stats;
}
