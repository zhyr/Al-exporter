/**
 * Unit tests for core/normalize.js
 * Run: node --test tests/unit/normalize.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAll, identifyType, normalizeMetaSource, ALLOWED_SOURCES } from "../../core/normalize.js";
import { validateThread, THREAD_SCHEMA, conformThreadRecord } from "../../core/schema-validator.js";
import { extractEvidence } from "../../core/t2e/mine.js";
import { inferSourceFromVscdbPath } from "../../core/cursor_sqlite.js";

describe("identifyType", () => {
  it("returns plan for plan files",       () => assert.equal(identifyType("/path/to/plan.json"), "plan"));
  it("returns task for task files",       () => assert.equal(identifyType("/path/to/task.md"), "task"));
  it("returns rule for cursorrules",      () => assert.equal(identifyType("/path/.cursorrules"), "rule"));
  it("returns config for settings.json", () => assert.equal(identifyType("/path/settings.json"), "config"));
  it("returns thread for history.json",  () => assert.equal(identifyType("/path/history.json"), "thread"));
  it("returns mcp for mcp.json",         () => assert.equal(identifyType("/path/mcp.json"), "mcp"));
});

describe("normalizeMetaSource", () => {
  it("maps 'cursor' → cursor",      () => assert.equal(normalizeMetaSource("cursor"), "cursor"));
  it("maps 'claude' → claude_code", () => assert.equal(normalizeMetaSource("claude"), "claude_code"));
  it("maps 'openai' → codex",       () => assert.equal(normalizeMetaSource("openai"), "codex"));
  it("maps 'qcoder' → qoder",       () => assert.equal(normalizeMetaSource("qcoder"), "qoder"));
  it("maps 'zed' → zed",          () => assert.equal(normalizeMetaSource("zed"), "zed"));
  it("maps 'workbuddy' → workbuddy", () => assert.equal(normalizeMetaSource("workbuddy"), "workbuddy"));
  it("maps 'zcode' → zcode",      () => assert.equal(normalizeMetaSource("zcode"), "zcode"));
  it("unknown gibberish → other",   () => assert.equal(normalizeMetaSource("my-custom-tool-123"), "other"));
});

describe("normalizeAll — OpenAI messages schema", () => {
  const raw = [{
    path: "/fake/cursor/history.json",
    content: JSON.stringify({ messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi there!" }] }),
    mtime: Date.now(), size: 100,
  }];
  const records = normalizeAll(raw);

  it("produces at least one record", () => assert.ok(records.length >= 1));
  it("sets schema_version", () => assert.equal(records[0].schema_version, "1.0.0"));
  it("sets thread_id", () => assert.ok(records[0].thread_id?.length > 0));
  it("has recognition_confidence", () => assert.ok(["high","low","unknown"].includes(records[0].meta.recognition_confidence)));
  it("extracts 2 messages", () => assert.equal(records[0].messages.length, 2));
  it("first message role is user", () => assert.equal(records[0].messages[0].role, "user"));
  it("source is cursor", () => assert.equal(records[0].meta.source, "cursor"));
});

describe("normalizeAll — Cursor tabs schema", () => {
  const raw = [{
    path: "/fake/cursor/tabs.json",
    content: JSON.stringify({
      tabs: [{ bubbles: [
        { type: "user", rawText: "What does this do?" },
        { type: "ai",   rawText: "It does X." },
      ]}]
    }),
    mtime: Date.now(), size: 100,
  }];
  const records = normalizeAll(raw);
  it("extracts 2 messages from tabs", () => assert.ok(records.length >= 1 && records[0].messages.length === 2));
  it("confidence is high for tabs schema", () => assert.equal(records[0].meta.recognition_confidence, "high"));
});

describe("normalizeAll — Markdown structured", () => {
  const content = `## User\n\nHow do I optimize this?\n\n## Assistant\n\nUse memoization.\n`;
  const raw = [{ path: "/fake/.claude/conversation.md", content, mtime: Date.now(), size: content.length }];
  const records = normalizeAll(raw);
  it("extracts two messages from markdown sections", () => {
    assert.ok(records.length >= 1);
    assert.equal(records[0].messages.length, 2);
    assert.equal(records[0].messages[0].role, "user");
    assert.equal(records[0].messages[1].role, "assistant");
  });
});

describe("normalizeAll — health warnings", () => {
  const raw = [{
    path: "/fake/cursor/history.json",
    content: JSON.stringify({ messages: [{ role: "user", content: "" }, { role: "assistant", content: "ok" }] }),
    mtime: Date.now(), size: 50,
  }];
  const records = normalizeAll(raw);
  it("adds warning for empty content", () => {
    assert.ok(records.length >= 1);
    assert.ok(records[0].meta.warnings?.some(w => w.includes("empty content")));
  });
});

describe("normalizeAll — regression for non-string content", () => {
  const raw = [{
    path: "/fake/cursor/composer.json",
    content: JSON.stringify({
      composerData: {
        conversation: [
          {
            role: "user",
            content: [{ type: "text", text: "Complex content" }] // Array content!
          }
        ]
      }
    }),
    mtime: Date.now(), size: 100,
  }];
  
  it("does not crash and stringifies content", () => {
    const records = normalizeAll(raw);
    assert.ok(records.length >= 1);
    assert.equal(typeof records[0].messages[0].content, "string");
    assert.ok(records[0].messages[0].content.includes("Complex content"));
  });
});

// ── Regression: schema meta.source enum must never drift from ALLOWED_SOURCES ──
describe("schema-validator source enum alignment", () => {
  const schemaSources = new Set(THREAD_SCHEMA.properties.meta.properties.source.enum);

  it("every ALLOWED_SOURCES value is accepted by the schema (no drift)", () => {
    for (const src of ALLOWED_SOURCES) {
      const rec = {
        schema_version: "1.0.0",
        thread_id: "t",
        type: "thread",
        messages: [{ role: "user", content: "hi" }],
        meta: { source: src, project: "p", created_at: new Date().toISOString() },
      };
      const { valid, errors } = validateThread(rec);
      assert.ok(valid, `source '${src}' should validate; errors: ${errors.join("; ")}`);
    }
  });

  it("schema enum contains exactly ALLOWED_SOURCES (no extras, no missing)", () => {
    assert.deepEqual([...schemaSources].sort(), [...ALLOWED_SOURCES].sort());
  });
});

// ── Regression: cursor_sqlite Claude vscdb must map to claude_code (not 'claude') ──
describe("conformThreadRecord — shapes seen in real Forge exports", () => {
  it("accepts string file paths and drops confidence medium", () => {
    const record = conformThreadRecord({
      schema_version: "1.0.0",
      thread_id: "t",
      type: "thread",
      messages: [{ role: "user", content: "hello", timestamp: 1700000000 }],
      context: { files: ["docs/report.md"], diffs: [] },
      meta: {
        source: "forge",
        project: "p",
        created_at: new Date().toISOString(),
        recognition_confidence: "medium",
        tokens: 1.2,
      },
    });
    assert.equal(record.meta.recognition_confidence, "low");
    assert.equal(record.meta.tokens, 1);
    assert.deepEqual(record.context.files, [{ path: "docs/report.md" }]);
    assert.equal(typeof record.messages[0].timestamp, "string");
    const { valid, errors } = validateThread(record);
    assert.ok(valid, errors.join("; "));
  });
});

describe("extractEvidence reads structured tool calls", () => {
  it("counts meta.kind tool_use and forge tool_calls without shell text", () => {
    const evidence = extractEvidence([
      { role: "user", content: "please look" },
      { role: "assistant", content: "calling", meta: { kind: "tool_use", name: "grep" } },
      { role: "assistant", content: "done", tool_calls: [{ name: "read_file" }] },
      { role: "tool", name: "write", content: "wrote file" },
    ]);
    assert.ok(evidence.raw.hasToolCall);
    assert.ok(evidence.raw.toolCalls.includes("grep"));
    assert.ok(evidence.raw.toolCalls.includes("read_file"));
    assert.ok(evidence.raw.toolCalls.includes("write"));
  });
});

describe("cursor_sqlite inferSourceFromVscdbPath", () => {
  it("Claude workspaceStorage → claude_code (in ALLOWED_SOURCES + schema)", () => {
    const src = inferSourceFromVscdbPath(
      "/Users/u/Library/Application Support/Claude/User/workspaceStorage/hash/state.vscdb"
    );
    assert.equal(src, "claude_code");
    assert.ok(ALLOWED_SOURCES.has(src));
    assert.ok(THREAD_SCHEMA.properties.meta.properties.source.enum.includes(src));
  });

  it("Cursor / Trae CN paths stay in allowed set", () => {
    for (const p of [
      "/Users/u/Library/Application Support/Cursor/User/workspaceStorage/h/state.vscdb",
      "/Users/u/Library/Application Support/Trae CN/User/workspaceStorage/h/state.vscdb",
    ]) {
      const src = inferSourceFromVscdbPath(p);
      assert.ok(ALLOWED_SOURCES.has(src), `${p} -> ${src} not in ALLOWED_SOURCES`);
    }
  });
});
