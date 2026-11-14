/**
 * Integration / live backtest for WorkBuddy, Claude integrity,
 * export state, and Cursor CLI.
 * Default: fixtures only (CI-safe).
 * Real HOME data: AEX_LIVE_BACKTEST=1 node --test tests/integration/p0-p1-backtest.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAll, resetWorkBuddyMetaCache } from "../../core/normalize.js";
import { validateThread, conformThreadRecord } from "../../core/schema-validator.js";
import { mineEpisodes } from "../../core/t2e/mine.js";
import { workbuddyDefaultRoots, loadWorkBuddyMeta } from "../../core/workbuddy.js";
import { detectClaudeTruncation } from "../../core/claude_integrity.js";
import { collectCursorCliRecords } from "../../core/cursor_cli.js";
import {
  exportStatePath,
  loadExportState,
  saveExportState,
  rememberSourceFile,
  shouldSkipSourceFile,
} from "../../core/export-state.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const LIVE = process.env.AEX_LIVE_BACKTEST === "1";

describe("P0/P1 fixture integration", () => {
  it("WorkBuddy fixture → schema valid → mine keeps tools without tool-result prompts", async () => {
    resetWorkBuddyMetaCache();
    const body = fs.readFileSync(path.join(fixtures, "workbuddy-session.jsonl"), "utf8");
    const records = normalizeAll([{
      path: "/Users/demo/.workbuddy/projects/demo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
      content: body,
      mtime: Date.now(),
      size: body.length,
    }]).map(conformThreadRecord);
    assert.equal(records.length, 1);
    assert.equal(validateThread(records[0]).valid, true);
    const episodes = await mineEpisodes(records);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].prompt.startsWith("[Tool"), false);
    assert.equal(episodes[0].evidence.raw.hasToolCall, true);
  });

  it("Claude truncated fixture carries integrity extra", () => {
    const body = fs.readFileSync(path.join(fixtures, "claude-truncated.jsonl"), "utf8");
    const det = detectClaudeTruncation(body);
    assert.ok(det.signals.length >= 2);
    const records = normalizeAll([{
      path: "/Users/demo/.claude/projects/x/session.jsonl",
      content: body,
      mtime: Date.now(),
      size: body.length,
    }]);
    assert.ok(records.some((r) => r.meta?.extra?.transcript_truncated === true));
  });

  it("export state skips unchanged file when outputs exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aex-int-state-"));
    const rel = "workbuddy/x.json";
    fs.mkdirSync(path.join(dir, "workbuddy"), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "{}");
    const state = loadExportState(exportStatePath(dir));
    rememberSourceFile(state, "/src/a.jsonl", { mtime_ms: 42, thread_ids: ["t"], outputs: [rel] });
    saveExportState(state, exportStatePath(dir));
    assert.equal(shouldSkipSourceFile(loadExportState(exportStatePath(dir)), "/src/a.jsonl", 42, dir), true);
  });
});

describe("P0/P1 live HOME backtest", { skip: !LIVE }, () => {
  it("normalizes real WorkBuddy project sessions when present", async () => {
    resetWorkBuddyMetaCache();
    const roots = workbuddyDefaultRoots();
    const dbPath = roots.dbPaths.find((p) => fs.existsSync(p));
    const meta = dbPath ? loadWorkBuddyMeta(dbPath) : null;
    const files = [];
    for (const root of roots.projectDirs) {
      if (!fs.existsSync(root)) continue;
      for (const proj of fs.readdirSync(root)) {
        const pd = path.join(root, proj);
        if (!fs.statSync(pd).isDirectory()) continue;
        for (const name of fs.readdirSync(pd)) {
          if (name.endsWith(".jsonl")) files.push(path.join(pd, name));
        }
      }
    }
    if (files.length === 0) {
      assert.ok(true, "no live WorkBuddy sessions — skipped body");
      return;
    }
    const raw = files.map((f) => ({
      path: f,
      content: fs.readFileSync(f, "utf8"),
      mtime: fs.statSync(f).mtimeMs,
      size: fs.statSync(f).size,
    }));
    const records = normalizeAll(raw).map(conformThreadRecord);
    assert.equal(records.every((r) => validateThread(r).valid), true);
    assert.ok(records.every((r) => r.meta.source === "workbuddy"));
    assert.ok(records.some((r) => r.meta.recognition_confidence === "high"));
    const mined = await mineEpisodes(records);
    assert.equal(mined.filter((e) => e.prompt.startsWith("[Tool Result]")).length, 0);
    assert.ok(mined.length > 0);
    if (meta) assert.ok(meta.size > 0);
  });

  it("reports Cursor CLI live count without throwing", () => {
    const records = collectCursorCliRecords();
    assert.ok(Array.isArray(records));
    for (const r of records) {
      assert.equal(r.meta.source, "cursor_cli");
      assert.equal(validateThread(conformThreadRecord(r)).valid, true);
    }
  });
});
