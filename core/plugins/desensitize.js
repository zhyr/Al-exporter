import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const PATTERNS = [
  { type: "Baidu_AccessKey", regex: /bce-v3\/[A-Za-z0-9\/]+/g },
  { type: "Baidu_ALTAK", regex: /ALTAK-[A-Za-z0-9]+/g },
  { type: "OpenAI_Key", regex: /sk-[a-zA-Z0-9]{32,}/g },
  { type: "Anthropic_Key", regex: /sk-ant-api03-[A-Za-z0-9_-]+/g },
  { type: "GitHub_Token", regex: /ghp_[A-Za-z0-9]{36}/g },
  { type: "GitHub_OAuth", regex: /gho_[A-Za-z0-9]{36}/g },
  { type: "AWS_AccessKey", regex: /(?<![A-Z0-9])(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g },
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

export async function runDesensitize(dataDir, onProgress) {
  if (onProgress) onProgress({ phase: 1, message: "Listing files..." });
  const filePaths = await getAllFiles(dataDir);
  
  const totalFiles = filePaths.length;
  const stats = {
    totalRecordsScanned: totalFiles,
    filesModified: 0,
    matches: {},
  };
  
  if (onProgress) onProgress({ phase: 2, message: "Scanning for sensitive data...", progress: 0 });

  const pLimit = limit(5); // Low concurrency to stay safe on memory
  let totalProcessed = 0;

  await Promise.all(filePaths.map((filePath) => pLimit(async () => {
    try {
      const r = await fs.readJson(filePath);
      let modified = false;

      const scanAndReplace = (text) => {
        if (typeof text !== "string") return text;
        let newText = text;
        let textModified = false;
        for (const { type, regex } of PATTERNS) {
          newText = newText.replace(regex, () => {
            stats.matches[type] = (stats.matches[type] || 0) + 1;
            textModified = true;
            return "***MASKED***";
          });
        }
        if (textModified) modified = true;
        return newText;
      };

      if (r.meta?.prompt) r.meta.prompt = scanAndReplace(r.meta.prompt);
      if (r.meta?.file_path) r.meta.file_path = scanAndReplace(r.meta.file_path);
      if (Array.isArray(r.messages)) {
        for (let i = 0; i < r.messages.length; i++) {
          if (r.messages[i].content) r.messages[i].content = scanAndReplace(r.messages[i].content);
        }
      }

      if (modified) {
        stats.filesModified++;
        await fs.writeJson(filePath, r, { spaces: 2 });
      }
    } catch { /* skip corrupted files */ }

    totalProcessed++;
    if (onProgress && totalProcessed % 50 === 0) {
      onProgress({
        phase: 2, 
        message: `Scanning files...`, 
        progress: Math.round((totalProcessed / totalFiles) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "Scan complete.", progress: 100 });
  return stats;
}
