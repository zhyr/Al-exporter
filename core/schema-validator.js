/**
 * JSON Schema validator for AI Exporter unified thread records.
 * Uses AJV (draft-07) to validate against the §6 data model.
 */

import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

// Unified thread record schema (§6 data model v1.0.0)
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
      enum: ["thread", "plan", "task", "walkthrough", "artifact", "mcp", "rule", "config"],
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
          enum: [
            "cursor", "antigravity", "codex", "augment", "claude_code",
            "iflow", "trae", "codebuddy", "qoder", "windsurf",
            "vscode_copilot", "imported", "api_capture", "unknown", "other",
          ],
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
