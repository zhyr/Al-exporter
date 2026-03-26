/**
 * Integration test — full export pipeline.
 * Creates a temp fixture workspace, runs runExport(), validates manifest + schema.
 * Run: node --test tests/integration/export.test.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { runExport } from "../../src/commands/export.js";
import { validateAll } from "../../core/schema-validator.js";

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aex-test-"));
  // Create a fake workspace fixture with a recognizable chat file
  const chatFile = path.join(tmpDir, "chat.json");
  await fs.writeJson(chatFile, {
    messages: [
      { role: "user", content: "What is the capital of France?" },
      { role: "assistant", content: "The capital of France is Paris." },
    ],
  });
});

after(async () => {
  await fs.remove(tmpDir).catch(() => {});
});

describe("runExport integration", () => {
  let result;
  let outputDir;

  it("completes without throwing", async () => {
    outputDir = path.join(tmpDir, "output");
    result = await runExport({ output: outputDir, workers: 2 });
    assert.ok(result, "runExport should return a result object");
  });

  it("creates manifest.json", async () => {
    const manifestPath = path.join(outputDir, "manifest.json");
    assert.ok(await fs.pathExists(manifestPath), "manifest.json should exist");
  });

  it("manifest has required fields", async () => {
    const manifest = await fs.readJson(path.join(outputDir, "manifest.json"));
    assert.ok(manifest.exporter_version,   "exporter_version missing");
    assert.ok(manifest.schema_version,     "schema_version missing");
    assert.ok(manifest.exported_at,        "exported_at missing");
    assert.ok(Array.isArray(manifest.sources_seen), "sources_seen should be array");
  });

  it("manifest items have sha256", async () => {
    const manifest = await fs.readJson(path.join(outputDir, "manifest.json"));
    const itemsWithFile = manifest.items.filter(i => i.file);
    if (itemsWithFile.length > 0) {
      assert.ok(itemsWithFile[0].sha256, "sha256 missing from manifest item");
    }
  });

  it("exported JSON files pass schema validation", async () => {
    const manifest = await fs.readJson(path.join(outputDir, "manifest.json"));
    const filePaths = manifest.items.filter(i => i.file).map(i => path.join(outputDir, i.file));
    const records = await Promise.all(filePaths.map(p => fs.readJson(p)));
    if (records.length > 0) {
      const { invalid } = validateAll(records);
      assert.equal(invalid, 0, `${invalid} records failed schema validation`);
    }
  });
});
