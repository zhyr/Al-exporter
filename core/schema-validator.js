/**
 * JSON Schema validator for AI Exporter unified thread records.
 * Uses AJV (draft-07) to validate against the §6 data model.
 */

import Ajv from "ajv";
import { ALLOWED_SOURCES } from "./normalize.js";

const ajv = new Ajv({ allErrors: true, strict: false });

// meta.source enum is the single source of truth: derived from normalize.ALLOWED_SOURCES
// so the validator can never drift from what normalize() actually emits.
const SOURCE_ENUM = [...ALLOWED_SOURCES].sort();

// Unified thread record schema (§6 data model v1.1.0)
const THREAD_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AI Exporter Unified Thread",
  type: "object",
  required: ["schema_version", "thread_id", "messages", "meta"],
  properties: {
    schema_version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    thread_id:      { type: "string", minLength: 1 },
    type: {
      type: "string",
      enum: ["thread", "agent", "plan", "task", "walkthrough", "artifact", "mcp", "rule", "config", "log"],
    },
    session: {
      type: "object",
      properties: {
        native_id:         { type: ["string", "null"] },
        native_id_kind:    { type: "string" },
        native_id_source:  { type: ["string", "null"] },
        cwd:               { type: ["string", "null"] },
        cwd_source:        { type: ["string", "null"] },
        git_remote:        { type: ["string", "null"] },
        git_remote_source: { type: ["string", "null"] },
        agent_version:     { type: ["string", "null"] },
      },
    },
    device: {
      type: "object",
      properties: {
        source_device_id:        { type: ["string", "null"] },
        source_device_id_basis:  { type: ["string", "null"] },
        source_hostname:         { type: ["string", "null"] },
        collector_device_id:     { type: ["string", "null"] },
        collector_hostname:      { type: ["string", "null"] },
        collector_platform:      { type: ["string", "null"] },
      },
    },
    messages: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role:      { type: "string" },
          content:   { type: "string" },
          timestamp: { type: "string" },
          model:     { type: "string" },
          meta:      { type: "object" },
          id:        { type: ["string", "null"] },
          id_source: { type: ["string", "null"] },
          line:      { type: ["integer", "null"], minimum: 1 },
          tool_call: {
            type: "object",
            properties: {
              name:    { type: ["string", "null"] },
              status:  { type: ["string", "null"] },
              call_id: { type: ["string", "null"] },
              phase:   { type: "string", enum: ["call", "result"] },
            },
          },
        },
      },
    },
    context: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path:    { type: "string" },
              snippet: { type: "string" },
            },
          },
        },
        diffs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path:  { type: "string" },
              patch: { type: "string" },
            },
          },
        },
      },
    },
    meta: {
      type: "object",
      required: ["source", "project", "created_at"],
      properties: {
        source: {
          type: "string",
          enum: SOURCE_ENUM,
        },
        project:                { type: "string" },
        created_at:             { type: "string" },
        model:                  { type: ["string", "null"] },
        file_path:              { type: "string" },
        tokens:                 { type: "integer", minimum: 0 },
        prompt:                 { type: "string" },
        recognition_confidence: { type: "string", enum: ["high", "low", "unknown"] },
        source_detail:          { type: "string" },
        tool_version:           { type: "string" },
        warnings:               { type: "array", items: { type: "string" } },
        extra:                  { type: "object" },
      },
    },
  },
};

const validate = ajv.compile(THREAD_SCHEMA);

/**
 * Validate a single thread record.
 * @param {object} record
 * @returns {{ valid: boolean, errors: string[] }}
 */
const CONFIDENCE = new Set(["high", "low", "unknown"]);

/**
 * Make a thread record match THREAD_SCHEMA.
 * Real Forge exports used confidence "medium" and stored context.files as path strings.
 * @param {object} record
 */
export function conformThreadRecord(record) {
  if (!record || typeof record !== "object") return record;
  if (record.meta && typeof record.meta === "object") {
    const confidence = record.meta.recognition_confidence;
    if (confidence != null && !CONFIDENCE.has(confidence)) {
      record.meta.recognition_confidence = "low";
    }
    if (record.meta.tokens != null) {
      const n = Number(record.meta.tokens);
      record.meta.tokens = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    }
  }
  if (record.context && typeof record.context === "object") {
    if (Array.isArray(record.context.files)) {
      record.context.files = record.context.files.map((file) => {
        if (typeof file === "string") return { path: file };
        if (file && typeof file === "object") return file;
        return { path: String(file ?? "") };
      });
    }
    if (Array.isArray(record.context.diffs)) {
      record.context.diffs = record.context.diffs.map((diff) => {
        if (typeof diff === "string") return { patch: diff };
        if (diff && typeof diff === "object") return diff;
        return { patch: String(diff ?? "") };
      });
    }
  }
  if (Array.isArray(record.messages)) {
    record.messages = record.messages.filter((message) => message && typeof message === "object" && !Array.isArray(message));
    for (const message of record.messages) {
      if (!message || typeof message !== "object") continue;
      if (message.content != null && typeof message.content !== "string") {
        message.content = JSON.stringify(message.content);
      }
      if (message.timestamp == null) {
        delete message.timestamp;
      } else if (typeof message.timestamp === "number") {
        const ms = message.timestamp < 1e12 ? message.timestamp * 1000 : message.timestamp;
        const date = new Date(ms);
        message.timestamp = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
        if (message.timestamp == null) delete message.timestamp;
      } else if (typeof message.timestamp !== "string") {
        message.timestamp = String(message.timestamp);
      }
      if (message.id != null) message.id = String(message.id);
      else if ("id" in message) message.id = null;
      if (message.id_source != null) message.id_source = String(message.id_source);
      else if ("id_source" in message) message.id_source = null;
      if (!Number.isInteger(message.line) || message.line < 1) {
        if ("line" in message) message.line = null;
      }
      if (message.tool_call && typeof message.tool_call === "object") {
        if (message.tool_call.name != null) message.tool_call.name = String(message.tool_call.name);
        if (message.tool_call.status != null) message.tool_call.status = String(message.tool_call.status);
        if (message.tool_call.call_id != null) message.tool_call.call_id = String(message.tool_call.call_id);
        if (message.tool_call.phase !== "result") message.tool_call.phase = "call";
      }
    }
  }
  return record;
}

export function validateThread(record) {
  const valid = validate(record);
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors || []).map(
    (e) => `${e.instancePath || "(root)"} ${e.message}`
  );
  return { valid: false, errors };
}

/**
 * Validate an array of thread records. Returns summary statistics.
 * @param {object[]} records
 * @returns {{ total: number, valid: number, invalid: number, results: Array }}
 */
export function validateAll(records) {
  let validCount = 0;
  let invalidCount = 0;
  const results = records.map((r, i) => {
    const result = validateThread(r);
    if (result.valid) validCount++;
    else invalidCount++;
    return { index: i, thread_id: r.thread_id, ...result };
  });
  return { total: records.length, valid: validCount, invalid: invalidCount, results };
}

export { THREAD_SCHEMA };
