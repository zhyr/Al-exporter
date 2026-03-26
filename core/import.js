/**
 * Import records to agent directories in native formats.
 * This is the reverse of scan: taking data and writing it back to agent directories.
 */

import os from "os";
import path from "path";
import crypto from "crypto";

const HOME = os.homedir();

// Agent directory mappings - where each agent stores conversation data
const AGENT_PATHS = {
  cursor: [
    "Library/Application Support/Cursor/User/workspaceStorage",
    "Library/Application Support/Cursor/User/History",
    ".cursor",
  ],
  codex: [
    ".codex",
    ".opencode",
    ".local/share/opencode/storage",
  ],
  claude_code: [
    ".claude",
    ".claude/projects",
    "Library/Application Support/ClaudeCode",
  ],
  antigravity: [
    ".antigravity",
    "Library/Application Support/Antigravity/User/History",
    "Library/Application Support/Antigravity/User/workspaceStorage",
  ],
  cline: [
    "Library/Application Support/Cursor/User/globalStorage/rooveterinaryinc.roo-cline",
    ".continue",
  ],
  windsurf: [
    ".windsurf",
    ".codeium/windsurf",
    "Library/Application Support/Windsurf/User/workspaceStorage",
  ],
  codebuddy: [
    ".codebuddy",
    "Library/Application Support/CodeBuddy/User/History",
    "Library/Application Support/CodeBuddy/User/workspaceStorage",
  ],
  qoder: [
    ".qoder",
    ".qcoder",
    "Library/Application Support/Qoder/User/History",
  ],
  trae: [
    ".trae",
    "Library/Application Support/Trae CN/User/History",
  ],
  kiro: [
    ".kiro",
    "Library/Application Support/kiro/User/globalStorage/kiro.kiroagent",
  ],
  iflow: [
    ".iflow",
    ".iflow/projects",
  ],
  zed: [
    ".config/zed/conversations",
    ".local/share/zed/threads",
  ],
  augment: [
    ".augment",
    "Library/Application Support/Augment",
  ],
};

/**
 * Get all possible directories for an agent
 * @param {string} source - Agent source name (e.g., "cursor", "codex")
 * @returns {string[]} Array of absolute paths
 */
export function getAgentDirs(source) {
  const patterns = AGENT_PATHS[source] || [];
  return patterns.map(p => path.join(HOME, p));
}

/**
 * Get the best (first existing) directory for an agent
 * @param {string} source - Agent source name
 * @returns {string|null} Absolute path or null if none exist
 */
export async function getBestAgentDir(source) {
  const dirs = getAgentDirs(source);
  const fs = await import('node:fs/promises');
  
  for (const dir of dirs) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch { /* doesn't exist */ }
  }
  
  // Return first path as fallback (will be created)
  return dirs[0] || null;
}

/**
 * Import records to an agent directory in native format
 * @param {object[]} records - Records to import
 * @param {string} source - Target agent source
 * @returns {Promise<{success: number, failed: number, paths: string[]}>}
 */
export async function importToAgent(records, source) {
  const results = { success: 0, failed: 0, paths: [] };
  const targetDir = await getBestAgentDir(source);
  
  if (!targetDir) {
    throw new Error(`No known directory for agent: ${source}`);
  }

  const fs = await import('node:fs/promises');
  
  // Create a subdirectory for imported data
  const importDir = path.join(targetDir, "imported-" + Date.now());
  await fs.mkdir(importDir, { recursive: true });

  // Convert record to agent-native format
  const nativeData = convertToNativeFormat(records, source);
  
  // Write in appropriate format for the agent
  for (const [filename, content] of Object.entries(nativeData)) {
    const filePath = path.join(importDir, filename);
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      results.success++;
      results.paths.push(filePath);
    } catch (err) {
      results.failed++;
      console.error(`Failed to write ${filePath}:`, err.message);
    }
  }

  return results;
}

/**
 * Convert unified records to agent-native format
 * @param {object[]} records
 * @param {string} source
 * @returns {object} Filename -> content mapping
 */
function convertToNativeFormat(records, source) {
  const output = {};
  
  if (source === 'cursor') {
    // Cursor uses JSON with tabs/bubbles structure
    output['sessions.json'] = JSON.stringify(records.map(r => ({
      id: r.thread_id,
      created: r.meta?.created_at,
      messages: r.messages?.map(m => ({
        type: m.role === 'assistant' ? 'ai' : 'human',
        rawText: m.content,
        timingInfo: { clientStartTime: m.timestamp }
      })) || []
    })), null, 2);
  } 
  else if (source === 'codex' || source === 'claude_code') {
    // Codex/Claude use JSONL format
    for (const r of records) {
      for (const m of r.messages || []) {
        const line = {
          type: m.role === 'assistant' ? 'response_item' : 'input_text',
          timestamp: m.timestamp || r.meta?.created_at,
          payload: {
            type: 'message',
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
          }
        };
        const hash = crypto.createHash('md5').update(m.content || '').digest('hex').slice(0, 8);
        output[`session-${hash}.jsonl`] = JSON.stringify(line);
      }
    }
  }
  else if (source === 'antigravity') {
    // Antigravity uses markdown with YAML frontmatter
    for (const r of records) {
      const md = [
        '---',
        `name: ${r.meta?.prompt || r.thread_id}`,
        `source: ${r.meta?.source}`,
        `created: ${r.meta?.created_at}`,
        '---',
        '',
        ...(r.messages?.map(m => `## ${m.role}\n\n${m.content}`) || [])
      ].join('\n');
      const hash = crypto.createHash('md5').update(r.thread_id || '').digest('hex').slice(0, 8);
      output[`session-${hash}.md`] = md;
    }
  }
  else if (source === 'cline') {
    // Cline/Continue uses JSONL
    for (const r of records) {
      const line = {
        id: r.thread_id,
        timestamp: r.meta?.created_at,
        messages: r.messages
      };
      const hash = crypto.createHash('md5').update(r.thread_id || '').digest('hex').slice(0, 8);
      output[`conversation-${hash}.jsonl`] = JSON.stringify(line);
    }
  }
  else if (source === 'windsurf') {
    // Windsurf uses JSON with conversations array
    output['conversations.json'] = JSON.stringify(records.map(r => ({
      id: r.thread_id,
      title: r.meta?.prompt,
      messages: r.messages
    })), null, 2);
  }
  else if (source === 'codebuddy') {
    // CodeBuddy uses JSONL
    for (const r of records) {
      const line = {
        session_id: r.thread_id,
        created: r.meta?.created_at,
        messages: r.messages
      };
      const hash = crypto.createHash('md5').update(r.thread_id || '').digest('hex').slice(0, 8);
      output[`session-${hash}.jsonl`] = JSON.stringify(line);
    }
  }
  else {
    // Default: JSON format
    output['imported-sessions.json'] = JSON.stringify(records, null, 2);
  }
  
  return output;
}

/**
 * List all supported agents
 * @returns {string[]}
 */
export function listSupportedAgents() {
  return Object.keys(AGENT_PATHS);
}