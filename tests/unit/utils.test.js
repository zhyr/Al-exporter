/**
 * Unit tests for core/utils.js
 * Run: node --test tests/unit/utils.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectTool, detectByMagic, isInterestingFile } from "../../core/utils.js";

describe("detectTool", () => {
  it("maps cursor paths", () => assert.equal(detectTool("/home/user/.cursor/tasks/foo.json"), "cursor"));
  it("maps claude code paths", () => assert.equal(detectTool("/home/user/.claude/history.json"), "claude_code"));
  it("maps codex paths", () => assert.equal(detectTool("/home/user/.openai/session.json"), "codex"));
  it("maps qoder paths", () => assert.equal(detectTool("/home/user/.qcoder/chat.jsonl"), "qoder"));
  it("maps windsurf paths", () => assert.equal(detectTool("/home/user/.windsurf/conv.json"), "windsurf"));
  it("maps augment paths", () => assert.equal(detectTool("/home/user/.augment/history.json"), "augment"));
  it("returns unknown for unrecognised paths", () => assert.equal(detectTool("/tmp/random.json"), "unknown"));
  it("cursor beats vscode (Cursor IS vscode-based)", () => assert.equal(detectTool("/User/Library/Application Support/Cursor/User/workspace"), "cursor"));
});

describe("detectByMagic", () => {
  it("detects JSON object", () => assert.equal(detectByMagic('{"a":1}'), "json"));
  it("detects JSON array", () => assert.equal(detectByMagic('[{"role":"user"}]'), "json-array"));
  it("detects markdown", () => assert.equal(detectByMagic("# Title\nsome text"), "markdown"));
  it("detects yaml frontmatter", () => assert.equal(detectByMagic("---\nname: foo\n---"), "yaml-or-markdown"));
  it("returns text for plain content", () => assert.equal(detectByMagic("hello world"), "text"));
  it("handles empty string", () => assert.equal(detectByMagic(""), "unknown"));
});

describe("isInterestingFile", () => {
  it("accepts history json", () => assert.equal(isInterestingFile("/path/to/history.json"), true));
  it("accepts cursorrules", () => assert.equal(isInterestingFile("/path/.cursorrules"), true));
  it("rejects .map files", () => assert.equal(isInterestingFile("/path/app.js.map"), false));
  it("rejects package.json", () => assert.equal(isInterestingFile("/path/package.json"), false));
  it("rejects node_modules", () => assert.equal(isInterestingFile("/node_modules/lib/index.json"), false));
  it("rejects .js files", () => assert.equal(isInterestingFile("/path/app.js"), false));
  it("accepts .md chat history", () => assert.equal(isInterestingFile("/path/.aider.chat.history.md"), true));
  it("uses header hint for JSON: rejects without keywords", () => assert.equal(isInterestingFile("/path/settings.json", '{"version":1,"theme":"dark"}'), false));
  it("uses header hint for JSON: accepts with keywords", () => assert.equal(isInterestingFile("/path/session.json", '{"messages":[{"role":"user"}]}'), true));
});
