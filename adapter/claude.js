import fs from "fs-extra";
import path from "node:os";
import os from "node:os";
import { createEmptyUAS } from "./schema.js";

const CLAUDE_CONFIG_PATH = os.homedir() + "/.claude-code-router/config.json";

/**
 * Extract Claude Code Router configuration.
 */
export async function extractClaudeConfig() {
  const uas = createEmptyUAS("claude");
  
  if (!(await fs.pathExists(CLAUDE_CONFIG_PATH))) {
    return uas;
  }

  try {
    const config = await fs.readJson(CLAUDE_CONFIG_PATH);
    
    // I. Extract Agent Config
    uas.agentConfig.model = config.OPENAI_MODEL || "";
    
    // II. Extract Memory/Context
    // Claude Code Router is mainly a proxy, context might be in project-specific files
    // But we can extract global project trust if needed.
    
    // III. Extract Skills/MCP
    // If the router supports MCP, we'd find it in plugins.
    // Assuming a standard MCP format or plugin list.
    if (config.Providers) {
       // Placeholder for provider mapping
    }

  } catch (err) {
    console.error("Claude Adapter Error:", err);
  }

  return uas;
}
