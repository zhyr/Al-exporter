/**
 * Interop contract (schema 1.1.0) unit tests.
 * Covers: field presence, path-derived session ids, git remote, device identity,
 * malformed records, legacy 1.0.0 exports, and capability reporting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAll } from "../../core/normalize.js";
import {
  computeInteropCapabilities,
  finalizeRecordInterop,
  inferNativeSessionId,
  readGitRemote,
  resolveDeviceIdentity,
} from "../../core/interop.js";
import { conformThreadRecord, validateThread } from "../../core/schema-validator.js";

function tempDir(prefix = "aex-interop-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { path: filePath, content, mtime: Date.now(), size: Buffer.byteLength(content) };
}

const DEVICES = resolveDeviceIdentity({ sourceDevice: null, hostname: "test-host", platform: "darwin" });

describe("inferNativeSessionId", () => {
  it("reads Claude Code session ids from the file name", () => {
    assert.deepEqual(
      inferNativeSessionId("/home/u/.claude/projects/-repo/7f3a.jsonl"),
      { native_id: "7f3a", native_id_kind: "uuid", native_id_source: "file.basename" },
    );
  });

  it("reads Cursor transcript ids from the directory name", () => {
    assert.equal(
      inferNativeSessionId("/home/u/.cursor/projects/-repo/agent-transcripts/abc/subagents/sub.jsonl").native_id,
      "abc",
    );
  });

  it("returns null for stores with no native session id", () => {
    assert.equal(inferNativeSessionId("/home/u/Library/state.vscdb"), null);
    assert.equal(inferNativeSessionId(""), null);
  });
});

describe("device identity", () => {
  it("separates source and collector and marks the basis", () => {
    const local = resolveDeviceIdentity({ hostname: "host-a", platform: "darwin" });
    assert.equal(local.source_device_id, local.collector_device_id);
    assert.equal(local.source_device_id_basis, "export_host");
    assert.equal(local.source_hostname, "host-a");

    const declared = resolveDeviceIdentity({ sourceDevice: "alice-laptop", hostname: "host-a", platform: "darwin" });
    assert.equal(declared.source_device_id, "alice-laptop");
    assert.equal(declared.source_device_id_basis, "declared");
    assert.equal(declared.source_hostname, null);
    assert.notEqual(declared.collector_device_id, "alice-laptop");
  });
});

describe("git remote", () => {
  it("reads origin from <cwd>/.git/config and caches nothing invented", () => {
    const repo = tempDir();
    writeFile(
      path.join(repo, ".git", "config"),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:zhyr/example.git\n',
    );
    assert.deepEqual(readGitRemote(repo), {
      remote: "git@github.com:zhyr/example.git",
      source: "cwd_git_config",
    });
    assert.equal(readGitRemote(path.join(repo, "missing")), null);
    assert.equal(readGitRemote("relative/path"), null);
  });
});

describe("Claude Code JSONL", () => {
  it("exports native session id, uuid ids, line numbers, cwd and tool calls", () => {
    const repo = tempDir();
    writeFile(
      path.join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/zhyr/example.git\n',
    );
    const lines = [
      {
        sessionId: "sess-1",
        type: "user",
        uuid: "u-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: repo,
        version: "2.1.0",
        message: { role: "user", content: "hello" },
      },
      {
        sessionId: "sess-1",
        type: "assistant",
        uuid: "u-2",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: repo,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running" },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        sessionId: "sess-1",
        type: "user",
        uuid: "u-3",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file.txt", is_error: true }],
        },
      },
    ];
    const file = writeFile(
      path.join(repo, ".claude", "projects", "-repo", "sess-1.jsonl"),
      lines.map((line) => JSON.stringify(line)).join("\n"),
    );

    const [record] = normalizeAll([file]).map((r) => finalizeRecordInterop(r, { devices: DEVICES }));

    assert.equal(record.schema_version, "1.1.0");
    assert.equal(record.session.native_id, "sess-1");
    assert.equal(record.session.native_id_source, "line.sessionId");
    assert.equal(record.session.cwd, repo);
    assert.equal(record.session.cwd_source, "line.cwd");
    assert.equal(record.session.agent_version, "2.1.0");
    assert.equal(record.session.git_remote, "https://github.com/zhyr/example.git");
    assert.equal(record.session.git_remote_source, "cwd_git_config");
    assert.equal(record.device.source_device_id, DEVICES.source_device_id);

    const user = record.messages[0];
    assert.equal(user.id, "u-1");
    assert.equal(user.id_source, "uuid");
    assert.equal(user.line, 1);
    assert.equal(user.timestamp, "2026-01-01T00:00:00.000Z");

    const toolCall = record.messages.find((m) => m.tool_call?.phase === "call");
    assert.deepEqual(toolCall.tool_call, {
      name: "Bash",
      status: null,
      call_id: "toolu_1",
      phase: "call",
    });
    assert.equal(toolCall.line, 2);
    assert.equal(toolCall.id, "u-2#1");
    assert.equal(toolCall.id_source, "uuid+block");

    const toolResult = record.messages.find((m) => m.tool_call?.phase === "result");
    assert.equal(toolResult.tool_call.status, "error");
    assert.equal(toolResult.tool_call.call_id, "toolu_1");
  });
});

describe("Cursor agent transcript", () => {
  it("parses turns instead of one raw system blob, with line numbers and no invented timestamps", () => {
    const content = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "reading" },
            { type: "tool_use", name: "Read", input: { path: "/tmp/a" } },
          ],
        },
      }),
      JSON.stringify({ type: "turn_ended" }),
    ].join("\n");
    const file = writeFile(
      path.join(tempDir(), ".cursor", "projects", "-repo", "agent-transcripts", "sess-9", "sess-9.jsonl"),
      content,
    );

    const [record] = normalizeAll([file]).map((r) => finalizeRecordInterop(r, { devices: DEVICES }));
    assert.equal(record.type, "thread");
    assert.equal(record.session.native_id, "sess-9");
    assert.equal(record.session.native_id_source, "dir.basename");
    assert.ok(record.messages.length >= 3);
    assert.deepEqual(record.messages.map((m) => m.line), [1, 2, 2]);
    assert.ok(record.messages.every((m) => m.timestamp == null), "mtime must not become a message timestamp");
    assert.ok(record.messages.every((m) => m.id === null), "no id is invented");
    const tool = record.messages.find((m) => m.tool_call);
    assert.equal(tool.tool_call.name, "Read");
    assert.equal(tool.tool_call.status, null);
  });
});

describe("WorkBuddy transcript", () => {
  it("exports event ids, line numbers, cwd and explicit tool status", () => {
    const dir = path.join(tempDir(), ".workbuddy", "projects", "demo");
    const content = [
      JSON.stringify({ type: "message", role: "user", id: "ev-1", timestamp: 1760000000000, cwd: dir, content: "hi" }),
      JSON.stringify({ type: "function_call", id: "ev-2", timestamp: 1760000001000, cwd: dir, name: "Write", arguments: "{}", callId: "call-1" }),
      JSON.stringify({ type: "function_call_result", id: "ev-3", timestamp: 1760000002000, cwd: dir, name: "Write", callId: "call-1", status: "completed", output: "ok" }),
    ].join("\n");
    const file = writeFile(path.join(dir, "11111111-2222-3333-4444-555555555555.jsonl"), content);
    const [record] = normalizeAll([file]).map((r) => finalizeRecordInterop(r, { devices: DEVICES }));

    assert.equal(record.session.native_id, "11111111-2222-3333-4444-555555555555");
    assert.equal(record.session.cwd, dir);
    assert.equal(record.session.cwd_source, "workbuddy.record");
    assert.deepEqual(record.messages.map((m) => m.id), ["ev-1", "ev-2", "ev-3"]);
    assert.deepEqual(record.messages.map((m) => m.line), [1, 2, 3]);
    const result = record.messages.find((m) => m.tool_call?.phase === "result");
    assert.equal(result.tool_call.status, "completed");
    assert.equal(result.tool_call.call_id, "call-1");
  });
});

describe("defensive handling", () => {
  it("fills the contract on legacy 1.0.0 records without inventing values", () => {
    const legacy = {
      schema_version: "1.0.0",
      thread_id: "legacy-1",
      type: "thread",
      messages: [{ role: "user", content: "hi" }],
      meta: { source: "cursor", project: "demo", created_at: "2026-01-01T00:00:00.000Z" },
    };
    assert.equal(validateThread(legacy).valid, true, "legacy records remain valid");

    finalizeRecordInterop(legacy, { devices: DEVICES });
    assert.deepEqual(legacy.session, {
      native_id: null,
      native_id_kind: "none",
      native_id_source: null,
      cwd: null,
      cwd_source: null,
      git_remote: null,
      git_remote_source: null,
      agent_version: null,
    });
    assert.equal(legacy.messages[0].id, null);
    assert.equal(legacy.messages[0].line, null);
    assert.equal(legacy.messages[0].tool_call, undefined);
    assert.equal(legacy.device.collector_device_id, DEVICES.collector_device_id);
  });

  it("survives malformed JSONL lines and malformed messages", () => {
    const file = writeFile(
      path.join(tempDir(), "malformed.jsonl"),
      [
        "{not json",
        JSON.stringify(null),
        JSON.stringify({ role: "user", content: 42 }),
        JSON.stringify({ sessionId: "s-1", type: "user", message: { role: "user", content: "ok" } }),
      ].join("\n"),
    );
    const records = normalizeAll([file]);
    assert.ok(records.length > 0);
    for (const record of records) {
      finalizeRecordInterop(record, { devices: DEVICES });
      assert.ok(record.messages.every((m) => typeof m.content === "string"));
      assert.ok(record.messages.every((m) => "id" in m && "line" in m));
      assert.equal(validateThread(conformThreadRecord(record)).valid, true);
    }
  });

  it("normalizes malformed message identity fields", () => {
    const record = {
      schema_version: "1.1.0",
      thread_id: "x",
      type: "thread",
      messages: [
        { role: "user", content: "a", id: 12, line: 0, tool_call: { name: 1, status: 2, call_id: 3, phase: "bogus" } },
        { role: "assistant", content: "b", id: null, line: "nope" },
        null,
      ],
      meta: { source: "cursor", project: "demo", created_at: "2026-01-01T00:00:00.000Z" },
    };
    finalizeRecordInterop(record, { devices: DEVICES });
    assert.equal(record.messages[0].id, "12");
    assert.equal(record.messages[0].line, null);
    assert.deepEqual(record.messages[0].tool_call, {
      name: "1",
      status: "2",
      call_id: "3",
      phase: "call",
    });
    assert.equal(record.messages[1].line, null);
    assert.doesNotThrow(() => conformThreadRecord(record));
    assert.equal(validateThread(record).valid, true);
  });
});

describe("capability report", () => {
  it("distinguishes empty fields from partial and full fields", () => {
    const records = [
      {
        messages: [
          { role: "user", content: "a", id: "m1", line: 1, tool_call: { name: "Read", status: null, call_id: "c1", phase: "call" } },
          { role: "assistant", content: "b", id: null, line: null },
        ],
        session: { native_id: "s1", cwd: "/tmp/x", git_remote: null, agent_version: null },
        device: { source_device_id: "dev_1" },
      },
      {
        messages: [{ role: "user", content: "c", id: null, line: null }],
        session: { native_id: null, cwd: null, git_remote: null, agent_version: null },
        device: { source_device_id: "dev_1" },
      },
    ];
    const caps = computeInteropCapabilities(records, {
      schemaVersion: "1.1.0",
      exporterVersion: "test",
      devices: DEVICES,
    });

    assert.equal(caps.fields["session.native_id"].status, "partial");
    assert.equal(caps.fields["session.native_id"].non_empty, 1);
    assert.equal(caps.fields["session.native_id"].empty, 1);
    assert.equal(caps.fields["session.git_remote"].status, "empty");
    assert.equal(caps.fields["messages[].tool_call.status"].status, "empty");
    assert.equal(caps.fields["messages[].tool_call.status"].applicable, 1);
    assert.equal(caps.fields["messages[].id"].status, "partial");
    assert.equal(caps.fields["device.source_device_id"].status, "full");
    assert.equal(caps.capabilities.native_session_id, "partial");
    assert.equal(caps.capabilities.tool_call_status, "empty");
    assert.ok(caps.known_gaps.some((gap) => gap.includes("null value means")));
  });

  it("marks message-scoped fields not_applicable when there are no messages", () => {
    const caps = computeInteropCapabilities([{ messages: [], session: { native_id: "s" } }], { devices: DEVICES });
    assert.equal(caps.fields["messages[].id"].status, "not_applicable");
    assert.equal(caps.fields["session.native_id"].status, "full");
  });
});
