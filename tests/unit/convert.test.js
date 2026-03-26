/**
 * Unit tests for core/convert.js
 * Run: node --test tests/unit/convert.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toTrainingJsonl, toMarkdown, computeStats } from "../../core/convert.js";

const FIXTURE = {
  schema_version: "1.0.0",
  thread_id: "abc123",
  type: "thread",
  messages: [
    { role: "user",      content: "How do I write a binary search?" },
    { role: "assistant", content: "Here is a binary search implementation..." },
    { role: "user",      content: "Can you add tests?" },
    { role: "assistant", content: "Sure, here are the tests..." },
  ],
  context: { files: [], diffs: [] },
  meta: { source: "cursor", project: "my-app", created_at: "2025-01-15T10:00:00Z", tokens: 200, prompt: "Binary search", recognition_confidence: "high" },
};

describe("toTrainingJsonl — SFT style", () => {
  const output = toTrainingJsonl([FIXTURE], { style: "sft" });
  const lines = output.split("\n").filter(Boolean).map(l => JSON.parse(l));

  it("produces 2 pairs (2 user→assistant turns)", () => assert.equal(lines.length, 2));
  it("has instruction field", () => assert.ok(lines[0].instruction.length > 0));
  it("has output field", () => assert.ok(lines[0].output.length > 0));
  it("has empty input field", () => assert.equal(lines[0].input, ""));
  it("deduplicates identical content", () => {
    const twice = toTrainingJsonl([FIXTURE, FIXTURE], { style: "sft", dedupe: true });
    assert.equal(twice.split("\n").filter(Boolean).length, 2);
  });
});

describe("toTrainingJsonl — ShareGPT style", () => {
  const output = toTrainingJsonl([FIXTURE], { style: "sharegpt" });
  const lines = output.split("\n").filter(Boolean).map(l => JSON.parse(l));
  it("produces 1 entry", () => assert.equal(lines.length, 1));
  it("has conversations array", () => assert.ok(Array.isArray(lines[0].conversations)));
  it("first conversation is from human", () => assert.equal(lines[0].conversations[0].from, "human"));
  it("id is thread_id", () => assert.equal(lines[0].id, "abc123"));
});

describe("toMarkdown", () => {
  const md = toMarkdown(FIXTURE);
  it("contains thread title", () => assert.ok(md.includes("Binary search")));
  it("contains ## User section", () => assert.ok(md.includes("## User")));
  it("contains ## Assistant section", () => assert.ok(md.includes("## Assistant")));
});

describe("computeStats", () => {
  const records = [FIXTURE, { ...FIXTURE, meta: { ...FIXTURE.meta, source: "claude_code", project: "other-app" } }];
  const stats = computeStats(records, ["source"]);

  it("total_records is 2", () => assert.equal(stats.total_records, 2));
  it("has 2 groups", () => assert.equal(stats.groups.length, 2));
  it("each group has threads count", () => assert.ok(stats.groups.every(g => g.threads >= 1)));
  it("total_tokens > 0", () => assert.ok(stats.total_tokens > 0));
});
