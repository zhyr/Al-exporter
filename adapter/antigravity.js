import fs from "fs-extra";
import path from "node:path";

const CONFIG_DIR = path.join(process.cwd(), "agent-config");

/**
 * Save Unified Agent Schema into Antigravity's local configuration.
 */
export async function saveToAntigravity(uas) {
  await fs.ensureDir(CONFIG_DIR);

  const files = {
    "mcp_servers.json": uas.mcpServers,
    "skills.json": uas.skills,
    "memories.json": uas.memories,
    "context.json": uas.context,
    "agent_config.json": uas.agentConfig,
    "uas_bundle.json": uas // Full backup
  };

  const results = [];
  for (const [filename, data] of Object.entries(files)) {
    const filePath = path.join(CONFIG_DIR, filename);
    await fs.writeJson(filePath, data, { spaces: 2 });
    results.push(filePath);
  }

  return {
    success: true,
    configDir: CONFIG_DIR,
    filesSaved: results
  };
}

/**
 * Load intelligence from Antigravity's local configuration.
 */
export async function loadFromAntigravity() {
  const uasPath = path.join(CONFIG_DIR, "uas_bundle.json");
  if (await fs.pathExists(uasPath)) {
    return await fs.readJson(uasPath);
  }
  return null;
}
