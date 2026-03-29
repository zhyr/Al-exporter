import path from "path";
import crypto from "crypto";
import { detectTool } from "./utils.js";

export const SCHEMA_VERSION = "1.0.0";

// Allowed meta.source values per §6.1
export const ALLOWED_SOURCES = new Set([
  "cursor", "antigravity", "codex", "augment", "claude_code",
  "iflow", "trae", "codebuddy", "qoder", "windsurf",
  "vscode_copilot", "imported", "api_capture", "unknown", "other",
  // Common local tooling IDs seen in paths / exports (kept explicit for UI + stats)
  "cline", "zed", "kiro",
]);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine artifact type from file path.
 * @returns {"plan"|"task"|"walkthrough"|"artifact"|"mcp"|"rule"|"config"|"thread"}
 */
export function identifyType(filePath) {
  const p = filePath.toLowerCase();
  const filename = path.basename(p);
  if (filename.includes("plan") || p.includes("/plan")) return "plan";
  if (filename.includes("task") || p.includes("/task")) return "task";
  if (filename.includes("walkthrough") || p.includes("/walkthrough")) return "walkthrough";
  if (filename.includes("artifact") || p.includes("/artifact")) return "artifact";
  if (filename.includes("mcp") || p.includes("/mcp") || filename === "mcp.json") return "mcp";
  if (filename.includes("rule") || p.includes("/rules") || p.endsWith(".mdc") || p.endsWith(".cursorrules")) return "rule";
  if (filename.includes("agent") || p.includes("/agent") || filename.endsWith("agent.md")) return "agent";
  if (filename.includes("settings") || filename.includes("config") || filename.includes("storage")) return "config";
  return "thread";
}

/**
 * Normalize a raw meta.source string into an allowed §6.1 enum value.
 */
export function normalizeMetaSource(rawSource) {
  const s = String(rawSource || "unknown").toLowerCase().trim();
  const ALIASES = {
    cursor: "cursor", claude: "claude_code", claude_code: "claude_code",
    codex: "codex", openai: "codex", opencode: "codex",
    qcoder: "qoder", qoder: "qoder", qualcoder: "qoder",
    vscode: "vscode_copilot", "vscode_copilot": "vscode_copilot",
    mcp: "other", jetbrains: "unknown", aider: "unknown",
    // Keep these explicit (they appear in real-world paths / UI filters)
    zed: "zed",
    cline: "cline",
    "roo-cline": "cline",
  };
  const resolved = ALIASES[s] ?? s;
  return ALLOWED_SOURCES.has(resolved) ? resolved : "other";
}

/**
 * Normalize all raw scanned items into unified schema records.
 */
export function normalizeAll(rawList) {
  const all = [];
  for (const item of rawList) {
    const records = normalizeItem(item);
    all.push(...records);
  }
  return all;
}

// ─── Per-item normalization ────────────────────────────────────────────────────

function makeId(filePath) {
  return crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16);
}

function normalizeItem(item) {
  const type = identifyType(item.path);
  const toolSource = normalizeMetaSource(detectTool(item.path));
  const ext = path.extname(item.path).toLowerCase();

  const { messages, context, prompt, confidence, warnings } = extractContent(
    item.content,
    item.path,
    ext
  );

  // If no messages at all, still emit a config/rule entry to not lose data
  if (messages.length === 0 && !["thread", "plan", "task", "walkthrough", "artifact"].includes(type)) {
    // Config/rule: emit as single system message
    const tokens = estimateTokens(item.content);
    return [buildRecord({
      type, toolSource, item, messages: [{ role: "system", content: item.content }],
      context: { files: [], diffs: [] }, prompt: path.basename(item.path),
      tokens, confidence: "low", warnings,
    })];
  }

  if (messages.length === 0 && !prompt) return [];

  const textContent = messages.map((m) => m.content || "").join("");
  const tokens = estimateTokens(textContent);

  // Check for potential issues and add health warnings
  const healthWarnings = [...warnings];
  const missingRole = messages.filter((m) => !m.role || m.role === "unknown").length;
  if (missingRole > 0) healthWarnings.push(`${missingRole} message(s) have missing/unknown role`);
  const emptyContent = messages.filter((m) => {
    if (!m.content) return true;
    if (typeof m.content !== "string") return false;
    return m.content.trim() === "";
  }).length;
  if (emptyContent > 0) healthWarnings.push(`${emptyContent} message(s) have empty content`);
  if (item.size > 1024 * 1024) healthWarnings.push(`Large file: ${(item.size / 1024 / 1024).toFixed(1)}MB`);

  return [buildRecord({ type, toolSource, item, messages, context, prompt, tokens, confidence, warnings: healthWarnings })];
}

function buildRecord({ type, toolSource, item, messages, context, prompt, tokens, confidence, warnings }) {
  const record = {
    schema_version: SCHEMA_VERSION,
    thread_id: makeId(item.path),
    type,
    messages,
    context: {
      files: context?.files || [],
      diffs: context?.diffs || [],
    },
    meta: {
      source: toolSource,
      project: inferProject(item.path),
      created_at: item.mtime ? new Date(item.mtime).toISOString() : new Date().toISOString(),
      updated_at: item.mtime ? new Date(item.mtime).toISOString() : new Date().toISOString(),
      file_path: item.path,
      tokens,
      prompt: prompt || path.basename(item.path, path.extname(item.path)),
      recognition_confidence: confidence,
    },
  };
  if (warnings.length > 0) record.meta.warnings = warnings;
  return record;
}

// ─── Project inference ────────────────────────────────────────────────────────

function inferProject(filePath) {
  const parts = filePath.replace(/\\/g, "/").split("/");
  // Common workspace parent keywords
  const WORKSPACE_PARENTS = ["work", "projects", "workspace", "repos", "dev", "src", "home"];
  const workIdx = parts.findIndex((p) => WORKSPACE_PARENTS.includes(p.toLowerCase()));
  if (workIdx >= 0 && parts[workIdx + 1]) return parts[workIdx + 1];
  // Fall back to grandparent directory
  return parts[Math.max(0, parts.length - 2)] || "unknown";
}

// ─── Token estimation ─────────────────────────────────────────────────────────

function estimateTokens(text = "") {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const latin = text.length - cjk;
  return Math.ceil(cjk + latin / 4);
}

// ─── Content extraction dispatcher ───────────────────────────────────────────

function extractContent(content, filePath, ext) {
  if (!content) return { messages: [], context: { files: [], diffs: [] }, prompt: null, confidence: "unknown", warnings: [] };
  if (ext === ".md" || ext === ".mdc" || ext === ".cursorrules") return extractFromMarkdown(content);
  if (ext === ".jsonl") return extractFromJsonl(content);
  if (ext === ".json" || ext === ".db" || ext === "" || ext === ".log") return extractFromJson(content);
  // Fallback: try JSON, then markdown
  const jsonResult = extractFromJson(content);
  if (jsonResult.messages.length > 0) return jsonResult;
  return extractFromMarkdown(content);
}

// ─── Markdown extractor ───────────────────────────────────────────────────────

function extractFromMarkdown(content) {
  const messages = [];
  const context = { files: [], diffs: [] };
  let prompt = null;
  const warnings = [];

  // Try YAML frontmatter
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (yamlMatch) {
    const nameMatch = yamlMatch[1].match(/name:\s*(.*)/);
    if (nameMatch) prompt = nameMatch[1].trim();
    const body = content.replace(yamlMatch[0], "").trim();
    if (body) messages.push({ role: "assistant", content: body });
    return { messages, context, prompt, confidence: "low", warnings };
  }

  // Try structured sections: ## User / ## Assistant / ## System
  const sectionRegex = /^#{1,3}\s*(User|Assistant|System|Human|AI|Bot)\s*$/gim;
  const sectionMatches = [...content.matchAll(sectionRegex)];

  if (sectionMatches.length >= 1) {
    for (let i = 0; i < sectionMatches.length; i++) {
      const match = sectionMatches[i];
      const rawRole = match[1].toLowerCase();
      const role = rawRole === "human" ? "user" : rawRole === "ai" || rawRole === "bot" ? "assistant" : rawRole;
      const start = match.index + match[0].length;
      const end = i + 1 < sectionMatches.length ? sectionMatches[i + 1].index : content.length;
      const text = content.slice(start, end).trim();
      if (text) messages.push({ role, content: text });
    }
    const firstUser = messages.find((m) => m.role === "user");
    if (firstUser) prompt = firstUser.content.slice(0, 120);
    return { messages, context, prompt, confidence: messages.length > 1 ? "high" : "low", warnings };
  }

  // Fallback: whole file as assistant message
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    prompt = lines[0].replace(/^#+\s*/, "").trim();
    messages.push({ role: "assistant", content });
  }
  return { messages, context, prompt, confidence: "low", warnings };
}

// ─── JSONL extractor ──────────────────────────────────────────────────────────

function extractFromJsonl(content) {
  const messages = [];
  const context = { files: [], diffs: [] };
  const warnings = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      
      // iFlow session format: { uuid, sessionId, type, message: { role, content } }
      if (parsed.sessionId && parsed.type && parsed.message && parsed.message?.role) {
        const msgContent = extractContentFromIMessage(parsed.message);
        messages.push({
          role: parsed.message.role === "assistant" ? "assistant" : "user",
          content: msgContent,
          ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {}),
        });
        continue;
      }
      
      if (parsed.role && (parsed.content !== undefined || parsed.text !== undefined)) {
        messages.push({ role: parsed.role, content: parsed.content ?? parsed.text ?? "" });
      } else if (Array.isArray(parsed.messages)) {
        for (const m of parsed.messages) {
          messages.push({ role: m.role || "unknown", content: m.content ?? m.text ?? "" });
        }
      } else if (parsed.instruction !== undefined) {
        // SFT format
        if (parsed.instruction) messages.push({ role: "user", content: parsed.instruction + (parsed.input ? `\n${parsed.input}` : "") });
        if (parsed.output) messages.push({ role: "assistant", content: parsed.output });
      } else if (parsed.type === "response_item" && parsed.payload?.content) {
        // Codex rollout format: { type: "response_item", payload: { type: "message", role: "user"/"assistant", content: [...] } }
        const payload = parsed.payload;
        if (payload.type === "message" && payload.content) {
          const textContent = Array.isArray(payload.content) 
            ? payload.content.map(c => c.text || "").join("")
            : payload.content;
          if (textContent) {
            messages.push({
              role: payload.role === "user" ? "user" : "assistant",
              content: textContent,
              ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
            });
          }
        }
      } else if (parsed.type === "function_call") {
        // Codex function call: { type: "function_call", name, arguments: "..." }
        if (parsed.name && parsed.arguments) {
          messages.push({
            role: "assistant",
            content: `[Function Call] ${parsed.name}(${parsed.arguments})`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "function_call_output") {
        // Codex function call output
        if (parsed.output !== undefined) {
          messages.push({
            role: "user",
            content: `[Function Output] ${parsed.output}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "custom_tool_call") {
        // Codex custom tool call
        if (parsed.name) {
          messages.push({
            role: "assistant",
            content: `[Tool Call] ${parsed.name}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "custom_tool_call_output") {
        // Codex custom tool output
        if (parsed.output) {
          messages.push({
            role: "user",
            content: `[Tool Output] ${parsed.output}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "reasoning" || parsed.type === "agent_reasoning") {
        // Codex reasoning/agent_reasoning
        if (parsed.content || parsed.reasoning) {
          messages.push({
            role: "assistant",
            content: `[Reasoning] ${parsed.content || parsed.reasoning || ""}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "summary_text") {
        // Codex summary text
        if (parsed.content) {
          messages.push({
            role: "assistant",
            content: `[Summary] ${parsed.content}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "event_msg" && parsed.payload) {
        // Codex event message
        const evtPayload = parsed.payload;
        if (evtPayload.type === "tool_use" && evtPayload.name) {
          messages.push({
            role: "assistant",
            content: `[Tool Use] ${evtPayload.name}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "session_meta" && parsed.payload) {
        // Codex session meta - 记录但不作为消息
      } else if (parsed.type === "input_text") {
        // Codex input text
        if (parsed.text) {
          messages.push({
            role: "user",
            content: parsed.text,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "canvas") {
        // Canvas content - rich structured content
        if (parsed.content || parsed.canvas_data) {
          const canvasContent = extractCanvasContent(parsed);
          if (canvasContent) {
            messages.push({
              role: "assistant",
              content: canvasContent,
              ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
            });
          }
        }
      } else if (parsed.type === "artifact") {
        // Artifact - generated code/UI artifacts
        if (parsed.artifact) {
          messages.push({
            role: "assistant",
            content: extractArtifactContent(parsed.artifact),
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "computer_call") {
        // Computer use / computer call
        if (parsed.name || parsed.action) {
          const action = parsed.name || parsed.action || 'computer_action';
          const details = parsed.input ? JSON.stringify(parsed.input, null, 2) : (parsed.arguments || '');
          messages.push({
            role: "assistant",
            content: `[Computer Action] ${action}\n${details}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "computer_call_output") {
        // Computer call output
        if (parsed.output !== undefined) {
          const outputStr = typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output, null, 2);
          messages.push({
            role: "user",
            content: `[Computer Output] ${outputStr}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "tool_use") {
        // Tool use (Anthropic format)
        if (parsed.name) {
          const toolInput = parsed.input ? JSON.stringify(parsed.input, null, 2) : (parsed.input || '');
          messages.push({
            role: "assistant",
            content: `[Tool Use] ${parsed.name}\n${toolInput}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "tool_result") {
        // Tool result (Anthropic format)
        if (parsed.content !== undefined || parsed.output !== undefined) {
          const resultContent = parsed.content || parsed.output || '';
          const isError = parsed.is_error || parsed.error;
          messages.push({
            role: "user",
            content: isError ? `[Tool Error] ${resultContent}` : `[Tool Result] ${resultContent}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "mcp_tool_call") {
        // MCP tool call
        if (parsed.tool || parsed.name) {
          const toolName = parsed.tool || parsed.name;
          const args = parsed.arguments ? JSON.stringify(parsed.arguments, null, 2) : (parsed.args || '');
          messages.push({
            role: "assistant",
            content: `[MCP Tool Call] ${toolName}\n${args}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "mcp_tool_result") {
        // MCP tool result
        if (parsed.result !== undefined) {
          const resultStr = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, null, 2);
          messages.push({
            role: "user",
            content: `[MCP Result] ${resultStr}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "attachment") {
        // Attachments (files, images)
        if (parsed.file || parsed.image_url || parsed.url) {
          const fileName = parsed.file || parsed.image_url || parsed.url;
          const fileType = parsed.type || 'file';
          messages.push({
            role: "user",
            content: `[Attachment: ${fileType}] ${fileName}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "image" || parsed.type === "image_url") {
        // Image content
        if (parsed.url || parsed.image_url) {
          const imageUrl = parsed.url || parsed.image_url;
          messages.push({
            role: "user",
            content: `[Image] ${imageUrl}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "code_execution") {
        // Code execution
        if (parsed.code !== undefined) {
          messages.push({
            role: "assistant",
            content: `[Code Execution]\n\`\`\`\n${parsed.code}\n\`\`\``,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
          if (parsed.output !== undefined) {
            messages.push({
              role: "user",
              content: `[Execution Output]\n${parsed.output}`,
              ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
            });
          }
        }
      } else if (parsed.type === "web_search" || parsed.type === "web_fetch") {
        // Web search/fetch
        if (parsed.query || parsed.url) {
          const query = parsed.query || parsed.url;
          const results = parsed.results || parsed.content || '';
          messages.push({
            role: "assistant",
            content: `[Web ${parsed.type === 'web_search' ? 'Search' : 'Fetch'}] ${query}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
          if (results) {
            messages.push({
              role: "user",
              content: `[Web Results]\n${results}`,
              ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
            });
          }
        }
      } else if (parsed.type === "thinking" || parsed.type === "internal_thought") {
        // Thinking/thoughts (internal reasoning)
        if (parsed.thinking || parsed.thought || parsed.content) {
          messages.push({
            role: "assistant",
            content: `[Thinking] ${parsed.thinking || parsed.thought || parsed.content}`,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "system") {
        // System message
        if (parsed.content) {
          messages.push({
            role: "system",
            content: parsed.content,
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "message_create" && parsed.message) {
        // Message create wrapper
        const msg = parsed.message;
        if (msg.role && msg.content) {
          messages.push({
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
          });
        }
      } else if (parsed.type === "response" && parsed.content) {
        // Response wrapper
        if (Array.isArray(parsed.content)) {
          for (const item of parsed.content) {
            const extracted = extractContentFromResponseItem(item);
            if (extracted) {
              messages.push({
                ...extracted,
                ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {})
              });
            }
          }
        }
      }
    } catch {
      warnings.push(`Skipped invalid JSONL line`);
    }
  }

  const firstUser = messages.find((m) => m.role === "user");
  const prompt = typeof firstUser?.content === "string" 
    ? firstUser.content.slice(0, 120) 
    : (firstUser?.content ? String(firstUser.content).slice(0, 120) : null);
  return { messages, context, prompt, confidence: messages.length > 0 ? "high" : "unknown", warnings };
}

// ─── JSON extractor with multi-schema detection ───────────────────────────────

/**
 * Detect which known JSON schema this parsed object matches.
 * Returns { schemaName, messages, context }
 */
function detectJsonSchema(parsed) {
  // 0. iFlow session JSONL format: { sessionId, type, message: { role, content } }
  if (parsed?.sessionId && parsed?.type && parsed?.message && parsed?.message?.role) {
    const messages = [{
      role: parsed.message.role === "assistant" ? "assistant" : "user",
      content: extractContentFromIMessage(parsed.message),
      ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {}),
    }];
    return { schemaName: "iflow-session", messages, context: { files: [], diffs: [] } };
  }

  // 1. Cursor tabs schema: { tabs: [{ bubbles: [{ type, rawText }] }] }
  if (Array.isArray(parsed?.tabs) && parsed.tabs[0]?.bubbles) {
    const messages = [];
    for (const tab of parsed.tabs) {
      for (const bubble of tab.bubbles || []) {
        messages.push({
          role: bubble.type === "ai" ? "assistant" : "user",
          content: bubble.rawText || bubble.text || bubble.content || "",
          ...(bubble.timingInfo?.clientStartTime ? { timestamp: bubble.timingInfo.clientStartTime } : {}),
        });
      }
    }
    return { schemaName: "cursor-tabs", messages, context: { files: [], diffs: [] } };
  }

  // 2. Cursor Composer schema: { composerData: { conversation: [...] } }
  if (parsed?.composerData?.conversation) {
    const conv = parsed.composerData.conversation;
    if (Array.isArray(conv)) {
      const messages = conv.map((m) => ({
        role: m.role || (m.type === "ai" ? "assistant" : "user"),
        content: typeof m.content === "string" ? m.content : (m.text || (m.content ? JSON.stringify(m.content) : "")),
        ...(m.timestamp ? { timestamp: m.timestamp } : {}),
      }));
      return { schemaName: "cursor-composer", messages, context: { files: [], diffs: [] } };
    }
  }

  // 3. OpenAI / standard messages array: { messages: [{ role, content }] }
  if (Array.isArray(parsed?.messages) && parsed.messages[0]?.role !== undefined) {
    const messages = parsed.messages.map((m) => ({
      role: m.role || "unknown",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ...(m.timestamp ? { timestamp: m.timestamp } : {}),
      ...(m.model ? { model: m.model } : {}),
    }));
    const context = {
      files: parsed.files || parsed.context?.files || [],
      diffs: parsed.diffs || parsed.context?.diffs || [],
    };
    return { schemaName: "openai-messages", messages, context };
  }

  // 4. Claude conversation schema: { conversation: [{ role, content }] } or { history: [...] }
  const claudeArray = parsed?.conversation || parsed?.history;
  if (Array.isArray(claudeArray) && claudeArray[0]?.role !== undefined) {
    const messages = claudeArray.map((m) => ({
      role: m.role || "unknown",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
    return { schemaName: "claude-conversation", messages, context: { files: [], diffs: [] } };
  }

  // 5. ShareGPT style: { conversations: [{ from, value }] }
  if (Array.isArray(parsed?.conversations) && parsed.conversations[0]?.from !== undefined) {
    const FROM_MAP = { human: "user", gpt: "assistant", system: "system" };
    const messages = parsed.conversations.map((c) => ({
      role: FROM_MAP[c.from] || c.from || "unknown",
      content: c.value || "",
    }));
    return { schemaName: "sharegpt", messages, context: { files: [], diffs: [] } };
  }

  // 6. Generic flat array of messages: [{ role, content }]
  if (Array.isArray(parsed) && parsed[0]?.role) {
    const messages = parsed.map((m) => ({
      role: m.role || "unknown",
      content: typeof m.content === "string" ? m.content : (m.text || (m.content ? JSON.stringify(m.content) : "")),
    }));
    return { schemaName: "flat-array", messages, context: { files: [], diffs: [] } };
  }

  // 7. Convo / threads fallback
  const fallbackArray = parsed?.convo || parsed?.threads;
  if (Array.isArray(fallbackArray) && fallbackArray.length > 0) {
    const messages = fallbackArray.flatMap((t) =>
      (t.messages || [t]).map((m) => ({
        role: m.role || "unknown",
        content: typeof m.content === "string" ? m.content : (m.text || (m.content ? JSON.stringify(m.content) : "")),
      }))
    );
    return { schemaName: "generic-convo", messages, context: { files: [], diffs: [] } };
  }

  return null;
}

function extractFromJson(content) {
  const warnings = [];
  try {
    const parsed = JSON.parse(content);
    const detected = detectJsonSchema(parsed);

    if (detected) {
      const { schemaName, messages, context } = detected;
      const firstUser = messages.find((m) => m.role === "user");
      const prompt = firstUser?.content?.slice(0, 120) ?? null;
      const confidence = ["cursor-tabs", "cursor-composer", "openai-messages", "claude-conversation", "sharegpt"].includes(schemaName) ? "high" : "low";
      return { messages, context, prompt, confidence, warnings };
    }

    // Config-like object (no messages found): emit as system message with low confidence
    if (typeof parsed === "object" && parsed !== null && Object.keys(parsed).length >= 2) {
      return {
        messages: [{ role: "system", content: JSON.stringify(parsed, null, 2) }],
        context: { files: [], diffs: [] },
        prompt: null,
        confidence: "low",
        warnings,
      };
    }

    return { messages: [], context: { files: [], diffs: [] }, prompt: null, confidence: "unknown", warnings };
  } catch {
    return { messages: [], context: { files: [], diffs: [] }, prompt: null, confidence: "unknown", warnings: ["JSON parse error"] };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract content from iFlow message (which may have content as array or string)
 */
function extractContentFromIMessage(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((c) => {
      if (typeof c === "string") return c;
      if (c?.type === "text" && c?.text) return c.text;
      if (c?.type === "tool_result" && c?.content) return c.content;
      return JSON.stringify(c);
    }).join("\n");
  }
  return JSON.stringify(message.content);
}

/**
 * Extract content from Canvas structured data
 */
function extractCanvasContent(canvasItem) {
  if (!canvasItem) return null;
  
  if (typeof canvasItem.content === "string") {
    return `[Canvas] ${canvasItem.content}`;
  }
  
  if (canvasItem.canvas_data) {
    const data = canvasItem.canvas_data;
    let result = "[Canvas]\n";
    
    if (data.code) {
      result += `\n\`\`\`${data.language || 'text'}\n${data.code}\n\`\`\``;
    }
    if (data.html) {
      result += `\n[HTML]\n${data.html}`;
    }
    if (data.css) {
      result += `\n[CSS]\n${data.css}`;
    }
    if (data.description) {
      result += `\n\nDescription: ${data.description}`;
    }
    
    return result.trim() || null;
  }
  
  return JSON.stringify(canvasItem);
}

/**
 * Extract content from Artifact data
 */
function extractArtifactContent(artifact) {
  if (!artifact) return "[Artifact]";
  
  if (typeof artifact === "string") return `[Artifact] ${artifact}`;
  
  let result = "[Artifact] ";
  
  if (artifact.type) result += `Type: ${artifact.type}\n`;
  if (artifact.title) result += `Title: ${artifact.title}\n`;
  if (artifact.content) result += `\n${artifact.content}`;
  if (artifact.code) result += `\n\`\`\`\n${artifact.code}\n\`\`\``;
  if (artifact.generated_file) result += `\nGenerated: ${artifact.generated_file}`;
  
  return result.trim();
}

/**
 * Extract content from response items (Anthropic/Claude format)
 */
function extractContentFromResponseItem(item) {
  if (!item) return null;
  
  const type = item.type;
  
  if (type === "text" && item.text) {
    return { role: "assistant", content: item.text };
  }
  
  if (type === "tool_use" && item.name) {
    const toolInput = item.input ? JSON.stringify(item.input, null, 2) : '';
    return { role: "assistant", content: `[Tool Use] ${item.name}\n${toolInput}` };
  }
  
  if (type === "tool_result" && item.content !== undefined) {
    const isError = item.is_error;
    return { 
      role: "user", 
      content: isError ? `[Tool Error] ${item.content}` : `[Tool Result] ${item.content}` 
    };
  }
  
  if (type === "thinking" && item.thinking) {
    return { role: "assistant", content: `[Thinking] ${item.thinking}` };
  }
  
  if (type === "reasoning" && item.reasoning) {
    return { role: "assistant", content: `[Reasoning] ${item.reasoning}` };
  }
  
  if (type === "image" || type === "image_url") {
    const url = item.url || item.image_url;
    return { role: "user", content: `[Image] ${url}` };
  }
  
  if (type === "resource" && item.resource) {
    return { role: "system", content: `[Resource] ${item.resource}` };
  }
  
  if (type === "artifact" && item.artifact) {
    return { role: "assistant", content: extractArtifactContent(item.artifact) };
  }
  
  if (type === "canvas" && item.canvas) {
    return { role: "assistant", content: extractCanvasContent(item.canvas) };
  }
  
  // Fallback: stringify
  return null;
}
