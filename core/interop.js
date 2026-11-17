/**
 * Interop contract helpers (schema 1.1.0).
 *
 * Keeps agent-native identity, device identity and capability reporting in one
 * place so every collector (normalize, cursor_sqlite, cursor_cli, workbuddy)
 * emits the same shape.
 *
 * Rules:
 *  - Every contract field is present on every record; unknown values are null.
 *  - Nothing is inferred from file mtime or from a project-name guess.
 *  - A native id / cwd / git remote is only exported when the source recorded it
 *    or when it can be read verbatim from the local filesystem.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INTEROP_CONTRACT = "al-exporter-interop";
export const INTEROP_CONTRACT_VERSION = "1.0.0";
export const INTEROP_FILENAME = "interop.json";

const GIT_REMOTE_CACHE = new Map();

// ─── Device identity ──────────────────────────────────────────────────────────

/**
 * Stable, non-secret device id derived from hostname + platform.
 * The raw hostname is kept in a separate field so it can be dropped by consumers.
 * @param {{ hostname?: string, platform?: string }} [opts]
 */
export function localDeviceIdentity({ hostname = os.hostname(), platform = process.platform } = {}) {
  const host = String(hostname || "").trim() || "unknown-host";
  const plat = String(platform || "").trim() || "unknown";
  const digest = crypto.createHash("sha256").update(`${host}\u0000${plat}`).digest("hex").slice(0, 16);
  return { id: `dev_${digest}`, hostname: host, platform: plat };
}

/**
 * Resolve the two device roles:
 *  - source: the machine that owns the agent records being exported
 *  - collector: the machine running this export
 *
 * Without `--source-device` the export host is assumed to also be the source and
 * that assumption is recorded in `source_device_id_basis: "export_host"`.
 * @param {{ sourceDevice?: string|null, hostname?: string, platform?: string }} [opts]
 */
export function resolveDeviceIdentity({ sourceDevice = null, hostname, platform } = {}) {
  const collector = localDeviceIdentity({ hostname, platform });
  const declared = typeof sourceDevice === "string" ? sourceDevice.trim() : "";
  if (declared) {
    return {
      source_device_id: declared,
      source_device_id_basis: "declared",
      source_hostname: null,
      collector_device_id: collector.id,
      collector_hostname: collector.hostname,
      collector_platform: collector.platform,
    };
  }
  return {
    source_device_id: collector.id,
    source_device_id_basis: "export_host",
    source_hostname: collector.hostname,
    collector_device_id: collector.id,
    collector_hostname: collector.hostname,
    collector_platform: collector.platform,
  };
}

// ─── Native session ids from paths ────────────────────────────────────────────

/** Layouts whose file/dir name is the agent-native session id. */
const NATIVE_ID_PATTERNS = [
  {
    // Claude Code: ~/.claude/projects/<encoded-project>/<session-uuid>.jsonl
    re: /\/\.claude\/projects\/[^/]+\/([^/]+)\.jsonl$/i,
    kind: "uuid",
    source: "file.basename",
  },
  {
    // Qoder: ~/.qoder/projects/<encoded-project>/<session-uuid>.jsonl
    re: /\/\.(?:qoder|qcoder)\/projects\/[^/]+\/([^/]+)\.jsonl$/i,
    kind: "uuid",
    source: "file.basename",
  },
  {
    // Cursor agent transcript: .../agent-transcripts/<session-uuid>/<session-uuid>.jsonl
    // and subagents/<subagent-uuid>.jsonl
    re: /\/agent-transcripts\/([^/]+)\/(?:subagents\/)?[^/]+\.jsonl$/i,
    kind: "uuid",
    source: "dir.basename",
  },
  {
    // Codex rollout: ~/.codex/sessions/YYYY/MM/DD/rollout-<date>-<uuid>.json[l][.zst]
    re: /\/\.codex\/sessions\/.*\/rollout-(?:[0-9T-]+-)?([0-9a-f-]{36})\.json(?:l)?(?:\.zst)?$/i,
    kind: "uuid",
    source: "file.basename",
  },
  {
    // WorkBuddy: ~/.workbuddy[-ai]/projects/<project>/<session-uuid>.jsonl
    re: /\/\.workbuddy(?:-ai)?\/projects\/[^/]+\/([^/]+)\.jsonl$/i,
    kind: "uuid",
    source: "file.basename",
  },
  {
    // Trae memory summaries: session_memory_<id>.jsonl
    re: /\/\.trae[^/]*\/memory\/projects\/[^/]+\/[^/]+\/session_memory_([^/.]+)\.jsonl$/i,
    kind: "native",
    source: "file.basename",
  },
  {
    // Cursor CLI: ~/.cursor/chats/<workspace>/<session-uuid>/store.db
    re: /\/\.cursor\/chats\/[^/]+\/([^/]+)\/store\.db$/i,
    kind: "uuid",
    source: "dir.basename",
  },
];

/**
 * Infer the agent-native session id from a source path.
 * Returns null when the layout does not expose one.
 * @param {string} filePath
 * @returns {{ native_id: string, native_id_kind: string, native_id_source: string }|null}
 */
export function inferNativeSessionId(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/");
  if (!p) return null;
  for (const { re, kind, source } of NATIVE_ID_PATTERNS) {
    const match = re.exec(p);
    if (match?.[1]) {
      return { native_id: match[1], native_id_kind: kind, native_id_source: source };
    }
  }
  return null;
}

// ─── Git remote from the local worktree ───────────────────────────────────────

function resolveGitConfigPath(cwd) {
  const dotGit = path.join(cwd, ".git");
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return path.join(dotGit, "config");
  if (!stat.isFile()) return null;
  try {
    const text = fs.readFileSync(dotGit, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match) return null;
    const gitDir = path.resolve(cwd, match[1].trim());
    return path.join(gitDir, "config");
  } catch {
    return null;
  }
}

function parseFirstRemote(configText) {
  let sectionRemote = null;
  const remotes = new Map();
  for (const rawLine of String(configText || "").split("\n")) {
    const line = rawLine.trim();
    const section = /^\[remote\s+"([^"]+)"\]$/i.exec(line);
    if (section) {
      sectionRemote = section[1];
      if (!remotes.has(sectionRemote)) remotes.set(sectionRemote, null);
      continue;
    }
    if (/^\[/.test(line)) {
      sectionRemote = null;
      continue;
    }
    if (!sectionRemote) continue;
    const url = /^url\s*=\s*(.+)$/i.exec(line);
    if (url && !remotes.get(sectionRemote)) remotes.set(sectionRemote, url[1].trim());
  }
  if (remotes.get("origin")) return remotes.get("origin");
  for (const url of remotes.values()) if (url) return url;
  return null;
}

/**
 * Read the git remote URL for a working directory, read-only.
 * Returns { remote, source: "cwd_git_config" } or null.
 * @param {string|null|undefined} cwd
 */
export function readGitRemote(cwd) {
  if (!cwd || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  if (GIT_REMOTE_CACHE.has(cwd)) return GIT_REMOTE_CACHE.get(cwd);
  let result = null;
  const configPath = resolveGitConfigPath(cwd);
  if (configPath) {
    try {
      const remote = parseFirstRemote(fs.readFileSync(configPath, "utf8"));
      if (remote) result = { remote, source: "cwd_git_config" };
    } catch {
      result = null;
    }
  }
  GIT_REMOTE_CACHE.set(cwd, result);
  return result;
}

// ─── Record shape ─────────────────────────────────────────────────────────────

/** Empty `session` block with every contract field present. */
export function emptySessionBlock() {
  return {
    native_id: null,
    native_id_kind: "none",
    native_id_source: null,
    cwd: null,
    cwd_source: null,
    git_remote: null,
    git_remote_source: null,
    agent_version: null,
  };
}

/**
 * Build a complete `session` block from whatever the parser knows.
 * @param {object} [input]
 */
export function buildSessionBlock(input = {}) {
  const block = emptySessionBlock();
  if (input.native_id) {
    block.native_id = String(input.native_id);
    block.native_id_kind = input.native_id_kind || "native";
    block.native_id_source = input.native_id_source || null;
  }
  if (input.cwd) {
    block.cwd = String(input.cwd);
    block.cwd_source = input.cwd_source || null;
  }
  if (input.git_remote) {
    block.git_remote = String(input.git_remote);
    block.git_remote_source = input.git_remote_source || "source_record";
  }
  if (input.agent_version) block.agent_version = String(input.agent_version);
  return block;
}

/** Merge parser metadata over a base session block, keeping real values. */
export function mergeSessionBlock(base, extra = {}) {
  const merged = { ...emptySessionBlock(), ...(base || {}) };
  for (const key of Object.keys(emptySessionBlock())) {
    if (merged[key] == null && extra[key] != null) merged[key] = extra[key];
  }
  return merged;
}

/** Keep a tool status string only when the source recorded one. */
export function toolStatus(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Apply the interop contract to one record in place:
 *  - fill missing `session` fields and infer the native id from the source path
 *  - fill missing git remote from the local worktree when cwd is readable
 *  - attach device identity
 *  - make message id / line / tool_call fields explicit
 *
 * Idempotent. Never overwrites a real value with null.
 * @param {object} record
 * @param {{ devices: object }} opts
 */
export function finalizeRecordInterop(record, { devices }) {
  if (!record || typeof record !== "object") return record;

  const session = { ...emptySessionBlock(), ...(record.session && typeof record.session === "object" ? record.session : {}) };
  if (!session.native_id) {
    const inferred = inferNativeSessionId(record.meta?.file_path);
    if (inferred) Object.assign(session, inferred);
  }
  if (session.cwd && !session.git_remote) {
    const git = readGitRemote(session.cwd);
    if (git) {
      session.git_remote = git.remote;
      session.git_remote_source = git.source;
    }
  }
  record.session = session;
  record.device = { ...devices };

  if (record.meta && typeof record.meta === "object") {
    const extra = record.meta.extra && typeof record.meta.extra === "object" ? record.meta.extra : {};
    if (!extra.session_id && session.native_id) {
      record.meta.extra = { ...extra, session_id: session.native_id };
    }
  }

  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      if (!message || typeof message !== "object") continue;
      if (message.id != null) message.id = String(message.id);
      else message.id = null;
      if (message.id_source == null) message.id_source = null;
      if (!Number.isInteger(message.line) || message.line < 1) message.line = null;
      if (message.tool_call && typeof message.tool_call === "object") {
        const tool = message.tool_call;
        tool.name = tool.name != null ? String(tool.name) : null;
        tool.status = tool.status != null ? String(tool.status) : null;
        tool.call_id = tool.call_id != null ? String(tool.call_id) : null;
        tool.phase = tool.phase === "result" ? "result" : "call";
      }
    }
  }
  return record;
}

// ─── Capability report ────────────────────────────────────────────────────────

const FIELD_SPECS = [
  {
    key: "session.native_id",
    scope: "record",
    get: (record) => record.session?.native_id,
    capability: "native_session_id",
    notes: "Agent-native session id taken from the source id, session file name or session directory name.",
  },
  {
    key: "session.cwd",
    scope: "record",
    get: (record) => record.session?.cwd,
    capability: "session_cwd",
    notes: "Working directory as recorded by the agent or by the IDE workspace metadata.",
  },
  {
    key: "session.git_remote",
    scope: "record",
    get: (record) => record.session?.git_remote,
    capability: "git_remote",
    notes: "Only from the source record or from <cwd>/.git/config when that cwd is readable on this machine.",
  },
  {
    key: "session.agent_version",
    scope: "record",
    get: (record) => record.session?.agent_version,
    capability: "agent_version",
    notes: "Agent CLI/app version when the source transcript records it.",
  },
  {
    key: "device.source_device_id",
    scope: "record",
    get: (record) => record.device?.source_device_id,
    capability: "device_identity",
    notes: "Separate from agent and path identity; basis says whether it was declared or inferred from the export host.",
  },
  {
    key: "messages[].id",
    scope: "message",
    get: (message) => message.id,
    capability: "native_message_id",
    notes: "Native per-message id (uuid / event id / bubble id).",
  },
  {
    key: "messages[].line",
    scope: "message",
    get: (message) => message.line,
    capability: "message_line_number",
    notes: "1-based line number in the source file; null for non-line-oriented stores (SQLite, blobs).",
  },
  {
    key: "messages[].timestamp",
    scope: "message",
    get: (message) => message.timestamp,
    capability: "message_timestamp",
    notes: "Source timestamps only. File mtime is never substituted.",
  },
  {
    key: "messages[].tool_call.name",
    scope: "tool_call",
    get: (message) => message.tool_call?.name,
    capability: "tool_call_name",
    notes: "Structured tool name for messages that are tool calls or tool results.",
  },
  {
    key: "messages[].tool_call.status",
    scope: "tool_call",
    get: (message) => message.tool_call?.status,
    capability: "tool_call_status",
    notes: "Only when the source records a status (for example WorkBuddy status). No success is inferred from a result existing.",
  },
  {
    key: "messages[].tool_call.call_id",
    scope: "tool_call",
    get: (message) => message.tool_call?.call_id,
    capability: "tool_call_id",
    notes: "Source call id when present, useful for pairing a call with its result.",
  },
];

function isNonEmpty(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function statusOf(applicable, nonEmpty) {
  if (applicable === 0) return "not_applicable";
  if (nonEmpty === 0) return "empty";
  if (nonEmpty === applicable) return "full";
  return "partial";
}

/**
 * Counter used to aggregate capability coverage without keeping records in memory.
 * Lets incremental exports combine carried-forward outputs with newly written ones.
 */
export function createInteropCounter() {
  const fields = {};
  for (const spec of FIELD_SPECS) {
    fields[spec.key] = { applicable: 0, non_empty: 0, records_with_non_empty: 0 };
  }
  return { records_total: 0, messages_total: 0, fields };
}

/**
 * Add a batch of records to a counter. Batches must be disjoint.
 * @param {ReturnType<typeof createInteropCounter>} counter
 * @param {object[]} records
 */
export function addInteropRecords(counter, records) {
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r === "object") : [];
  for (const record of list) {
    counter.records_total += 1;
    const messages = Array.isArray(record.messages) ? record.messages : [];
    counter.messages_total += messages.length;

    for (const spec of FIELD_SPECS) {
      const acc = counter.fields[spec.key]
        || (counter.fields[spec.key] = { applicable: 0, non_empty: 0, records_with_non_empty: 0 });
      if (spec.scope === "record") {
        acc.applicable += 1;
        if (isNonEmpty(spec.get(record))) {
          acc.non_empty += 1;
          acc.records_with_non_empty += 1;
        }
        continue;
      }
      let recordHasValue = false;
      for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        if (spec.scope === "tool_call" && (!message.tool_call || typeof message.tool_call !== "object")) continue;
        acc.applicable += 1;
        if (isNonEmpty(spec.get(message))) {
          acc.non_empty += 1;
          recordHasValue = true;
        }
      }
      if (recordHasValue) acc.records_with_non_empty += 1;
    }
  }
  return counter;
}

/**
 * Build the machine-readable capability document from an aggregated counter.
 * @param {ReturnType<typeof createInteropCounter>} counter
 * @param {{ generatedAt?: string, exporterVersion?: string, schemaVersion?: string, devices?: object, stateSkippedFiles?: number, basis?: string }} opts
 */
export function buildInteropReport(counter, {
  generatedAt = new Date().toISOString(),
  exporterVersion = "unknown",
  schemaVersion = "unknown",
  devices = null,
  stateSkippedFiles = 0,
  basis = "records_written_in_this_export",
} = {}) {
  const fields = {};
  const capabilities = {};

  for (const spec of FIELD_SPECS) {
    const acc = counter.fields[spec.key] || { applicable: 0, non_empty: 0, records_with_non_empty: 0 };
    const status = statusOf(acc.applicable, acc.non_empty);
    fields[spec.key] = {
      schema_present: true,
      scope: spec.scope,
      applicable: acc.applicable,
      non_empty: acc.non_empty,
      empty: acc.applicable - acc.non_empty,
      records_with_non_empty: acc.records_with_non_empty,
      status,
      notes: spec.notes,
    };
    capabilities[spec.capability] = status;
  }

  const knownGaps = [];
  if (capabilities.native_session_id !== "full") {
    knownGaps.push(
      "Not every record has a native session id: sources such as Cursor vscdb rows and non-session config/rule files do not expose one. native_id stays null instead of being invented.",
    );
  }
  if (capabilities.message_line_number !== "full") {
    knownGaps.push(
      "Line numbers exist only for line-oriented sources (JSONL). SQLite-backed and blob-derived records keep line: null.",
    );
  }
  if (capabilities.message_timestamp !== "full") {
    knownGaps.push(
      "Messages without a source timestamp (for example Cursor agent transcripts) omit it; meta.created_at/mtime is never used as a message time.",
    );
  }
  if (capabilities.git_remote !== "full") {
    knownGaps.push(
      "git_remote is exported only when the source records it or <cwd>/.git/config is readable locally; mounted remote backups therefore usually have null.",
    );
  }
  if (capabilities.tool_call_status !== "full") {
    knownGaps.push(
      "Tool status is exported only when the source stores one (WorkBuddy does; most transcript formats do not). Absence is null, never a guessed success.",
    );
  }
  knownGaps.push(
    "A null value means the source did not provide the value. It never means an empty string and is not filled from file mtime or project-name heuristics.",
  );

  return {
    contract: INTEROP_CONTRACT,
    contract_version: INTEROP_CONTRACT_VERSION,
    schema_version: schemaVersion,
    exporter_version: exporterVersion,
    generated_at: generatedAt,
    basis,
    records_total: counter.records_total,
    messages_total: counter.messages_total,
    state_skipped_files: stateSkippedFiles,
    device: devices,
    fields,
    capabilities,
    known_gaps: knownGaps,
  };
}

/**
 * Build the machine-readable capability document.
 * Field presence is computed from the records in this export; `schema_present`
 * is always true because the fields are part of schema 1.1.0.
 * @param {object[]} records
 * @param {{ generatedAt?: string, exporterVersion?: string, schemaVersion?: string, devices?: object, stateSkippedFiles?: number }} opts
 */
export function computeInteropCapabilities(records, opts = {}) {
  return buildInteropReport(addInteropRecords(createInteropCounter(), records), opts);
}
