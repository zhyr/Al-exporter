import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const FLUFF_PATTERNS = [
  /^Sure, I can help you with that\.?\s*/i,
  /^Certainly, here is the corrected code:?\s*/i,
  /^好的，我马上为您[生成|处理].*?\s*/,
  /^没问题，这是为您准备的.*?\s*/,
  /^希望这些信息对你有帮助.*?\s*$/m,
  /^If you have any more questions, feel free to ask!\s*$/m,
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

export async function runChitchatCleanup(dataDir, onProgress) {
  if (onProgress) onProgress({ phase: 1, message: "Listing files..." });
  const filePaths = await getAllFiles(dataDir);
  
  const totalFiles = filePaths.length;
  const stats = {
    totalRecordsScanned: totalFiles,
    filesModified: 0,
    matches: { "Fluff_Removed": 0 },
  };
  
  if (onProgress) onProgress({ phase: 2, message: "Filtering AI fluff...", progress: 0 });

  const pLimit = limit(5);
  let totalProcessed = 0;

  await Promise.all(filePaths.map((filePath) => pLimit(async () => {
    try {
      const r = await fs.readJson(filePath);
      let modified = false;

      if (Array.isArray(r.messages)) {
        for (let i = 0; i < r.messages.length; i++) {
          const m = r.messages[i];
          if (m.role === "assistant" && typeof m.content === "string") {
            let newContent = m.content;
            for (const pattern of FLUFF_PATTERNS) {
              const prevLen = newContent.length;
              newContent = newContent.replace(pattern, "").trim();
              if (newContent.length !== prevLen) {
                stats.matches["Fluff_Removed"]++;
                modified = true;
              }
            }
            m.content = newContent;
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
        message: `Filtering fluff...`, 
        progress: Math.round((totalProcessed / totalFiles) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "Chitchat filtering complete.", progress: 100 });
  return stats;
}
