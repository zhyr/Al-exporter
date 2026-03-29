/**
 * Format converters for AI Exporter (§3.4, §5.2).
 *
 * Converts unified thread records to:
 *   - training-jsonl (SFT minimal)
 *   - sharegpt
 *   - markdown
 *   - stats summary
 */

// ─── Training JSONL (SFT) ─────────────────────────────────────────────────────

/**
 * Convert records to SFT training JSONL lines.
 * Supports single-turn (instruction/output) and multi-turn (messages array).
 *
 * @param {object[]} records  Unified schema records
 * @param {object}  opts
 * @param {string}  [opts.style="sft"]    "sft" | "sharegpt" | "multiturn"
 * @param {number}  [opts.minLength=20]   Skip pairs where content < N chars
 * @param {boolean} [opts.dedupe=true]    Skip duplicate content hashes
 * @returns {string}  Newline-delimited JSONL
 */
export function toTrainingJsonl(records, opts = {}) {
  const {
    style = "sft",
    minLength = 20,
    dedupe = true,
  } = opts;

  const seenHashes = new Set();
  const lines = [];

  for (const record of records) {
    const msgs = record.messages || [];
    if (msgs.length === 0) continue;

    if (style === "sharegpt") {
      const entry = toShareGpt(record, { minLength, dedupe, seenHashes });
      if (entry) lines.push(JSON.stringify(entry));
    } else if (style === "multiturn") {
      const entry = toMultiturn(record, { minLength });
      if (entry) lines.push(JSON.stringify(entry));
    } else {
      // Default: SFT single-turn (first user → first assistant)
      const pairs = extractPairs(msgs, minLength);
      for (const pair of pairs) {
        const key = `${pair.instruction}::${pair.output}`;
        if (dedupe && seenHashes.has(key)) continue;
        if (dedupe) seenHashes.add(key);
        lines.push(JSON.stringify(pair));
      }
    }
  }

  return lines.join("\n");
}

/** SFT minimal: { instruction, input, output } */
function extractPairs(messages, minLength) {
  const pairs = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const user = messages[i];
    const asst = messages[i + 1];
    if (user?.role !== "user" || asst?.role !== "assistant") continue;
    const instruction = typeof user.content === "string" ? user.content.trim() : (user.content ? JSON.stringify(user.content) : "");
    const output = typeof asst.content === "string" ? asst.content.trim() : (asst.content ? JSON.stringify(asst.content) : "");
    if (instruction.length < minLength || output.length < minLength) continue;
    pairs.push({ instruction, input: "", output });
  }
  return pairs;
}

/** ShareGPT: { id, conversations: [{from, value}] } */
function toShareGpt(record, { minLength, dedupe, seenHashes }) {
  const convs = (record.messages || [])
    .filter((m) => {
      const content = typeof m.content === "string" ? m.content : (m.content ? JSON.stringify(m.content) : "");
      return content.trim().length >= minLength;
    })
    .map((m) => ({
      from: m.role === "assistant" ? "gpt" : m.role === "system" ? "system" : "human",
      value: typeof m.content === "string" ? m.content.trim() : JSON.stringify(m.content),
    }));
  if (convs.length < 2) return null;
  const key = convs.map((c) => c.value).join("::");
  if (dedupe && seenHashes.has(key)) return null;
  if (dedupe) seenHashes.add(key);
  return { id: record.thread_id, conversations: convs };
}

/** Multiturn: { messages: [{role, content}] } */
function toMultiturn(record, { minLength }) {
  const msgs = (record.messages || [])
    .filter((m) => {
      const content = typeof m.content === "string" ? m.content : (m.content ? JSON.stringify(m.content) : "");
      return content.trim().length >= minLength;
    })
    .map((m) => ({ 
      role: m.role, 
      content: typeof m.content === "string" ? m.content.trim() : JSON.stringify(m.content) 
    }));
  if (msgs.length === 0) return null;
  return {
    thread_id: record.thread_id,
    source: record.meta?.source,
    messages: msgs,
  };
}

// ─── Markdown export ──────────────────────────────────────────────────────────

/**
 * Convert a single thread record to human-readable Markdown (Appendix C format).
 * @param {object} record
 * @returns {string}
 */
export function toMarkdown(record) {
  const meta = record.meta || {};
  const lines = [
    `# Thread: ${meta.prompt || record.thread_id}`,
    ``,
    `> **Source:** ${meta.source} | **Project:** ${meta.project} | **Created:** ${meta.created_at}`,
    ``,
  ];

  for (const msg of record.messages || []) {
    const heading = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    lines.push(`## ${heading}`);
    lines.push(``);
    lines.push(msg.content || "*(empty)*");
    lines.push(``);
  }

  const files = record.context?.files || [];
  if (files.length > 0) {
    lines.push(`## Context Files`);
    lines.push(``);
    lines.push(...files.map((f) => `- \`${f.path || f}\``));
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Convert multiple records to a single Markdown document.
 * @param {object[]} records
 * @returns {string}
 */
export function toMarkdownAll(records) {
  return records
    .map((r, i) => `${i > 0 ? "\n---\n\n" : ""}${toMarkdown(r)}`)
    .join("");
}

export function computeStats(records, groupBy = ["project", "source"]) {
  const groups = {};

  let total_user_tokens = 0;
  let total_ai_tokens = 0;
  let max_ai_overall = 0;
  let max_user_overall = 0;

  for (const r of records) {
    const keys = groupBy.map((g) => {
      if (g === "project") return r.meta?.project || "unknown";
      if (g === "source") return r.meta?.source || "unknown";
      if (g === "month") {
        const d = r.meta?.created_at ? new Date(r.meta.created_at) : null;
        return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "unknown";
      }
      if (g === "type") return r.type || "thread";
      return "unknown";
    });
    const groupKey = keys.join(" | ");
    if (!groups[groupKey]) {
      groups[groupKey] = {
        label: Object.fromEntries(groupBy.map((g, i) => [g, keys[i]])),
        threads: 0,
        messages: 0,
        tokens: 0,
        user_tokens: 0,
        ai_tokens: 0,
        max_ai: 0,
        max_user: 0,
        confidence: { high: 0, low: 0, unknown: 0 },
      };
    }

    const userToks = (r.messages || []).filter(m => m.role === 'user').reduce((a, m) => {
      const content = typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : '');
      return a + (content.length / 4 | 0);
    }, 0);
    const aiToks = (r.messages || []).filter(m => m.role === 'assistant').reduce((a, m) => {
      const content = typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : '');
      return a + (content.length / 4 | 0);
    }, 0);

    total_user_tokens += userToks;
    total_ai_tokens += aiToks;
    max_ai_overall = Math.max(max_ai_overall, aiToks);
    max_user_overall = Math.max(max_user_overall, userToks);

    groups[groupKey].threads++;
    groups[groupKey].messages += (r.messages || []).length;
    groups[groupKey].tokens += r.meta?.tokens || 0;
    groups[groupKey].user_tokens += userToks;
    groups[groupKey].ai_tokens += aiToks;
    groups[groupKey].max_ai = Math.max(groups[groupKey].max_ai, aiToks);
    groups[groupKey].max_user = Math.max(groups[groupKey].max_user, userToks);

    const conf = r.meta?.recognition_confidence || "unknown";
    groups[groupKey].confidence[conf] = (groups[groupKey].confidence[conf] || 0) + 1;
  }

  return {
    total_records: records.length,
    total_tokens: records.reduce((s, r) => s + (r.meta?.tokens || 0), 0),
    total_messages: records.reduce((s, r) => s + (r.messages || []).length, 0),
    user_tokens: total_user_tokens,
    ai_tokens: total_ai_tokens,
    max_ai: max_ai_overall,
    max_user: max_user_overall,
    groups: Object.values(groups).sort((a, b) => b.threads - a.threads),
  };
}

import pLimit from 'p-limit';
import path from 'node:path';
import fs from 'fs-extra';

/**
 * 保存记录到指定目录
 * @param {object[]} records
 * @param {string} outputDir
 */
export async function saveRecordsToDir(records, outputDir) {
  const limit = pLimit(5); // Even more conservative to avoid EMFILE

  await fs.ensureDir(outputDir);

  const tasks = records.map(r => limit(async () => {
    const src = r.meta?.source || 'unknown';
    const dir = path.join(outputDir, src);
    await fs.ensureDir(dir);

    const firstContent = r.messages?.[0]?.content;
    const id = r.thread_id || (typeof firstContent === 'string' ? firstContent.slice(0, 20) : (firstContent ? JSON.stringify(firstContent).slice(0, 20) : Date.now()));
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const filePath = path.join(dir, `${safeId}.json`);
    await fs.writeFile(filePath, JSON.stringify(r, null, 2));
  }));
  
  await Promise.all(tasks);
}
