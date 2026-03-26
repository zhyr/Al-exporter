import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createEmptyUAS } from "./schema.js";

const CODEX_DIR = os.homedir() + "/.codex";
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const CODEX_RULES_PATH = path.join(CODEX_DIR, "rules/default.rules");

/**
 * Partial TOML parser for basic key-value pairs.
 */
function parseToml(text) {
  const result = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const parts = trimmed.split("=");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let val = parts[1].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
      result[key] = val;
    }
  }
  return result;
}

/**
 * Extract Codex configuration, skills, and memory.
 */
export async function extractCodexConfig() {
  const uas = createEmptyUAS("codex");
  
  if (!(await fs.pathExists(CODEX_DIR))) {
    return uas;
  }

  try {
    // I. Extract Basic Config
    if (await fs.pathExists(CODEX_CONFIG_PATH)) {
      const configText = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
      const config = parseToml(configText);
      uas.agentConfig.model = config.model || "";
    }

    // II. Extract Rules / Memory
    if (await fs.pathExists(CODEX_RULES_PATH)) {
      uas.context.projectRules = await fs.readFile(CODEX_RULES_PATH, "utf-8");
    }

    // III. Extract Skills / Tools
    const skillsDir = path.join(CODEX_DIR, "skills");
    if (await fs.pathExists(skillsDir)) {
      const skillFiles = await fs.readdir(skillsDir);
      for (const f of skillFiles) {
        if (f.endsWith(".json")) {
           try {
             const skill = await fs.readJson(path.join(skillsDir, f));
             uas.skills.push({
               id: skill.id || f.replace(".json", ""),
               name: skill.name || f.replace(".json", ""),
               description: skill.description || "",
               schema: skill.parameters || {}
             });
           } catch {}
        }
      }
    }

  } catch (err) {
    console.error("Codex Adapter Error:", err);
  }

  return uas;
}
