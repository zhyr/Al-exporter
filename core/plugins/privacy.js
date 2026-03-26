import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const PATTERNS = [
  // Phone numbers (Mainland China: 11 digits, starts with 13-19)
  { type: "Phone_Number", regex: /\b1[3-9]\d{9}\b/g },
  
  // Chinese ID Cards (18 digits with region, year/month/day validation)
  { type: "ID_Card", regex: /\b(?:1[1-5]|2[1-3]|3[1-7]|4[1-6]|5[0-4]|6[1-5]|7[1]|8[1-2])\d{4}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX]\b/gi },
  
  // Bank Cards (16-19 digits starting with 1-9)
  { type: "Bank_Card", regex: /\b[1-9]\d{15,18}\b/g },
  
  // Emails
  { type: "Email", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g }
];

export async function runPrivacyCleanup(dataDir, onProgress) {
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
  
  if (onProgress) onProgress({ phase: 2, message: "Scanning for PII data...", progress: 0 });

  const pLimit = limit(10);

  await Promise.all(records.map((item) => pLimit(async () => {
    let modified = false;
    const r = item.data;
    
    const scanAndReplace = (text) => {
      if (typeof text !== "string") return text;
      let newText = text;
      let textModified = false;
      for (const { type, regex } of PATTERNS) {
        newText = newText.replace(regex, () => {
          stats.matches[type] = (stats.matches[type] || 0) + 1;
          textModified = true;
          return "***PII_MASKED***";
        });
      }
      if (textModified) modified = true;
      return newText;
    };

    if (r.meta?.prompt) {
      r.meta.prompt = scanAndReplace(r.meta.prompt);
    }
    
    if (r.meta?.file_path) {
      r.meta.file_path = scanAndReplace(r.meta.file_path);
    }
    
    if (Array.isArray(r.messages)) {
      for (let i = 0; i < r.messages.length; i++) {
        if (r.messages[i].content) {
          r.messages[i].content = scanAndReplace(r.messages[i].content);
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
        message: `Scanning files...`, 
        progress: Math.round((totalProcessed / totalRecordsFound) * 100),
      });
    }
  })));

  if (onProgress) onProgress({ phase: 3, message: "Scan complete.", progress: 100 });

  return stats;
}
