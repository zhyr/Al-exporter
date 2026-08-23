/**
 * Evidence Ranking — 证据排序（借鉴 EvoTrace /candidates 证据排序）
 *
 * 对每个 Episode 的证据信号进行多维打分（0-1），聚合为总分用于门控路由。
 * 打分维度：completeness / executability / info_density / safety / diversity
 *
 * 设计原则：分数是**保守的**——证据不足时倾向低分（fail-closed 前置）。
 */
import { EVIDENCE_DIMENSIONS } from './schema.js';

const DIMENSION_WEIGHTS = Object.freeze({
  [EVIDENCE_DIMENSIONS.COMPLETENESS]: 0.25,
  [EVIDENCE_DIMENSIONS.EXECUTABILITY]: 0.25,
  [EVIDENCE_DIMENSIONS.INFO_DENSITY]: 0.20,
  [EVIDENCE_DIMENSIONS.SAFETY]: 0.20,
  [EVIDENCE_DIMENSIONS.DIVERSITY]: 0.10,
});

/**
 * 为 episode 计算证据分数（就地写回 episode.evidence 并返回 episode）
 * @param {object} episode
 * @param {object} opts
 * @returns {object} episode（其 evidence 含 scores/score/reasons）
 */
export function scoreEpisode(episode, opts = {}) {
  const raw = episode.evidence?.raw || {};
  const reasons = [];
  const scores = {};

  // 1. Completeness — 指令 + 执行 + 结论齐全
  let completeness = 0;
  if (raw.userText && raw.userText.trim().length >= 8) completeness += 0.4;
  if (raw.assistantMessageCount > 0) completeness += 0.3;
  if (raw.hasConclusion) {
    completeness += 0.3;
    reasons.push('has conclusion signal');
  } else {
    reasons.push('missing conclusion signal');
  }
  scores[EVIDENCE_DIMENSIONS.COMPLETENESS] = clamp01(completeness);

  // 2. Executability — 工具调用/命令序列可复现
  let executability = 0;
  if (raw.hasToolCall || raw.toolCallCount > 0) executability += 0.4;
  executability += Math.min(0.3, (raw.toolCalls?.length || 0) * 0.1);
  if ((raw.toolCalls?.length || 0) >= 2 && raw.hasConclusion) executability += 0.3;
  if (raw.toolCallCount === 0) reasons.push('no executable tool calls found');
  scores[EVIDENCE_DIMENSIONS.EXECUTABILITY] = clamp01(executability);

  // 3. Info density — 有效信息占比（代码变更 + 输出长度适中）
  let infoDensity = 0;
  const codeBytes = (raw.codeBlocks || []).reduce((n, c) => n + c.length, 0);
  if (codeBytes > 0) infoDensity += 0.4;
  const chars = raw.totalChars || 0;
  if (chars >= 200 && chars <= 200_000) infoDensity += 0.3;
  else if (chars > 200_000) reasons.push('overly long episode');
  if ((raw.diffCount || 0) > 0 || (raw.fileCount || 0) > 0) infoDensity += 0.3;
  if (codeBytes === 0 && (raw.diffCount || 0) === 0) reasons.push('no code change evidence');
  scores[EVIDENCE_DIMENSIONS.INFO_DENSITY] = clamp01(infoDensity);

  // 4. Safety — 无敏感信息 / 无有害内容（保守：任一命中即大幅扣分）
  let safety = 1.0;
  if ((raw.sensitiveHits || []).length > 0) {
    safety -= 0.8;
    reasons.push(`sensitive data detected: ${raw.sensitiveHits.slice(0, 2).join(', ')}`);
  }
  if ((raw.harmfulHits || []).length > 0) {
    safety -= 0.9;
    reasons.push(`harmful content detected: ${raw.harmfulHits.slice(0, 2).join(', ')}`);
  }
  if (raw.sensitiveHits?.length === 0 && raw.harmfulHits?.length === 0) {
    safety = 1.0;
  }
  scores[EVIDENCE_DIMENSIONS.SAFETY] = clamp01(safety);

  // 5. Diversity — 与全局已见 prompt 指纹的差异性（该 episode 独立计算，全局更新在外部）
  const diversity = 0.7; // 基线；全局去重在 gate 阶段处理
  scores[EVIDENCE_DIMENSIONS.DIVERSITY] = diversity;

  const total = Object.entries(DIMENSION_WEIGHTS).reduce(
    (sum, [dim, w]) => sum + (scores[dim] || 0) * w,
    0
  );

  episode.evidence = {
    ...(episode.evidence || {}),
    scores,
    score: round3(total),
    reasons: [...new Set(reasons)],
  };
  return episode;
}

/** 全局多样性：基于 prompt 指纹去重标记（供 gate 使用） */
export function fingerprint(prompt) {
  // 归一化：小写、压缩空白、去数字
  const norm = String(prompt || '')
    .toLowerCase()
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = ((h << 5) - h + norm.charCodeAt(i)) | 0;
  }
  return String(Math.abs(h));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

export const WEIGHTS = DIMENSION_WEIGHTS;
