import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  attachThreadFiles,
  collectCursorGlobalRecords,
  CURSOR_RAW_DIR,
  CURSOR_ARTIFACT_DIR,
  writeCursorAudit,
  writeCursorIndex,
} from "../../core/cursor_global.js";
import { conformThreadRecord } from "../../core/schema-validator.js";

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function createModernCursorDb(dbPath) {
  fs.ensureDirSync(path.dirname(dbPath));
  fs.removeSync(dbPath);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      isSubagent INTEGER,
      checkpointAt INTEGER,
      subagentTypeName TEXT,
      value TEXT
    );
  `);
  const now = Date.UTC(2025, 0, 2, 3, 4, 5);
  const insertHeader = db.prepare("INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, checkpointAt, subagentTypeName, value) VALUES (?,?,?,?,?,?,?,?,?)");
  insertHeader.run("composer-main", "ws-1", now, now + 60_000, 0, 0, null, null, JSON.stringify({
    composerId: "composer-main",
    name: "Modern composer",
    modelConfig: { modelName: "claude-4-sonnet" },
    workspaceIdentifier: { id: "ws-1" },
  }));

  const insertKv = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  insertKv.run("composerData:composer-main", Buffer.from(JSON.stringify({
    composerId: "composer-main",
    name: "Modern composer",
    createdAt: now,
    lastUpdatedAt: now + 60_000,
    fullConversationHeadersOnly: [
      { bubbleId: "b1", type: 1, createdAt: now + 1000 },
      { bubbleId: "b2", type: 2, createdAt: now + 2000 },
      { bubbleId: "b3", type: 2, createdAt: now + 3000 },
      { bubbleId: "b4-missing", type: 2, createdAt: now + 4000 },
    ],
    conversationMap: {
      b2: {
        type: 2,
        text: "from conversationMap",
        thinking: { text: "deep thought" },
        toolFormerData: {
          tool: "read_file",
          callId: "call-1",
          status: "completed",
          params: JSON.stringify({ path: "/tmp/a.js" }),
          result: "file body",
        },
        codeBlocks: [{ uri: "file:///tmp/a.js", content: "const a = 1;" }],
        createdAt: now + 2000,
      },
    },
  })));
  insertKv.run("bubbleId:composer-main:b1", Buffer.from(JSON.stringify({
    type: 1,
    text: "hello modern cursor",
    createdAt: now + 1000,
  })));
  insertKv.run("bubbleId:composer-main:b3", Buffer.from(JSON.stringify({
    type: 2,
    text: "final answer",
    createdAt: now + 3000,
  })));

  // Subagent composer without a header row (task- prefix + parent info).
  insertKv.run("composerData:task-child-1", Buffer.from(JSON.stringify({
    composerId: "task-child-1",
    createdAt: now + 5000,
    lastUpdatedAt: now + 9000,
    subagentInfo: { parentComposerId: "composer-main", typeName: "explore" },
    fullConversationHeadersOnly: [{ bubbleId: "c1", type: 1, createdAt: now + 5000 }],
  })));
  insertKv.run("bubbleId:task-child-1:c1", Buffer.from(JSON.stringify({
    type: 1,
    text: "child task prompt",
    createdAt: now + 5000,
  })));

  // Header-only composer (no composerData) should still be indexed.
  insertHeader.run("composer-header-only", "ws-1", now + 7000, now + 8000, 0, 0, null, null, JSON.stringify({ name: "Header only" }));

  // Orphan bubble for an unknown composer.
  insertKv.run("bubbleId:ghost:b1", Buffer.from(JSON.stringify({ type: 1, text: "ghost" })));

  // Checkpoint + artifact payloads.
  insertKv.run("agentKv:bubbleCheckpoint:composer-main:b1", Buffer.from(JSON.stringify({ step: 1 })));
  insertKv.run("agentKv:artifact:composer-main:artifact-1", Buffer.from([0, 1, 2, 3, 4]));
  db.close();
}

test("modern Cursor reader parses cursorDiskKV, index, audit and sidecars", async (t) => {
  const dir = await makeTempDir("aex-cursor-global-test-");
  t.after(() => fs.remove(dir).catch(() => {}));
  const dbPath = path.join(dir, "state.vscdb");
  const out = path.join(dir, "out");
  createModernCursorDb(dbPath);

  // Simulate a pending WAL so the snapshot path is exercised end-to-end: keep
  // the writer open and disable checkpointing while the reader snapshots.
  const walDb = new Database(dbPath);
  walDb.pragma("journal_mode = WAL");
  walDb.pragma("wal_autocheckpoint = 0");
  walDb.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
    .run("bubbleId:composer-main:b-wal", Buffer.from(JSON.stringify({ type: 2, text: "written via wal" })));
  t.after(() => { try { walDb.close(); } catch { /* ignore */ } });

  const summary = await collectCursorGlobalRecords({
    dbPath,
    outputDir: out,
    persistRaw: true,
    persistArtifacts: true,
    includeTranscripts: false,
  });

  assert.equal(summary.skipped, null);
  assert.equal(summary.index.length, 3, "main + subagent + header-only composers");
  assert.ok(summary.audit.schema.has_cursor_disk_kv);

  const main = summary.records.find((r) => r.session.native_id === "composer-main");
  assert.ok(main, "main composer exported");
  assert.equal(main.meta.source, "cursor");
  assert.equal(main.messages[0].role, "user");
  assert.equal(main.messages[0].content, "hello modern cursor");
  // Conversation-map fallback body, thinking and tool call/result are preserved.
  assert.ok(main.messages.some((m) => m.content === "from conversationMap"));
  assert.ok(main.messages.some((m) => m.meta?.cursor?.thinking === "deep thought"));
  assert.ok(main.messages.some((m) => m.tool_call?.phase === "call" && m.tool_call?.name === "read_file"));
  assert.ok(main.messages.some((m) => m.tool_call?.phase === "result" && m.content.includes("file body")));
  // Bubble ordering follows fullConversationHeadersOnly (b3 before WAL fallback).
  const contents = main.messages.map((m) => m.content);
  assert.ok(contents.indexOf("hello modern cursor") < contents.indexOf("from conversationMap"));
  assert.ok(contents.indexOf("from conversationMap") < contents.indexOf("final answer"));
  assert.ok(main.context.files.some((f) => f.path === "/tmp/a.js"));
  assert.equal(main.meta.model, "claude-4-sonnet");
  assert.equal(main.meta.extra.cursor.missing_ordered_bubbles, 1, "only b4-missing is absent from both bubble rows and conversationMap");
  assert.ok(contents.includes("written via wal"), "WAL-resident bubble is included in the snapshot");

  const child = summary.records.find((r) => r.session.native_id === "task-child-1");
  assert.ok(child);
  assert.equal(child.session.native_id_kind, "composer_subagent");
  assert.equal(child.meta.extra.cursor.parent_composer_id, "composer-main");

  const mainEntry = summary.index.find((e) => e.composer_id === "composer-main");
  assert.equal(mainEntry.status, "exported");
  assert.equal(mainEntry.header_present, true);
  assert.equal(mainEntry.composer_data_present, true);
  assert.ok(mainEntry.tool_calls >= 1);
  assert.ok(mainEntry.missing_bubble_ids_sample.includes("b4-missing"));

  const headerOnly = summary.index.find((e) => e.composer_id === "composer-header-only");
  assert.equal(headerOnly.status, "header_only");
  assert.equal(headerOnly.composer_data_present, false);

  const childEntry = summary.index.find((e) => e.composer_id === "task-child-1");
  assert.equal(childEntry.is_subagent, true);
  assert.equal(childEntry.header_present, false);

  assert.equal(summary.audit.counts.composer_headers, 2);
  assert.equal(summary.audit.counts.composer_data_rows, 2);
  assert.equal(summary.audit.counts.orphan_bubble_rows, 1);
  assert.equal(summary.audit.counts.composer_data_without_header, 1);
  assert.equal(summary.audit.counts.headers_without_composer_data, 1);
  assert.ok(summary.audit.counts.messages_total >= 6);
  assert.ok(summary.audit.namespaces.some((n) => n.namespace === "bubbleId"));
  assert.ok(summary.audit.namespaces.some((n) => n.namespace === "agentKv"));
  assert.ok(summary.audit.source_hashes.db.sha256, "source db hash recorded");

  // Raw sidecar keeps the original key + payload.
  const rawPath = path.join(out, CURSOR_RAW_DIR, "composer-main", "bubbles.jsonl");
  assert.ok(await fs.pathExists(rawPath));
  const rawLines = (await fs.readFile(rawPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rawLines.every((l) => l.key.startsWith("bubbleId:composer-main:")));
  assert.ok(rawLines.some((l) => l.value.includes("hello modern cursor")));

  // agentKv artifact persisted byte-for-byte.
  const artifactEntry = mainEntry.artifacts;
  assert.ok(artifactEntry);
  assert.ok(artifactEntry.artifact_count >= 1);
  const artifactFile = artifactEntry.files.find((f) => f.key.includes("artifact-1"));
  assert.ok(artifactFile, "artifact file recorded in index");
  const artifactBytes = await fs.readFile(path.join(out, artifactFile.file));
  assert.deepEqual([...artifactBytes], [0, 1, 2, 3, 4]);

  // Records stay schema-conformant after interop finalization-like pass.
  for (const record of summary.records) {
    conformThreadRecord(record);
    assert.equal(record.meta.source, "cursor");
    assert.ok(record.schema_version);
  }

  // Index/audit writers + manifest attachment.
  attachThreadFiles(summary.index, [
    { thread_id: main.thread_id, file: "cursor/main-hash.json", hash: "abc123" },
  ]);
  assert.equal(mainEntry.thread_file, "cursor/main-hash.json");
  const written = await writeCursorIndex(out, summary.index, summary.audit);
  const auditPath = await writeCursorAudit(out, summary.audit);
  const indexManifest = await fs.readJson(written.manifestPath);
  assert.equal(indexManifest.entries, 3);
  assert.equal(indexManifest.by_status.exported, 2);
  assert.equal(indexManifest.db_path, dbPath);
  assert.equal(indexManifest.index_sha256.length, 64);
  const auditJson = await fs.readJson(auditPath);
  assert.equal(auditJson.counts.composers_total, 3);
  assert.ok(auditJson.coverage.header_ids_with_thread >= 1);
});

test("reader returns a skipped summary when Cursor global storage is absent", async (t) => {
  const dir = await makeTempDir("aex-cursor-global-missing-");
  t.after(() => fs.remove(dir).catch(() => {}));
  const summary = await collectCursorGlobalRecords({
    dbPath: path.join(dir, "does-not-exist.vscdb"),
    includeTranscripts: false,
  });
  assert.equal(summary.skipped, "cursor-global-not-found");
  assert.equal(summary.index.length, 0);
});
