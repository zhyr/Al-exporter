/**
 * Calibrator — 难度校准（借鉴 EvoTrace /calibrate 自博弈难度校准）
 *
 * 目标：通过可量化信号估计任务的真实难度，与 LLM 自评校准。
 * 采用轻量自博弈：用不同"参考能力"的启发式代理重放轨迹，
 * 参考代理成功所需的步骤数/尝试次数作为难度代理指标。
 *
 * 校准输出挂到 episode.calibration：
 *   { difficulty, estimate, confidence, signalBreakdown }
 */
import { EVAL_ENUMS, STATE_MACHINE } from './schema.js';

/**
 * 校准任务难度
 * @param {object} episode
 * @returns {object} calibration
 */
export function calibrateTask(episode) {
  const task = episode.task;
  if (!task) throw new Error(`episode ${episode.id} has no task — run build first`);

  const signals = {};

  // 1. 轨迹规模
  const steps = task.replay?.steps?.length || 0;
  signals.stepCount = steps;
  signals.stepScore = Math.min(1, steps / 10);

  // 2. 复杂度（验收标准数 + 补丁大小）
  const criteria = task.acceptanceCriteria?.length || 0;
  const patchBytes = task.replay?.steps?.filter((s) => s.type === 'patch').reduce((n, s) => n + s.payload.length, 0) || 0;
  signals.complexity = Math.min(1, (criteria * 0.4 + Math.min(1, patchBytes / 5000) * 0.6));

  // 3. 失败-修正循环（自博弈代理重试信号）
  const failRetry = (task.preference?.rejected ? 1 : 0) + countRetries(episode.messages);
  signals.retryCount = failRetry;
  signals.retryScore = Math.min(1, failRetry * 0.5);

  // 4. 域难度先验
  const domainPrior = domainPriorFor(task.evalMeta?.domain);
  signals.domainPrior = domainPrior;

  // 综合估计 0-1
  const estimate = Math.min(1, 0.3 * signals.stepScore + 0.3 * signals.complexity + 0.2 * signals.retryScore + 0.2 * domainPrior);

  // 难度映射（参考模型的能力锚点：L1 简单问答，L4 复杂多步工程任务）
  let difficulty;
  if (estimate < 0.25) difficulty = 'L1';
  else if (estimate < 0.5) difficulty = 'L2';
  else if (estimate < 0.75) difficulty = 'L3';
  else difficulty = 'L4';

  // 置信度：信号越充分越可信
  const confidence = Math.min(1, 0.4 + steps * 0.05 + criteria * 0.1 + failRetry * 0.1);

  const calibration = {
    difficulty,
    estimate,
    confidence,
    signalBreakdown: signals,
    method: 'heuristic-selfplay',
    at: new Date().toISOString(),
  };

  // 覆盖 builder 的初始难度（若有）
  if (task.evalMeta) task.evalMeta.difficulty = difficulty;

  episode.calibration = calibration;
  episode.status = STATE_MACHINE.CALIBRATED;
  episode.provenance.push({
    stage: 'calibrate',
    at: new Date().toISOString(),
    detail: `difficulty=${difficulty} (estimate ${estimate.toFixed(2)}, confidence ${confidence.toFixed(2)})`,
  });
  return calibration;
}

/** 领域先验：难度越高的域权重越大 */
function domainPriorFor(domain) {
  const priors = { reasoning: 0.6, tool: 0.7, planning: 0.8, safety: 0.5, multimodal: 0.8, knowledge: 0.4 };
  return priors[domain] ?? 0.5;
}

/** 统计消息中的失败-修正次数 */
function countRetries(messages) {
  const re = /\b(?:error|fail(?:ed)?|not working|doesn'?t work|let me try)\b|不行|失败|报错|出错|重新|再来/i;
  let n = 0;
  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (re.test(c)) n++;
  }
  return Math.min(5, n);
}

export const DIFFICULTY_LEVELS = EVAL_ENUMS.DIFFICULTY;
