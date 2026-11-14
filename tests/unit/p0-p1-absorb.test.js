/**
 * WorkBuddy parse, injection cleaning, Claude integrity,
 * export state, and Cursor CLI source tests.
 * Run: node --test tests/unit/p0-p1-absorb.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { cleanInjectedUserText } from "../../core/content.js";
import { normalizeAll, resetWorkBuddyMetaCache, ALLOWED_SOURCES } from "../../core/normalize.js";
import { validateThread } from "../../core/schema-validator.js";
import { detectTool } from "../../core/utils.js";
import { detectClaudeTruncation } from "../../core/claude_integrity.js";
import {
  loadExportState,
  saveExportState,
  shouldSkipSourceFile,
  rememberSourceFile,
  exportStatePath,
} from "../../core/export-state.js";
import { parseCursorCliStore, collectCursorCliRecords } from "../../core/cursor_cli.js";
import { parseWorkBuddyJsonl, pathLooksLikeWorkBuddySession } from "../../core/workbuddy.js";
import { mineEpisodes } from "../../core/t2e/mine.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

function raw(filePath, content) {
  return [{ path: filePath, content, mtime: Date.now(), size: content.length }];
}

describe("P0 injection cleaning", () => {
  it("extracts user_query and drops system-reminder", () => {
    const text = `<system-reminder data-role="user-context">
<user_info>OS</user_info>
</system-reminder>
<user_query>
分析这只股票
</user_query>`;
    assert.equal(cleanInjectedUserText(text), "分析这只股票");
  });

  it("leaves plain user text alone", () => {
    assert.equal(cleanInjectedUserText("hello world"), "hello world");
  });
});

describe("P0 WorkBuddy session parse", () => {
  it("detects workbuddy project session paths", () => {
    assert.equal(
      pathLooksLikeWorkBuddySession("/Users/u/.workbuddy/projects/proj/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
      true,
    );
    assert.equal(
      pathLooksLikeWorkBuddySession("/Users/u/.workbuddy-ai/projects/proj/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
      true,
    );
    assert.equal(pathLooksLikeWorkBuddySession("/Users/u/.workbuddy/logs/startup.jsonl"), false);
  });

  it("parses fixture into cleaned user + tool + assistant", () => {
    const body = fs.readFileSync(path.join(fixtures, "workbuddy-session.jsonl"), "utf8");
    const parsed = parseWorkBuddyJsonl(
      body,
      "/Users/u/.workbuddy/projects/demo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    );
    assert.ok(parsed);
    assert.equal(parsed.confidence, "high");
    assert.equal(parsed.prompt, "请对这只股票做深度基本面分析");
    assert.ok(parsed.messages.some((m) => m.role === "user" && m.content === "请对这只股票做深度基本面分析"));
    assert.ok(parsed.messages.some((m) => m.meta?.kind === "tool_use" && m.meta.name === "search"));
    assert.ok(parsed.messages.some((m) => m.meta?.kind === "tool_result"));
    assert.ok(parsed.messages.some((m) => m.role === "assistant" && m.model === "deepseek-v4.1-flash"));
  });

  it("normalizes WorkBuddy path to high-confidence thread and mines it", async () => {
    resetWorkBuddyMetaCache();
    const body = fs.readFileSync(path.join(fixtures, "workbuddy-session.jsonl"), "utf8");
    const records = normalizeAll(raw(
      "/Users/demo/.workbuddy/projects/demo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
      body,
    ));
    assert.equal(records.length, 1);
    assert.equal(records[0].meta.source, "workbuddy");
    assert.equal(records[0].meta.recognition_confidence, "high");
    assert.equal(records[0].meta.extra?.session_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.ok(!records[0].messages.some((m) => String(m.content).includes("<system-reminder")));
    const { valid, errors } = validateThread(records[0]);
    assert.ok(valid, errors.join("; "));
    const episodes = await mineEpisodes(records);
    assert.equal(episodes.length, 1);
    assert.ok(episodes.some((ep) => ep.prompt === "请对这只股票做深度基本面分析"));
    assert.ok(episodes.some((ep) => ep.evidence.raw.hasToolCall));
  });
});

describe("P1 Claude truncation signals", () => {
  it("flags parent_uuid_missing and continuation summary", () => {
    const body = fs.readFileSync(path.join(fixtures, "claude-truncated.jsonl"), "utf8");
    const result = detectClaudeTruncation(body);
    assert.ok(result.signals.includes("parent_uuid_missing"));
    assert.ok(result.signals.includes("starts_with_continuation_summary"));
  });

  it("attaches meta.extra on Claude transcript normalize", () => {
    const body = fs.readFileSync(path.join(fixtures, "claude-truncated.jsonl"), "utf8");
    const records = normalizeAll(raw(
      "/Users/demo/.claude/projects/demo/session.jsonl",
      body,
    ));
    assert.ok(records.length >= 1);
    const hit = records.find((r) => r.meta?.extra?.transcript_truncated);
    assert.ok(hit, "expected truncated flag");
    assert.ok(Array.isArray(hit.meta.extra.truncation_signals));
    assert.ok(hit.meta.warnings?.some((w) => /truncated/.test(w)));
  });
});

describe("P1 export state cursor", () => {
  it("skips unchanged source when outputs exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aex-state-"));
    const outRel = "workbuddy/demo.json";
    fs.mkdirSync(path.join(dir, "workbuddy"), { recursive: true });
    fs.writeFileSync(path.join(dir, outRel), "{}");
    const stateFile = exportStatePath(dir);
    const state = loadExportState(stateFile);
    rememberSourceFile(state, "/src/a.jsonl", {
      mtime_ms: 100,
      thread_ids: ["t1"],
      outputs: [outRel],
    });
    saveExportState(state, stateFile);
    const again = loadExportState(stateFile);
    assert.equal(shouldSkipSourceFile(again, "/src/a.jsonl", 100, dir), true);
    assert.equal(shouldSkipSourceFile(again, "/src/a.jsonl", 101, dir), false);
  });
});

describe("P1 Cursor CLI source", () => {
  it("maps chats path to cursor_cli and allows source enum", () => {
    assert.equal(detectTool("/Users/u/.cursor/chats/abc/def/store.db"), "cursor_cli");
    assert.ok(ALLOWED_SOURCES.has("cursor_cli"));
  });

  it("parses a minimal store.db fixture with user_query blob", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aex-cli-"));
    const ws = path.join(dir, "workspacehash");
    const sess = path.join(ws, "11111111-2222-3333-4444-555555555555");
    fs.mkdirSync(sess, { recursive: true });
    const store = path.join(sess, "store.db");
    const db = new Database(store);
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    const blob = Buffer.from("<user_query>fix the flaky test</user_query>\nOK I will look at it.", "utf8");
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run("b1", blob);
    db.close();
    fs.writeFileSync(path.join(sess, "meta.json"), JSON.stringify({
      createdAtMs: 1700000000000,
      cwd: "/Users/demo/app",
    }));

    const parsed = parseCursorCliStore(store);
    assert.ok(parsed.messages.some((m) => m.role === "user" && m.content.includes("flaky test")));
    const records = collectCursorCliRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].meta.source, "cursor_cli");
    const { valid, errors } = validateThread(records[0]);
    assert.ok(valid, errors.join("; "));
  });
});
