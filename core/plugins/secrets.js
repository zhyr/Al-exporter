import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const PATTERNS = [
  // JSON Web Tokens (ey...)
  { type: "JWT_Token", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  
  // Generic Hardcoded Passwords in variables via simple heuristic
  // e.g. password = "xxx", passwd: 'xxx', SECRET_KEY="xxx"
  { type: "Hardcoded_Secret_Var", regex: /\b(password|passwd|pwd|pass|secret|secret_key|api_key|token)\b\s*[:=]\s*['"](.*?)['"]/gi }
];

export async function runSecretsCleanup(dataDir, onProgress) {
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
  
  if (onProgress) onProgress({ phase: 2, message: "Scanning for hardcoded secrets...", progress: 0 });

  const pLimit = limit(10);

  await Promise.all(records.map((item) => pLimit(async () => {
    let modified = false;
    const r = item.data;
    
    const scanAndReplace = (text) => {
      if (typeof text !== "string") return text;
      let newText = text;
      let textModified = false;
      for (const { type, regex } of PATTERNS) {
        newText = newText.replace(regex, (match, prefix, secretValue) => {
          stats.matches[type] = (stats.matches[type] || 0) + 1;
          textModified = true;
          // For assignments, we retain the prefix such as `password = "` but replace the value.
          // For JWTs, `prefix` might be entirely the whole JWT matched by regex.
          if (type === "Hardcoded_Secret_Var" && typeof prefix === 'string' && typeof secretValue === 'string') {
            return match.replace(secretValue, "***SECRET_MASKED***");
          }
          return "***JWT_MASKED***";
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
