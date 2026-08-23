/**
 * Transfer2Eval — 主入口 / Pipeline 编排
 *
 * 借鉴 EvoTrace 的流水线：
 *   mine (Episode Miner + 证据提取)
 *     → evidence (证据排序)
 *     → gate (门控路由, fail-closed)
 *     → build (任务构建: 可回放任务/偏好数据/RL环境/奖励候选)
 *     → verify (审计验证: 双状态校验)
 *     → calibrate (难度校准)
 *     → export (数据集导出: Eval CSV / CMS SFT/DPO JSONL)
 *     → annotate (人工标注与评论修改, 任意阶段)
 *
 * 任何阶段失败 → FAILED / REJECTED（失败关闭，不进入下游）。
 */
import { normalizeAll } from '../normalize.js';
import { mineEpisodes } from './mine.js';
import { scoreEpisode, fingerprint } from './evidence.js';
import { gateEpisodes, manualGate } from './gate.js';
import { buildTask } from './builder.js';
import { verifyTask } from './verify.js';
import { calibrateTask } from './calibrate.js';
import { exportDatasets } from './export.js';
import { addAnnotation, listAnnotations, resolveAnnotation } from './annotate.js';
import { store } from './store.js';
import { STATE_MACHINE } from './schema.js';

export * from './schema.js';
export * from './mine.js';
export * from './evidence.js';
export * from './gate.js';
export * from './builder.js';
export * from './verify.js';
export * from './calibrate.js';
export * from './export.js';
export * from './annotate.js';
export { store };

/**
 * 完整流水线（扫描 → 挖掘 → 门控 → 构建 → 验证 → 校准 → 导出）
 * @param {object} opts
 * @param {Array} opts.rawRecords - 直接提供扫描结果（可跳过 scan）
 * @param {Array} opts.normalized - 直接提供已归一化 records
 * @param {boolean} opts.scan - 是否执行文件扫描
 * @param {object} opts.thresholds - 门控阈值
 * @param {boolean} opts.docker - 启用 docker 验证
 * @param {string} opts.outDir - 导出目录
 * @param {string} opts.split - 导出 split
 * @param {Function} opts.onProgress - 进度回调 (stage, detail)
 * @returns {Promise<object>} 汇总结果
 */
export async function runPipeline(opts = {}) {
  const {
    normalized,
    rawRecords,
    thresholds,
    docker = false,
    outDir,
    split = 'candidate_generated',
    onProgress = null,
  } = opts;

  const progress = (stage, detail) => onProgress?.(stage, detail);

  // ── 1. 归一化（支持 17+ 工具扫描产物直接输入）──
  let records = normalized;
  if (!records && rawRecords) {
    progress('normalize', `normalizing ${rawRecords.length} raw records`);
    records = normalizeAll(rawRecords);
  }
  if (!records) throw new Error('no input: pass normalized or rawRecords');

  // ── 2. 挖掘 episode + 证据提取 ──
  progress('mine', 'mining episodes');
  const mined = await mineEpisodes(records);
  progress('mine', `mined ${mined.length} episodes`);

  // ── 3. 证据排序（scoreEpisode 就地写回 evidence 并返回 episode）──
  for (const ep of mined) {
    scoreEpisode(ep);
  }

  // ── 4. 门控路由（fail-closed）──
  progress('gate', `gating ${mined.length} episodes`);
  const gated = gateEpisodes(mined, { thresholds });
  progress('gate', `accepted=${gated.accepted.length}, review=${gated.review.length}, rejected=${gated.rejected.length}`);

  // ── 5. 构建任务（仅 accept；review 待人工确认）──
  const buildable = [...gated.accepted, ...gated.review.filter((e) => e.gate?.needsReview === false)];
  const built = [];
  for (const ep of buildable) {
    progress('build', `building task for ${ep.id}`);
    try {
      buildTask(ep);
      built.push(ep);
    } catch (e) {
      ep.status = STATE_MACHINE.FAILED;
      ep.provenance.push({ stage: 'build', at: new Date().toISOString(), detail: `build error: ${e.message}` });
    }
  }
  progress('build', `built ${built.length} tasks`);

  // ── 6. 审计验证（双状态）──
  const verified = [];
  for (const ep of built) {
    progress('verify', `verifying ${ep.id}`);
    const result = verifyTask(ep, { docker });
    if (result.passed) verified.push(ep);
  }
  progress('verify', `verified ${verified.length} tasks`);

  // ── 7. 难度校准 ──
  for (const ep of verified) calibrateTask(ep);

  // ── 8. 持久化（全部保留，含 rejected/failed 供审计）──
  for (const ep of mined) {
    store.saveEpisode(ep);
    if (ep.task) store.saveTask(ep.task);
  }

  // ── 9. 导出 ──
  const exportResult = outDir ? exportDatasets(verified, { outDir, split }) : null;

  progress('done', `pipeline complete: ${verified.length}/${mined.length} verified`);

  const seen = new Set();
  return {
    stats: {
      scanned: records.length,
      mined: mined.length,
      unique: mined.filter((e) => {
        const fp = fingerprint(e.prompt);
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
      }).length,
      accepted: gated.accepted.length,
      review: gated.review.length,
      rejected: gated.rejected.length,
      built: built.length,
      verified: verified.length,
    },
    gateSummary: { accepted: gated.accepted, review: gated.review, rejected: gated.rejected },
    export: exportResult,
  };
}

/**
 * 只执行挖掘+证据+门控（供 Web UI 分阶段操作）
 */
export async function runMineAndGate(opts = {}) {
  const { normalized, rawRecords, thresholds } = opts;
  let records = normalized;
  if (!records && rawRecords) records = normalizeAll(rawRecords);
  if (!records) throw new Error('no input: pass normalized or rawRecords');

  const mined = await mineEpisodes(records);
  for (const ep of mined) scoreEpisode(ep);
  const gated = gateEpisodes(mined, { thresholds });

  for (const ep of mined) store.saveEpisode(ep);
  return { mined: mined.length, ...gated };
}

export { STATE_MACHINE, manualGate, addAnnotation, listAnnotations, resolveAnnotation };
