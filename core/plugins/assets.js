import fs from "fs-extra";
import path from "node:path";
import limit from "p-limit";

const PATTERNS = [
  // Database connection URIs (MySQL, Postgres, MongoDB, Redis, etc.)
  { type: "Database_URI", regex: /(?:mysql|mongodb(?:\+srv)?|postgres(?:ql)?|redis|amqp|influxdb):\/\/[^:\s]+:[^@\s]+@[^/\s]+(?:[\/\w\.-]+)?/gi },
  
  // Internal IPs
  { type: "Internal_IP", regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g },
  
  // RSA Private Keys and Certificates
  { type: "RSA_Key_Cert", regex: /-----BEGIN(?:\s[A-Z\s]+)?(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]+?-----END(?:\s[A-Z\s]+)?(?:PRIVATE KEY|CERTIFICATE)-----/g }
];

export async function runAssetsCleanup(dataDir, onProgress) {
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
  
  if (onProgress) onProgress({ phase: 2, message: "Scanning for corporate assets...", progress: 0 });

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
          return "***ASSET_MASKED***";
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
