import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const MAX_LEN = 3000;

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

export async function runPruneCleanup(dataDir, onProgress) {
  if (onProgress) onProgress({ phase: 1, message: "Listing files..." });
  const filePaths = await getAllFiles(dataDir);
  
  const totalFiles = filePaths.length;
  const stats = {
    totalRecordsScanned: totalFiles,
    filesModified: 0,
    matches: { "Truncated_Messages": 0 },
  };
  
  if (onProgress) onProgress({ phase: 2, message: "Pruning long messages...", progress: 0 });

  const pLimit = limit(5);
  let totalProcessed = 0;

  await Promise.all(filePaths.map((filePath) => pLimit(async () => {
    try {
      const r = await fs.readJson(filePath);
      let modified = false;

      const pruneText = (text) => {
        if (typeof text !== "string" || text.length <= MAX_LEN) return text;
        const half = Math.floor(MAX_LEN / 2);
        stats.matches["Truncated_Messages"]++;
        modified = true;
        return text.slice(0, half) + "\n\n...[TRUNCATED BY PRUNE PLUGIN]...\n\n" + text.slice(-half);
      };

      if (Array.isArray(r.messages)) {
        for (let i = 0; i < r.messages.length; i++) {
          if (r.messages[i].content) {
            r.messages[i].content = pruneText(r.messages[i].content);
          }
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
        message: `Pruning files...`, 
        progress: Math.round((totalProcessed / totalFiles) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "Pruning complete.", progress: 100 });
  return stats;
}
