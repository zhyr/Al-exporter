/**
 * Per-source-file export cursor (mtime + output fingerprint).
 * Skips re-writing unchanged session files on repeat exports.
 */

import fs from "node:fs";
import path from "node:path";

export const EXPORT_STATE_FILENAME = ".export_state.json";

/**
 * @param {string} outputDir
 * @returns {string}
 */
export function exportStatePath(outputDir) {
  return path.join(outputDir, EXPORT_STATE_FILENAME);
}

/**
 * @param {string} stateFile
 * @returns {{ files: Record<string, { mtime_ms: number, thread_ids: string[], outputs: string[] }>, schema_version: string|null }}
 */
export function loadExportState(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) return { files: {}, schema_version: null };
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!parsed || typeof parsed !== "object") return { files: {}, schema_version: null };
    return {
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      schema_version: typeof parsed.schema_version === "string" ? parsed.schema_version : null,
    };
  } catch {
    return { files: {}, schema_version: null };
  }
}

/**
 * @param {{ files: Record<string, any> }} state
 * @param {string} stateFile
 */
export function saveExportState(state, stateFile) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(stateFile)}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, stateFile);
}

/**
 * True when the source file mtime matches and every previous output still exists.
 * @param {{ files: Record<string, any> }} state
 * @param {string} filePath
 * @param {number} mtimeMs
 * @param {string} outputDir
 * @returns {boolean}
 */
export function shouldSkipSourceFile(state, filePath, mtimeMs, outputDir) {
  const entry = state.files?.[filePath];
  if (!entry) return false;
  if (Number(entry.mtime_ms) !== Number(mtimeMs)) return false;
  const outputs = Array.isArray(entry.outputs) ? entry.outputs : [];
  if (outputs.length === 0) return false;
  return outputs.every((rel) => fs.existsSync(path.join(outputDir, rel)));
}

/**
 * @param {{ files: Record<string, any> }} state
 * @param {string} filePath
 * @param {{ mtime_ms: number, thread_ids: string[], outputs: string[] }} entry
 */
export function rememberSourceFile(state, filePath, entry) {
  if (!state.files) state.files = {};
  state.files[filePath] = {
    mtime_ms: Number(entry.mtime_ms) || 0,
    thread_ids: [...new Set(entry.thread_ids || [])],
    outputs: [...new Set(entry.outputs || [])],
  };
}
