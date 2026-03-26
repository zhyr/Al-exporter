import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { createEmptyUAS } from "./schema.js";

const GLOBAL_STORAGE_PATH = path.join(os.homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");

/**
 * Extract Cursor configuration, MCP, and Skills into Unified Agent Schema.
 */
export async function extractCursorConfig() {
  const uas = createEmptyUAS("cursor");
  
  if (!(await fs.pathExists(GLOBAL_STORAGE_PATH))) {
    console.warn("Cursor global storage not found at", GLOBAL_STORAGE_PATH);
    return uas;
  }

  let db;
  try {
    db = new Database(GLOBAL_STORAGE_PATH, { readonly: true, fileMustExist: true });
    
    // I. Extract MCP Settings
    const mcpRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("mcp.settings");
    if (mcpRow) {
      try {
        const mcpData = JSON.parse(mcpRow.value);
        if (mcpData && typeof mcpData === 'object') {
          uas.mcpServers = Object.entries(mcpData).map(([name, conf]) => ({
            name,
            provider: conf.type || 'stdio',
            command: conf.command,
            args: conf.args,
            env: conf.env,
            enabled: conf.enabled !== false
          }));
        }
      } catch (e) {
        console.error("Failed to parse mcp.settings", e);
      }
    }

    // II. Extract Skills / Tools
    // Cursor often stores custom tools in 'cursor.chat.tools' or similar
    const toolRows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE ?").all("cursor.chat.%");
    for (const row of toolRows) {
      if (row.key.includes("tools")) {
        try {
          const tools = JSON.parse(row.value);
          if (Array.isArray(tools)) {
            uas.skills.push(...tools.map(t => ({
              id: t.id || t.name,
              name: t.name,
              description: t.description,
              schema: t.parameters || t.schema
            })));
          }
        } catch {}
      }
    }

    // III. Extract Project Rules / Memory
    // Cursor stores global rules in 'cursor.chat.rules'
    const ruleRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursor.chat.rules");
    if (ruleRow) {
      uas.context.projectRules = ruleRow.value || "";
    }

    // IV. Extract Last Used Models
    const modelRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursor.chat.model");
    if (modelRow) {
      uas.agentConfig.model = modelRow.value || "";
    }

  } catch (err) {
    console.error("Cursor Adapter Error:", err);
  } finally {
    if (db) db.close();
  }

  return uas;
}
