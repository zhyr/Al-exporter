/**
 * Annotator — 人工标注与评论修改（Human Annotation & Review）
 *
 * 提供：
 *   1. 人工标注（label：valid / invalid / needs_fix，附加评论）
 *   2. 评论修改（追加评审意见，可附带修改 prompt / groundTruth / 验收标准）
 *   3. 标注流水线（多轮 reviewer 审阅，所有标注进入 provenance 审计链）
 */
import crypto from 'node:crypto';
import { GATE_DECISIONS } from './schema.js';

const LABELS = Object.freeze(['valid', 'invalid', 'needs_fix']);

/**
 * 添加标注/评论
 * @param {object} episode
 * @param {object} input { label?, content, by, modify? }
 * @returns {object} annotation
 */
export function addAnnotation(episode, { label, content, by = 'human', modify = null } = {}) {
  if (label && !LABELS.includes(label)) throw new Error(`invalid label: ${label}（可选: ${LABELS.join(', ')}）`);

  const annotation = {
    id: crypto.randomUUID(),
    label: label || 'comment',
    content: String(content || '').trim(),
    by,
    at: new Date().toISOString(),
  };

  // 支持评论修改（结构化回写）
  if (modify) {
    if (modify.prompt !== undefined) {
      episode.prompt = modify.prompt;
      annotation.modified = { ...(annotation.modified || {}), prompt: modify.prompt };
    }
    if (modify.groundTruth !== undefined) {
      episode.groundTruth = modify.groundTruth;
      annotation.modified = { ...(annotation.modified || {}), groundTruth: modify.groundTruth };
    }
    if (modify.acceptanceCriteria !== undefined && episode.task) {
      episode.task.acceptanceCriteria = modify.acceptanceCriteria;
      annotation.modified = { ...(annotation.modified || {}), acceptanceCriteria: modify.acceptanceCriteria };
    }
    if (modify.instructions !== undefined && episode.task) {
      episode.task.instructions = modify.instructions;
      annotation.modified = { ...(annotation.modified || {}), instructions: modify.instructions };
    }
  }

  episode.annotations = episode.annotations || [];
  episode.annotations.push(annotation);

  // 标注 invalid → 任务回到构建前（供修复后重新构建）；needs_fix → 置 review 标记
  if (label === 'invalid' && episode.status !== 'rejected') {
    episode.status = 'failed';
    if (episode.gate) episode.gate.decision = GATE_DECISIONS.REVIEW;
  }
  if (label === 'needs_fix' && episode.gate) {
    episode.gate.needsReview = true;
  }

  episode.provenance.push({
    stage: 'annotate',
    at: annotation.at,
    detail: `annotation ${annotation.id} by ${by}: ${label || 'comment'}${modify ? ' (with modifications)' : ''}`,
  });
  return annotation;
}

/**
 * 获取所有标注（按时间排序）
 */
export function listAnnotations(episode) {
  return [...(episode.annotations || [])].sort((a, b) => (a.at < b.at ? -1 : 1));
}

/**
 * 更新标注状态（e.g. 标记已解决）
 */
export function resolveAnnotation(episode, annotationId, resolved = true, by = 'human') {
  const ann = (episode.annotations || []).find((a) => a.id === annotationId);
  if (!ann) throw new Error(`annotation not found: ${annotationId}`);
  ann.resolved = resolved;
  ann.resolvedAt = new Date().toISOString();
  ann.resolvedBy = by;
  episode.provenance.push({
    stage: 'annotate:resolve',
    at: new Date().toISOString(),
    detail: `annotation ${annotationId} resolved=${resolved} by ${by}`,
  });
  return ann;
}

export const VALID_LABELS = LABELS;
