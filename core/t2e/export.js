/**
 * Dataset Exporter — 数据集导出（对接两个下游）
 *
 * 1. Internal LLM/VLM Evaluation
 *    questions.csv（12 列）：id, domain, task_type, difficulty, prompt, ground_truth,
 *    split, modality, source, scoring_type, reference_answer, review_status
 *
 * 2. Internal CMS KnowledgeBase 微调/SFT
 *    - SFT：prompt_response JSONL  { prompt, response }
 *    - DPO：prompt_chosen_rejected JSONL { prompt, chosen, rejected }
 *
 * 导出产物同时支持浏览/回放：附带 manifest（幂等哈希，沿用 AI-Exporter 备份理念）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_MACHINE, EVAL_ENUMS, DOWNSTREAM_TARGETS } from './schema.js';

export { DOWNSTREAM_TARGETS };

/** CSV 列（与 Internal LLM/VLM Evaluation schema 对齐） */
export const EVAL_CSV_COLUMNS = [
  'id', 'domain', 'task_type', 'difficulty', 'prompt', 'ground_truth',
  'split', 'modality', 'source', 'scoring_type', 'reference_answer', 'review_status',
];

/**
 * 导出所有已校准 episode 到各下游数据集
 * @param {Array<object>} episodes
 * @param {object} opts
 * @param {string} opts.outDir - 输出目录（默认 store.datasetsDir）
 * @param {string} opts.split  - 'candidate_generated' | 'seed_train' | 'dev_eval' | 'private_test'
 * @returns {{evalFile, sftFile, dpoFile, counts}}
 */
export function exportDatasets(episodes, opts = {}) {
  const outDir = opts.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const ready = episodes.filter((e) =>
    e.status === STATE_MACHINE.CALIBRATED || e.status === STATE_MACHINE.EXPORTED
  );
  if (ready.length === 0) {
    throw new Error('no calibrated episodes to export — run mine → gate → build → verify → calibrate first');
  }

  const evalRows = ready.map((e) => toEvalRow(e, opts));
  const sftLines = ready.map((e) => toSftLine(e)).filter(Boolean);
  const dpoLines = ready.map((e) => toDpoLine(e)).filter(Boolean);

  const split = opts.split || 'candidate_generated';
  if (!EVAL_ENUMS.SPLIT.includes(split)) throw new Error(`invalid split: ${split}`);

  const evalW = writeCsv(path.join(outDir, 'questions.csv'), EVAL_CSV_COLUMNS, evalRows);
  const sftW = writeJsonl(path.join(outDir, 'sft_prompt_response.jsonl'), sftLines);
  const dpoW = writeJsonl(path.join(outDir, 'dpo_prompt_chosen_rejected.jsonl'), dpoLines);

  // manifest（幂等：相同内容哈希不变；哈希在写入时计算，无需读回）
  const manifest = buildManifest({ evalFile: evalW, sftFile: sftW, dpoFile: dpoW }, ready.length, split);
  const manifestFile = writeJson(path.join(outDir, 'manifest.json'), manifest);

  for (const e of ready) {
    e.status = STATE_MACHINE.EXPORTED;
    e.provenance.push({
      stage: 'export',
      at: new Date().toISOString(),
      detail: `exported to ${outDir} (split=${split})`,
    });
  }

  return {
    outDir,
    split,
    evalFile: evalW.file,
    sftFile: sftW.file,
    dpoFile: dpoW.file,
    manifestFile,
    counts: { episodes: ready.length, eval: evalRows.length, sft: sftLines.length, dpo: dpoLines.length },
  };
}

// ─── 行映射 ───────────────────────────────────────────────────────────────────

/** 转 Eval CSV 行（12 列） */
export function toEvalRow(episode, opts = {}) {
  const em = episode.task?.evalMeta || {};
  const idx = opts.index != null ? opts.index : episode.id;
  const domain = pick(em.domain, EVAL_ENUMS.DOMAIN, 'reasoning');
  const taskType = pick(em.taskType, EVAL_ENUMS.TASK_TYPE, 'closed_qa');
  const difficulty = pick(em.difficulty, EVAL_ENUMS.DIFFICULTY, 'L2');
  const scoringType = pick(em.scoringType, EVAL_ENUMS.SCORING_TYPE, 'rule_based');
  const split = opts.split || 'candidate_generated';
  const referenceAnswer = episode.groundTruth || episode.task?.preference?.chosen || '';
  const modality = 'text';
  const source = 'llm_generated';
  const reviewStatus = 'draft';

  return {
    id: `G${pad5(idx)}`,
    domain,
    task_type: taskType,
    difficulty,
    prompt: sanitize(episode.prompt),
    ground_truth: sanitize(referenceAnswer),
    split,
    modality,
    source,
    scoring_type: scoringType,
    reference_answer: sanitize(referenceAnswer),
    review_status: reviewStatus,
  };
}

/** 转 CMS SFT 行（prompt_response） */
export function toSftLine(episode) {
  const chosen = episode.task?.preference?.chosen;
  if (!episode.prompt || !chosen) return null;
  return {
    prompt: sanitize(episode.prompt),
    response: sanitize(chosen),
    source: episode.source,
    episode_id: episode.id,
  };
}

/** 转 CMS DPO 行（prompt_chosen_rejected） */
export function toDpoLine(episode) {
  const pref = episode.task?.preference;
  if (!episode.prompt || !pref?.chosen || !pref?.rejected) return null;
  return {
    prompt: sanitize(episode.prompt),
    chosen: sanitize(pref.chosen),
    rejected: sanitize(pref.rejected),
    source: episode.source,
    episode_id: episode.id,
  };
}

// ─── 文件写入 ─────────────────────────────────────────────────────────────────
// 写入时同步计算 sha256 + size，避免导出后再整文件读回；字符串增量构建避免大数组 + join 的峰值内存。

const WRITE_CHUNK = 400;

function writeCsv(file, columns, rows) {
  const esc = (v) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  const hash = crypto.createHash('sha256');
  let out = '\ufeff' + columns.join(',') + '\n';
  hash.update(out);
  for (let i = 0; i < rows.length; i++) {
    out += columns.map((c) => esc(rows[i][c])).join(',') + '\n';
    if (out.length >= WRITE_CHUNK * 1024) {
      hash.update(out);
      fs.appendFileSync(file, out, 'utf8');
      out = '';
    }
  }
  if (out) {
    hash.update(out);
    fs.appendFileSync(file, out, 'utf8');
  }
  return { file, size: fs.statSync(file).size, sha256: hash.digest('hex') };
}

function writeJsonl(file, lines) {
  const hash = crypto.createHash('sha256');
  let out = '';
  for (const l of lines) {
    out += JSON.stringify(l) + '\n';
    if (out.length >= WRITE_CHUNK * 1024) {
      hash.update(out);
      fs.appendFileSync(file, out, 'utf8');
      out = '';
    }
  }
  if (out) {
    hash.update(out);
    fs.appendFileSync(file, out, 'utf8');
  }
  return { file, size: fs.statSync(file).size, sha256: hash.digest('hex') };
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function buildManifest(writes, episodeCount, split) {
  const files = {};
  for (const [key, w] of Object.entries(writes)) {
    files[key] = {
      file: path.basename(w.file),
      size: w.size,
      sha256: w.sha256,
    };
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    split,
    episodeCount,
    files,
    generator: 'ai-exporter-transfer2eval',
  };
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function pick(v, enumList, fallback) {
  return enumList.includes(v) ? v : fallback;
}

function sanitize(v) {
  return String(v ?? '').replace(/\r\n/g, '\n').trim();
}

function pad5(n) {
  return String(n).padStart(5, '0');
}

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}
