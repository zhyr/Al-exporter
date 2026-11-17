/**
 * zstd-compressed transcripts (Codex `rollout-*.jsonl.zst`).
 * Verifies streaming decompression (bounded, no plaintext temp file) and that a
 * decompressed rollout is parsed as JSONL with the interop fields filled in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { readZstdText } from "../../core/scan.js";
import { normalizeAll } from "../../core/normalize.js";
import { finalizeRecordInterop, resolveDeviceIdentity } from "../../core/interop.js";
import { isInterestingFile } from "../../core/utils.js";

const hasZstd = typeof zlib.zstdCompressSync === "function";
const skip = hasZstd ? false : "zstd compression is unavailable in this Node runtime";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aex-zstd-"));
}

function writeZstd(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, zlib.zstdCompressSync(Buffer.from(content, "utf8")));
  return filePath;
}

const CODEX_ROLLOUT = [
  JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "019a-sess-0001",
      cwd: "/tmp/repo",
      cli_version: "0.58.0",
      git: { repository_url: "https://github.com/example/repo.git" },
    },
  }),
  JSON.stringify({
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  }),
  JSON.stringify({
    timestamp: "2026-01-01T00:00:02.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: "{\"cmd\":\"ls\"}", call_id: "call_1" },
  }),
].join("\n");

describe("readZstdText", () => {
  it("streams a .jsonl.zst file back to UTF-8 text", { skip }, async () => {
    const dir = tempDir();
    const content = `${CODEX_ROLLOUT}\n`;
    const file = writeZstd(dir, "rollout.jsonl.zst", content);
    const decoded = await readZstdText(file, 10 * 1024 * 1024);
    assert.equal(decoded.text, content);
    assert.equal(decoded.bytes, Buffer.byteLength(content));
  });

  it("returns null when the decompressed size exceeds the cap", { skip }, async () => {
    const dir = tempDir();
    const file = writeZstd(dir, "big.jsonl.zst", "x".repeat(4096));
    assert.equal(await readZstdText(file, 128), null);
  });
});

describe("compressed Codex rollout normalization", () => {
  it("parses .jsonl.zst with the same JSONL extractor and fills interop fields", { skip }, async () => {
    const dir = tempDir();
    const file = writeZstd(
      dir,
      "sessions/2026/01/01/rollout-2026-01-01T00-00-00-019a-sess-0001.jsonl.zst",
      CODEX_ROLLOUT,
    );
    const decoded = await readZstdText(file, 10 * 1024 * 1024);
    const records = normalizeAll([{
      path: file,
      content: decoded.text,
      mtime: Date.now(),
      size: decoded.bytes,
    }]);
    assert.equal(records.length, 1);
    const record = records[0];
    finalizeRecordInterop(record, {
      devices: resolveDeviceIdentity({ hostname: "test-host", platform: "darwin" }),
    });

    assert.equal(record.type, "thread");
    assert.equal(record.session.native_id, "019a-sess-0001");
    assert.equal(record.session.cwd, "/tmp/repo");
    assert.equal(record.session.git_remote, "https://github.com/example/repo.git");
    assert.equal(record.session.agent_version, "0.58.0");

    assert.equal(record.messages.length, 2);
    assert.equal(record.messages[0].line, 2);
    assert.equal(record.messages[0].timestamp, "2026-01-01T00:00:01.000Z");
    assert.equal(record.messages[1].line, 3);
    assert.equal(record.messages[1].tool_call.name, "shell");
    assert.equal(record.messages[1].tool_call.call_id, "call_1");
  });

  it("treats .jsonl.zst as an interesting transcript even without a path keyword", () => {
    assert.equal(isInterestingFile("/tmp/rollout-abc.jsonl.zst", null), true);
  });
});
