/**
 * Unit tests for core/normalize.js
 * Run: node --test tests/unit/normalize.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAll, identifyType, normalizeMetaSource } from "../../core/normalize.js";

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
  it("maps 'zed' → unknown",        () => assert.equal(normalizeMetaSource("zed"), "unknown"));
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
