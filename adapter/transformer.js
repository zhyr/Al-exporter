import { extractCursorConfig } from "./cursor.js";
import { extractClaudeConfig } from "./claude.js";
import { extractCodexConfig } from "./codex.js";
import { saveToAntigravity, loadFromAntigravity } from "./antigravity.js";

/**
 * Universal Transformer to map between different Agent UAS formats.
 */
export class AgentTransformer {
  static async extractFrom(agentType) {
    switch (agentType.toLowerCase()) {
      case "cursor": return await extractCursorConfig();
      case "claude": return await extractClaudeConfig();
      case "codex": return await extractCodexConfig();
      default: throw new Error(`Unsupported source agent: ${agentType}`);
    }
  }

  /**
   * Import config from any supported agent and save it to Antigravity format.
   */
  static async importToAntigravity(sourceAgent) {
    console.log(`Importing from ${sourceAgent} to Antigravity...`);
    const uas = await this.extractFrom(sourceAgent);
    return await saveToAntigravity(uas);
  }

  /**
   * Export Antigravity config to a specific agent's compatible structure.
   */
  static async exportTo(targetAgent) {
    console.log(`Exporting Antigravity to ${targetAgent} format...`);
    const uas = await loadFromAntigravity();
    if (!uas) throw new Error("No Antigravity config found to export.");
    
    if (targetAgent.toLowerCase() === "cursor") {
      return {
        "mcp.settings": uas.mcpServers.reduce((acc, s) => {
          acc[s.name] = { type: s.provider, command: s.command, args: s.args, env: s.env, enabled: s.enabled };
          return acc;
        }, {}),
        "cursor.chat.rules": uas.context.projectRules,
        "cursor.chat.model": uas.agentConfig.model,
        "cursor.chat.tools": uas.skills.map(s => ({ id: s.id, name: s.name, description: s.description, parameters: s.schema }))
      };
    }
    
    // For others, we provide the raw UAS for now as a "Universal Bundle"
    return uas;
  }
}

