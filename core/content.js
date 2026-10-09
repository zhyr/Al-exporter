/**
 * Shared chat / tool / session text helpers.
 * Keeps normalize.js and cursor_sqlite.js on the same content rules.
 * Content stays a string so the thread schema does not change shape.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function contentToString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (part.type === "tool_use" || part.type === "tool_result") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.rawText === "string") return part.rawText;
      if (typeof part.content === "string") return part.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.rawText === "string") return value.rawText;
    if (typeof value.content === "string") return value.content;
    return JSON.stringify(value);
  }
  return String(value);
}

function mapChatRole(raw) {
  const r = String(raw || "").toLowerCase();
  if (r === "human" || r === "user") return "user";
  if (r === "ai" || r === "bot" || r === "gpt" || r === "assistant") return "assistant";
  if (r === "system") return "system";
  return r || "unknown";
}

function stampOf(m) {
  const timestamp = m?.timestamp ?? m?.ts;
  if (timestamp == null || timestamp === "") return {};
  if (typeof timestamp === "number") {
    const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
    return { timestamp: new Date(ms).toISOString() };
  }
  return { timestamp: String(timestamp) };
}

function toolUseMessage(name, detail, stamp) {
  const toolName = name || "tool";
  const body = detail ? `\n${detail}` : "";
  return {
    role: "assistant",
    content: `[Tool Use] ${toolName}${body}`,
    ...stamp,
    meta: { kind: "tool_use", name: toolName },
  };
}

function toolResultMessage(body, stamp, name) {
  return {
    role: "user",
    content: `[Tool Result] ${body}`,
    ...stamp,
    meta: { kind: "tool_result", ...(name ? { name } : {}) },
  };
}

function expandBlocks(blocks, role, stamp) {
  const out = [];
  const text = [];
  const flush = () => {
    const joined = text.join("\n");
    text.length = 0;
    if (joined.trim()) out.push({ role, content: joined, ...stamp });
  };
  for (const block of blocks) {
    if (typeof block === "string") {
      text.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use" || block.type === "function_call") {
      flush();
      const args = block.input ?? block.arguments ?? block.args ?? "";
      const argText = typeof args === "string" ? args : JSON.stringify(args);
      out.push(toolUseMessage(block.name || block.tool, argText, stamp));
      continue;
    }
    if (block.type === "tool_result" || block.type === "function_call_output") {
      flush();
      const body = contentToString(block.content ?? block.output ?? "");
      out.push(toolResultMessage(body, stamp, block.name || block.tool || ""));
      continue;
    }
    if (block.type === "text" || typeof block.text === "string") {
      text.push(block.text || "");
      continue;
    }
    const fallback = contentToString(block.content ?? block.rawText ?? "");
    if (fallback) text.push(fallback);
  }
  flush();
  return out;
}

/**
 * Turn one raw message into one or more schema messages.
 * Empty string content is kept so callers can count and warn before dropping it.
 * @param {object} m
 * @returns {object[]}
 */
export function expandMessage(m) {
  if (!m || typeof m !== "object") return [];
  const role = mapChatRole(m.role || (m.type === "ai" ? "assistant" : m.type === "user" || m.type === "human" ? "user" : ""));
  const stamp = stampOf(m);
  if (Array.isArray(m.content)) {
    const expanded = expandBlocks(m.content, role, stamp);
    return expanded.length ? expanded : [{ role, content: "", ...stamp }];
  }
  const content = contentToString(m.content ?? m.text ?? m.rawText ?? "");
  const msg = { role, content, ...stamp };
  if (m.model) msg.model = m.model;
  return [msg];
}

/**
 * @param {unknown} list
 * @returns {object[]}
 */
export function expandMessageList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) out.push(...expandMessage(m));
  return out;
}

function explicitSessionId(item) {
  if (!item || typeof item !== "object") return "";
  const id = item.sessionId ?? item.session_id ?? item.trace_id;
  if (id == null || id === "") return "";
  return String(id);
}

function groupId(item) {
  const explicit = explicitSessionId(item);
  if (explicit) return explicit;
  if (item.id == null || item.id === "") return "";
  return String(item.id);
}

function messagesOfSession(item) {
  return expandMessageList(item.messages || item.conversation || item.history || []);
}

/**
 * Split a parsed JSON value into sessions when a stable id is present.
 * ShareGPT `{ from, value }` rows are not sessions.
 * @param {object} parsed
 * @returns {{ id: string, messages: object[] }[]}
 */
export function sessionGroupsFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const groups = [];

  const takeArray = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      if (item.from !== undefined && item.value !== undefined && !item.messages) continue;
      const id = groupId(item);
      if (!id) continue;
      const messages = messagesOfSession(item);
      if (messages.length === 0) continue;
      groups.push({ id, messages });
    }
  };

  takeArray(parsed.sessions);
  if (groups.length === 0) takeArray(parsed.conversations);

  if (groups.length === 0) {
    const id = explicitSessionId(parsed);
    if (id) {
      const messages = messagesOfSession(parsed);
      if (messages.length) groups.push({ id, messages });
    }
  }
  return groups;
}

function isRuntimeEvent(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (Array.isArray(obj.messages)) return false;
  if (obj.role && (obj.content !== undefined || obj.text !== undefined)) return false;
  if (obj._type === "mark" || obj._type === "summary") return true;
  return Boolean(
    obj.trace_id || obj.agent_start || obj.agent_end || obj.event
    || obj.type === "agent_start" || obj.type === "agent_end",
  );
}

function runtimeEventText(event) {
  if (event._type === "mark") {
    const phase = event.phase || "mark";
    const at = event.epochMs != null ? ` epochMs=${event.epochMs}` : "";
    return `${phase}${at}`.trim();
  }
  if (event._type === "summary") {
    const ms = event.totalDurationMs != null ? ` totalDurationMs=${event.totalDurationMs}` : "";
    return `summary${ms}`.trim();
  }
  const name = event.event || event.type
    || (event.agent_start ? "agent_start" : event.agent_end ? "agent_end" : "event");
  const trace = event.trace_id ? `trace_id=${event.trace_id} ` : "";
  let payload = "";
  if (event.payload !== undefined) {
    payload = ` ${typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)}`;
  }
  return `${trace}${name}${payload}`.trim();
}

function parseJsonValue(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* line may start with a timestamp */ }
  const start = trimmed.indexOf("{");
  if (start <= 0) return null;
  try { return JSON.parse(trimmed.slice(start)); } catch { return null; }
}

/**
 * Parse a runtime log body into system messages. Returns [] when the body is chat.
 * @param {string} content
 * @returns {object[]}
 */
export function runtimeMessagesFromText(content) {
  if (!content || !content.trim()) return [];
  let events = [];
  const parsed = parseJsonValue(content);
  if (Array.isArray(parsed)) events = parsed;
  else if (isRuntimeEvent(parsed)) events = [parsed];
  else if (Array.isArray(parsed?.events) && parsed.events.every(isRuntimeEvent)) events = parsed.events;
  if (events.length === 0) {
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const obj = parseJsonValue(line);
      if (isRuntimeEvent(obj)) events.push(obj);
    }
  }
  if (events.length === 0 || events.some((e) => !isRuntimeEvent(e))) return [];
  return events.map((event) => ({
    role: "system",
    content: runtimeEventText(event),
  })).filter((m) => m.content);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function pathLooksLikeRuntimeLog(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  return p.includes("log") || p.includes("run");
}
