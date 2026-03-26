import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

// Common AI conversational fluff that often precedes or follows actual useful answers
const FLUFF_PATTERNS = [
  { type: "Start_Fluff", regex: /^(好的|没问题|收到|我明白了|当然可以|Certainly|Sure|Ok|Of course|I understand)[，,。!！\s\n]+(我马上给您|我这就结合|I can help|Here is the code|Let me help you with that|Here is a revised version|Here is an updated version|Here is the).{0,60}\n/gi },
  { type: "End_Fluff", regex: /\n(希望这|如果还有其他问题|如果有任何疑问|Let me know if you need anything else|I hope this helps|If you have any further questions|Feel free to).{0,100}$/gi }
];

export async function runChitchatCleanup(dataDir, onProgress) {
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
    matches: {},
  };
  
  if (onProgress) onProgress({ phase: 2, message: "Removing conversational fluff...", progress: 0 });

  const pLimit = limit(10);

  await Promise.all(records.map((item) => pLimit(async () => {
    let modified = false;
    const r = item.data;
    
    // We only clean assistant replies
    if (Array.isArray(r.messages)) {
      for (let i = 0; i < r.messages.length; i++) {
        if (r.messages[i].role === 'assistant' && typeof r.messages[i].content === 'string') {
          let oldText = r.messages[i].content;
          let newText = oldText;
          
          for (const { type, regex } of FLUFF_PATTERNS) {
            newText = newText.replace(regex, () => {
              stats.matches[type] = (stats.matches[type] || 0) + 1;
              return "";
            });
          }
          
          if (newText !== oldText) {
            r.messages[i].content = newText.trim();
            modified = true;
          }
        }
      }
    }

    if (modified) {
      stats.filesModified++;
      await fs.writeFile(item.path, JSON.stringify(r, null, 2));
    }

    totalProcessed++;
    if (onProgress && totalProcessed % 50 === 0) {
      onProgress({
        phase: 2, 
        message: `Cleaning files...`, 
        progress: Math.round((totalProcessed / totalRecordsFound) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "Cleanup complete.", progress: 100 });

  return stats;
}
