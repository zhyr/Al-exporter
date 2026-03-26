import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const PATTERNS = [
  // Baidu Cloud Access Key & ALTAK
  { type: "Baidu_AccessKey", regex: /bce-v3\/[A-Za-z0-9\/]+/g },
  { type: "Baidu_ALTAK", regex: /ALTAK-[A-Za-z0-9]+/g },
  
  // OpenAI API Key
  { type: "OpenAI_Key", regex: /sk-[a-zA-Z0-9]{32,}/g },
  
  // Anthropic API Key
  { type: "Anthropic_Key", regex: /sk-ant-api03-[A-Za-z0-9_-]+/g },
  
  // GitHub Tokens
  { type: "GitHub_Token", regex: /ghp_[A-Za-z0-9]{36}/g },
  { type: "GitHub_OAuth", regex: /gho_[A-Za-z0-9]{36}/g },
  
  // AWS Access Key ID
  { type: "AWS_AccessKey", regex: /(?<![A-Z0-9])(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g },
];

export async function runDesensitize(dataDir, onProgress) {
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
          } catch { /* continue on read err */ }
        }
      }
    } catch { /* continue if dataDir doesn't exist */ }
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
  
  if (onProgress) onProgress({ phase: 2, message: "Scanning for sensitive data...", progress: 0 });

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
          return "***MASKED***";
        });
      }
      if (textModified) modified = true;
      return newText;
    };

    if (r.meta?.prompt) {
      r.meta.prompt = scanAndReplace(r.meta.prompt);
    }
    
    if (r.meta?.file_path) {
      // Unlikely, but just in case path contains tokens.
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
