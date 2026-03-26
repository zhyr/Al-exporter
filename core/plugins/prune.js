import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

// Maximum length of a single message allowed
const MAX_CONTEXT_LENGTH = 3000;

export async function runPruneCleanup(dataDir, onProgress) {
  const records = [];
  
  const walk = async (dir) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".json")) {
          try {
            records.push({ path: full, data: await fs.readJson(full) });
          } catch { /* skip read error */ }
        }
      }
    } catch { /* skip missing dir */ }
  };
  
  if (onProgress) onProgress({ phase: 1, message: "Loading records..." });
  await walk(dataDir);
  
  let totalProcessed = 0;
  const totalRecordsFound = records.length;
  
  const stats = {
    totalRecordsScanned: totalRecordsFound,
    filesModified: 0,
    matches: { Long_Context_Truncated: 0 },
  };
  
  if (onProgress) onProgress({ phase: 2, message: "Pruning long contexts...", progress: 0 });

  const pLimit = limit(10);

  await Promise.all(records.map((item) => pLimit(async () => {
    let modified = false;
    const r = item.data;
    
    const scanAndReplace = (text) => {
      if (typeof text !== "string") return text;
      
      if (text.length > MAX_CONTEXT_LENGTH) {
        stats.matches.Long_Context_Truncated++;
        modified = true;
        
        // Retain beginning and end to preserve conversational context while removing the huge middle log chunks.
        const chunkLength = Math.floor((MAX_CONTEXT_LENGTH - 100) / 2);
        const start = text.substring(0, chunkLength);
        const end = text.substring(text.length - chunkLength);
        const diff = text.length - (chunkLength * 2);
        
        return `${start}\n\n...[TRUNCATED ${diff} CHARS OF LONG CONTEXT/STACKTRACE]...\n\n${end}`;
      }
      return text;
    };

    if (r.meta?.prompt) r.meta.prompt = scanAndReplace(r.meta.prompt);
    if (Array.isArray(r.messages)) {
      for (let i = 0; i < r.messages.length; i++) {
        if (r.messages[i].content) r.messages[i].content = scanAndReplace(r.messages[i].content);
      }
    }

    if (modified) {
      stats.filesModified++;
      // Since pruning reduces file volume drastically, recalculate tokens approximately if meta.tokens exists maybe. Keep it simple.
      await fs.writeFile(item.path, JSON.stringify(r, null, 2));
    }

    totalProcessed++;
    if (onProgress && totalProcessed % 50 === 0) {
      onProgress({
        phase: 2, 
        message: `Pruning files...`, 
        progress: Math.round((totalProcessed / totalRecordsFound) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "Prune complete.", progress: 100 });

  return stats;
}
