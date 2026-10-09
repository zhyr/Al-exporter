/**
 * Synthetic fixtures for session split, tool use, runtime logs, and new IDE sources.
 * Run: node --test tests/unit/platform-parse.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAll, ALLOWED_SOURCES } from "../../core/normalize.js";
import { validateThread } from "../../core/schema-validator.js";
import { detectTool, ideScanRelativeDirs, vscdbWorkspaceAbsPaths } from "../../core/utils.js";
import { inferSourceFromVscdbPath } from "../../core/cursor_sqlite.js";
import { mineEpisodes } from "../../core/t2e/mine.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

function raw(filePath, content) {
  return [{ path: filePath, content, mtime: Date.now(), size: content.length }];
}

describe("new IDE source ids", () => {
  it("maps Trae Work paths to traework and Trae CN to trae", () => {
    assert.equal(detectTool("/Users/u/.traework/workspaces/ws1/history.jsonl"), "traework");
    assert.equal(detectTool("/Users/u/.trae-work/sessions/a.json"), "traework");
    assert.equal(detectTool("/Users/u/Library/Application Support/Trae Work CN/User/workspaceStorage/h/state.vscdb"), "traework");
    assert.equal(detectTool("/Users/u/Library/Application Support/Trae CN/User/workspaceStorage/h/state.vscdb"), "trae");
    assert.equal(inferSourceFromVscdbPath("/Users/u/Library/Application Support/Trae Work/User/workspaceStorage/h/state.vscdb"), "traework");
    assert.equal(inferSourceFromVscdbPath("/Users/u/Library/Application Support/Trae CN/User/workspaceStorage/h/state.vscdb"), "trae");
    assert.ok(ALLOWED_SOURCES.has("traework"));
  });

  it("keeps WorkBuddy ahead of CodeBuddy and ZCode off generic code", () => {
    assert.equal(detectTool("/Users/u/Library/Application Support/WorkBuddy CN/User/globalStorage/state.vscdb"), "workbuddy");
    assert.equal(detectTool("/Users/u/Library/Application Support/CodeBuddy CN/User/History/a.json"), "codebuddy");
    assert.equal(detectTool("/Users/u/Library/Application Support/ZCode/User/workspaceStorage/h/state.vscdb"), "zcode");
  });

  it("lists CN and Trae Work dirs on linux and windows", () => {
    const linux = ideScanRelativeDirs("linux").join("\n");
    assert.match(linux, /CodeBuddy CN/);
    assert.match(linux, /WorkBuddy CN/);
    assert.match(linux, /Trae CN/);
    assert.match(linux, /\.traework/);
    const win = vscdbWorkspaceAbsPaths("win32", "C:/Users/u", "C:/Users/u/AppData/Roaming");
    assert.ok(win.some((p) => p.includes("Trae Work")));
    assert.ok(win.some((p) => p.includes("CodeBuddy CN")));
    assert.ok(win.some((p) => p.includes("ZCode")));
  });
});

describe("session, tool use, and runtime log", () => {
  const body = fs.readFileSync(path.join(fixtures, "two-sessions.json"), "utf8");
  const filePath = "/fake/.codebuddy/sessions/two-sessions.json";
  const records = normalizeAll(raw(filePath, body));

  it("splits one file into two threads and leaves a session-less file on the path hash", () => {
    assert.equal(records.length, 2);
    assert.notEqual(records[0].thread_id, records[1].thread_id);
    assert.equal(records[0].meta.extra.session_id, "s1");
    assert.equal(records[1].meta.extra.session_id, "s2");
    assert.equal(records[0].meta.source, "codebuddy");
    const plain = normalizeAll(raw("/fake/.zcode/history.json", JSON.stringify({
      messages: [{ role: "user", content: "only one thread" }, { role: "assistant", content: "ok" }],
    })));
    const again = normalizeAll(raw("/fake/.zcode/history.json", JSON.stringify({
      messages: [{ role: "user", content: "only one thread" }, { role: "assistant", content: "ok" }],
    })));
    assert.equal(plain.length, 1);
    assert.equal(plain[0].thread_id, again[0].thread_id);
    assert.equal(plain[0].meta.extra, undefined);
  });

  it("splits tool_use blocks into messages with meta.kind", () => {
    const tool = records[1].messages.find((m) => m.meta?.kind === "tool_use");
    const result = records[1].messages.find((m) => m.meta?.kind === "tool_result");
    assert.ok(tool);
    assert.equal(tool.meta.name, "grep");
    assert.match(tool.content, /\[Tool Use\] grep/);
    assert.equal(typeof tool.content, "string");
    assert.ok(result);
    assert.match(result.content, /found session/);
    const { valid, errors } = validateThread(records[1]);
    assert.ok(valid, errors.join("; "));
  });

  it("keeps chat when the path looks like a log", () => {
    const chatLog = normalizeAll(raw("/fake/.workbuddy/run.log", JSON.stringify({
      messages: [{ role: "user", content: "hello from log path" }, { role: "assistant", content: "hi" }],
    })));
    assert.equal(chatLog.length, 1);
    assert.equal(chatLog[0].type, "thread");
    assert.equal(chatLog[0].meta.extra, undefined);
  });

  it("stores runtime logs as type log and mineEpisodes skips them", async () => {
    const logBody = fs.readFileSync(path.join(fixtures, "runtime-log.jsonl"), "utf8");
    const logs = normalizeAll(raw("/fake/.trae/run.log", logBody));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].type, "log");
    assert.equal(logs[0].meta.source, "trae");
    assert.equal(logs[0].meta.extra.kind, "runtime_log");
    assert.equal(logs[0].messages.length, 2);
    assert.equal(logs[0].messages[0].role, "system");
    assert.match(logs[0].messages[0].content, /trace_id=tr-1/);
    const { valid, errors } = validateThread(logs[0]);
    assert.ok(valid, errors.join("; "));
    const episodes = await mineEpisodes(logs);
    assert.equal(episodes.length, 0);
  });

  it("reads WorkBuddy startup lines that start with a timestamp", async () => {
    const body = [
      '[2026-10-08T21:03:32.222Z] {"_type":"mark","epochMs":10,"phase":"boot"}',
      '[2026-10-08T21:03:32.300Z] {"_type":"summary","totalDurationMs":80,"totalMarks":1}',
    ].join("\n");
    const logs = normalizeAll(raw("/Users/u/.workbuddy/logs/startup/2026-10-09/22954-050332.jsonl", body));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].type, "log");
    assert.equal(logs[0].meta.source, "workbuddy");
    assert.match(logs[0].messages[0].content, /boot epochMs=10/);
    assert.match(logs[0].messages[1].content, /totalDurationMs=80/);
    const episodes = await mineEpisodes(logs);
    assert.equal(episodes.length, 0);
  });

  it("mines agent records that contain a user turn", async () => {
    const agent = normalizeAll(raw("/fake/.codebuddy/agent/chat.json", JSON.stringify({
      messages: [
        { role: "user", content: "explain this function" },
        { role: "assistant", content: "it returns the sum" },
      ],
    })));
    assert.equal(agent[0].type, "agent");
    const episodes = await mineEpisodes(agent);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].prompt, "explain this function");
  });
});
