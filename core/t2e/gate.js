/**
 * Candidate Gate — 候选门控路由（借鉴 EvoTrace /review Candidate Gate + fail-closed）
 *
 * 输入：已打分 episode
 * 决策：accept（进入构建）/ review（人工复核）/ reject（失败关闭，不进入下游）
 *
 * 门控规则（保守设计）：
 *   - 安全分 < 0.7            → reject（敏感/有害内容一票否决）
 *   - 总分 < acceptThreshold   → reject
 *   - 总分 < reviewThreshold  → review（人工复核）
 *   - 重复指纹（全局）          → reject（多样性保护）
 *   - 证据缺失（无结论/无工具）  → reject（弱轨迹）
 */
import { GATE_DECISIONS, STATE_MACHINE } from './schema.js';
import { fingerprint } from './evidence.js';

export const DEFAULT_THRESHOLDS = Object.freeze({
  accept: 0.6,
  review: 0.4,
  safetyFloor: 0.7,
  minEvidence: 3, // 至少命中 N 个正向证据信号
});

/**
 * 对单个 episode 执行门控
 * @param {object} episode
 * @param {object} opts
 * @param {Set<string>} opts.seenFingerprints - 全局已见指纹（就地更新）
 * @returns {{decision, reasons, evidence}}
 */
export function gateEpisode(episode, { thresholds = DEFAULT_THRESHOLDS, seenFingerprints = new Set() } = {}) {
  const reasons = [];
  const scores = episode.evidence?.scores || {};
  const score = episode.evidence?.score || 0;
  const raw = episode.evidence?.raw || {};

  // 1. 安全一票否决
  const safety = scores.safety ?? 1;
  if (safety < thresholds.safetyFloor) {
    return fail(episode, `safety score ${safety} < floor ${thresholds.safetyFloor}`, reasons);
  }

  // 2. 弱轨迹（fail-closed）
  const positiveSignals = countPositiveSignals(scores);
  if (positiveSignals < thresholds.minEvidence) {
    reasons.push(`only ${positiveSignals}/${thresholds.minEvidence} positive evidence signals`);
    if (score < thresholds.accept) {
      return fail(episode, `weak trajectory: score ${score} below accept ${thresholds.accept}`, reasons);
    }
  }

  // 3. 多样性（全局指纹去重）
  const fp = fingerprint(episode.prompt);
  if (seenFingerprints.has(fp)) {
    reasons.push('duplicate prompt fingerprint (diversity protection)');
    return fail(episode, 'duplicate trajectory', reasons);
  }
  seenFingerprints.add(fp);

  // 4. 总分路由
  if (score >= thresholds.accept) {
    return {
      decision: GATE_DECISIONS.ACCEPT,
      reasons: [...reasons, `score ${score} >= accept ${thresholds.accept}`],
      score,
    };
  }
  if (score >= thresholds.review) {
    return {
      decision: GATE_DECISIONS.REVIEW,
      reasons: [...reasons, `score ${score} in review band [${thresholds.review}, ${thresholds.accept})`],
      score,
    };
  }
  return fail(episode, `score ${score} below review ${thresholds.review}`, reasons);
}

/**
 * 批量门控：路由 episodes 到 accept / review / reject，并更新状态。
 * @param {Array<object>} episodes
 * @param {object} opts
 * @returns {{accepted, review, rejected}}
 */
export function gateEpisodes(episodes, opts = {}) {
  const seen = new Set();
  const result = { accepted: [], review: [], rejected: [] };
  for (const ep of episodes) {
    const g = gateEpisode(ep, { ...opts, seenFingerprints: seen });
    ep.gate = { decision: g.decision, reasons: g.reasons, score: g.score, at: new Date().toISOString() };
    if (g.decision === GATE_DECISIONS.ACCEPT) {
      ep.status = STATE_MACHINE.GATED;
      result.accepted.push(ep);
    } else if (g.decision === GATE_DECISIONS.REVIEW) {
      ep.status = STATE_MACHINE.GATED; // 待人工复核，但不算失败
      ep.gate.needsReview = true;
      result.review.push(ep);
    } else {
      ep.status = STATE_MACHINE.REJECTED;
      result.rejected.push(ep);
    }
    ep.provenance.push({
      stage: 'gate',
      at: new Date().toISOString(),
      detail: `${g.decision}: ${g.reasons.join('; ')}`,
    });
  }
  return result;
}

/** 人工门控决策（标注界面调用）：允许把 review/rejected 手动改为 accept */
export function manualGate(episode, decision, by = 'human', note = '') {
  if (!Object.values(GATE_DECISIONS).includes(decision)) {
    throw new Error(`invalid gate decision: ${decision}`);
  }
  episode.gate = {
    decision,
    reasons: [`manual ${decision} by ${by}`, ...(note ? [note] : [])],
    score: episode.evidence?.score || 0,
    at: new Date().toISOString(),
    by,
  };
  episode.status = decision === GATE_DECISIONS.REJECT ? STATE_MACHINE.REJECTED : STATE_MACHINE.GATED;
  episode.provenance.push({
    stage: 'gate:manual',
    at: new Date().toISOString(),
    detail: `${decision} by ${by}${note ? ` — ${note}` : ''}`,
  });
  return episode;
}

function fail(episode, reason, reasons) {
  return {
    decision: GATE_DECISIONS.REJECT,
    reasons: [...reasons, reason],
    score: episode.evidence?.score || 0,
  };
}

function countPositiveSignals(scores) {
  const thresholds = {
    completeness: 0.5,
    executability: 0.4,
    info_density: 0.4,
    safety: 0.9,
  };
  return Object.entries(thresholds).filter(([k, v]) => (scores[k] || 0) >= v).length;
}
