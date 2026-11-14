/**
 * Claude Code transcript integrity signals (local-only).
 * Detects truncated / continued local transcripts.
 * Does not contact the network; optional backfill merge is separate.
 */

const SIGNAL_PARENT_UUID_MISSING = "parent_uuid_missing";
const SIGNAL_CONTINUATION_SUMMARY = "starts_with_continuation_summary";
const SIGNAL_SUBAGENT_BEFORE = "subagent_activity_before_transcript";

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function pathLooksLikeClaudeTranscript(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  return p.includes("/.claude/") && p.endsWith(".jsonl") && !p.includes("/subagents/");
}

function contentLooksLikeContinuationSummary(content) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("\n")
      : JSON.stringify(content || "");
  const head = text.trim().slice(0, 400).toLowerCase();
  return (
    head.includes("this session is being continued")
    || head.includes("summary of the conversation so far")
    || head.includes("conversation continued from a previous")
    || head.startsWith("[compact]")
  );
}

/**
 * Inspect a Claude Code JSONL transcript for truncation signals.
 * @param {string} content
 * @returns {{ signals: string[], earliest_known_activity: string, warnings: string[] }}
 */
export function detectClaudeTruncation(content) {
  const signals = [];
  const warnings = [];
  const uuids = new Set();
  let firstParent = null;
  let firstUserChecked = false;
  let firstTs = null;
  let earliestSubagent = null;

  for (const line of String(content || "").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
    if (uuid) uuids.add(uuid);
    if (firstParent === null && Object.prototype.hasOwnProperty.call(obj, "parentUuid")) {
      firstParent = obj.parentUuid;
    }

    const ts = obj.timestamp || obj.created_at;
    if (typeof ts === "string" && !firstTs) firstTs = ts;
    if (typeof ts === "number" && !firstTs) {
      firstTs = new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
    }

    const isSidechain = obj.isSidechain === true || obj.isSidechain === "true";
    if (isSidechain && typeof ts === "string") {
      if (!earliestSubagent || ts < earliestSubagent) earliestSubagent = ts;
    }

    if (!firstUserChecked) {
      const role = obj.message?.role || obj.role || (obj.type === "user" ? "user" : null);
      if (role === "user") {
        firstUserChecked = true;
        const body = obj.message?.content ?? obj.content;
        if (contentLooksLikeContinuationSummary(body)) {
          signals.push(SIGNAL_CONTINUATION_SUMMARY);
        }
      }
    }
  }

  if (firstParent && typeof firstParent === "string" && !uuids.has(firstParent)) {
    signals.push(SIGNAL_PARENT_UUID_MISSING);
  }
  if (earliestSubagent && firstTs && earliestSubagent < firstTs) {
    signals.push(SIGNAL_SUBAGENT_BEFORE);
  }

  if (signals.length) {
    warnings.push(`transcript truncated (${signals.join(", ")})`);
  }

  return {
    signals: [...new Set(signals)],
    earliest_known_activity: signals.includes(SIGNAL_SUBAGENT_BEFORE) ? (earliestSubagent || "") : "",
    warnings,
  };
}

export const CLAUDE_TRUNCATION_SIGNALS = {
  SIGNAL_PARENT_UUID_MISSING,
  SIGNAL_CONTINUATION_SUMMARY,
  SIGNAL_SUBAGENT_BEFORE,
};
