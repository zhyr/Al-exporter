import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs-extra";

const home = os.homedir();
const globalDbPath = path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");

async function run() {
  if (!await fs.pathExists(globalDbPath)) {
    console.log("Global DB not found at:", globalDbPath);
    return;
  }

  const db = new Database(globalDbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE ? OR key LIKE ? OR key LIKE ?")
      .all("%mcp%", "%rule%", "%agent%");

    console.log(`Found ${rows.length} interesting keys:`);
    for (const row of rows) {
      console.log(`--- KEY: ${row.key} ---`);
      // console.log(row.value.toString().slice(0, 200));
    }
    
    // Specifically look for MCP servers
    const mcpRow = db.prepare("SELECT key, value FROM ItemTable WHERE key = ?").get("mcp.servers");
    if (mcpRow) {
      console.log("Found mcp.servers!");
      console.log(mcpRow.value.toString());
    }
  } catch (err) {
    console.error(err);
  } finally {
    db.close();
  }
}

run();
