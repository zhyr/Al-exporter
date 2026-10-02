/**
 * Single source of truth for the exporter version.
 * Reads `version` from package.json so CLI / server / legacy entry never drift
 * from the published npm version.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, "../package.json");

let version = "0.0.0";
try {
  version = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || version;
} catch {
  // Fall back to a sentinel if package.json is unreadable (e.g. bundled contexts)
}

export const EXPORTER_VERSION = version;
