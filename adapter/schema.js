/**
 * Unified Agent Schema (UAS)
 * Intermediary format for converting between different AI coding agents.
 */

export const UAS_VERSION = "1.0.0";

export function createEmptyUAS(origin = "unknown") {
  return {
    version: UAS_VERSION,
    origin,
    timestamp: new Date().toISOString(),
    
    // Skills / Tools / Function Calls
    skills: [], 
    
    // MCP (Model Context Protocol) Servers
    mcpServers: [],
    
    // Long-term or Session Memories
    memories: [],
    
    // Active context (current files, project rules, etc.)
    context: {
      projectRules: "",
      preferredLanguage: "",
      ignoredPaths: [],
    },
    
    // Metadata about the agent itself
    agentConfig: {
      model: "",
      temperature: 0.7,
      systemPrompt: "",
    }
  };
}
