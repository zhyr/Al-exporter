/**
 * Transfer2Eval 数据模型与状态机定义
 * 借鉴 EvoTrace：Mined → Gated → Built → Verified → Calibrated → Exported
 * 门控/验证失败进入 Rejected（fail-closed）
 */

export const STATE_MACHINE = Object.freeze({
  // 生命周期状态
  MINED: 'mined',             // 已从原始轨迹切分为 episode
  GATED: 'gated',             // 通过门控路由（accept/review）
  BUILT: 'built',             // 已构建为可回放任务（task + preference + rl + reward）
  VERIFIED: 'verified',       // 通过审计验证（双状态校验）
  CALIBRATED: 'calibrated',   // 通过难度校准
  EXPORTED: 'exported',       // 已导出数据集
  // 失败关闭状态
  REJECTED: 'rejected',       // 门控拒绝（弱轨迹）
  FAILED: 'failed',           // 构建/验证失败
});

export const STAGE_ORDER = Object.freeze([
  STATE_MACHINE.MINED,
  STATE_MACHINE.GATED,
  STATE_MACHINE.BUILT,
  STATE_MACHINE.VERIFIED,
  STATE_MACHINE.CALIBRATED,
  STATE_MACHINE.EXPORTED,
]);

/** 门控路由决策（借鉴 EvoTrace /review 四角色顺序编排） */
export const GATE_DECISIONS = Object.freeze({
  ACCEPT: 'accept',
  REVIEW: 'review',   // 需要人工复核
  REJECT: 'reject',   // fail-closed
});

/** 证据维度（Episode Miner 打分） */
export const EVIDENCE_DIMENSIONS = Object.freeze({
  COMPLETENESS: 'completeness',         // 轨迹完整性（有指令/有执行/有结论）
  EXECUTABILITY: 'executability',       // 可执行性（工具调用序列完备、命令可复现）
  INFO_DENSITY: 'info_density',         // 信息密度（有效 token 占比、代码变更量）
  SAFETY: 'safety',                     // 安全性（无有害内容、无凭据泄漏）
  DIVERSITY: 'diversity',               // 多样性（问题类型、领域覆盖）
});

/** 数据集产物类型 */
export const ARTIFACT_TYPES = Object.freeze({
  PREFERENCE: 'preference',         // 偏好数据（chosen / rejected）
  REPLAYABLE_TASK: 'replayable_task', // 可回放编码任务
  RL_ENV: 'rl_env',                 // RL 环境（state / action_space / reward_candidates）
  REWARD_CANDIDATE: 'reward_candidate', // 执行奖励候选
  AUDIT_REPORT: 'audit_report',     // 审计验证报告
});

/** 下游目标（数据集消费者） */
export const DOWNSTREAM_TARGETS = Object.freeze({
  EVAL: 'eval',                     // Internal LLM/VLM Evaluation（questions.csv）
  CMS_SFT: 'cms_sft',               // Internal CMS KnowledgeBase SFT（prompt_response）
  CMS_DPO: 'cms_dpo',               // Internal CMS KnowledgeBase DPO（prompt_chosen_rejected）
});

/** Eval CSV 枚举（与 Internal LLM/VLM Evaluation 对齐） */
export const EVAL_ENUMS = Object.freeze({
  DOMAIN: ['knowledge', 'reasoning', 'tool', 'planning', 'safety', 'multimodal'],
  TASK_TYPE: [
    'closed_qa', 'open_qa', 'fact_verification', 'multi_hop', 'temporal', 'logic', 'math',
    'causal', 'analogical', 'commonsense', 'calculator', 'search', 'database_query',
    'api_orchestration', 'multi_tool_chain', 'travel_planning', 'workflow_design',
    'project_planning', 'optimization', 'harmful_request', 'jailbreak', 'prompt_injection',
    'image_caption', 'visual_qa', 'chart_reasoning', 'cross_modal_reasoning',
  ],
  DIFFICULTY: ['L1', 'L2', 'L3', 'L4'],
  SPLIT: ['seed_train', 'dev_eval', 'private_test', 'candidate_generated'],
  MODALITY: ['text', 'image', 'chart', 'mixed'],
  SOURCE: ['human', 'external_mapped', 'llm_generated', 'adversarial'],
  SCORING_TYPE: ['exact_match', 'rule_based', 'llm_judge', 'human_only', 'hybrid'],
  REVIEW_STATUS: ['draft', 'validated', 'locked'],
  LEAKAGE_RISK: ['low', 'medium', 'high'],
});

/** 工具 → Eval domain 映射（启发式，供 builder 使用） */
export const TOOL_DOMAIN_MAP = Object.freeze({
  cursor: 'tool',
  claude: 'reasoning',
  codex: 'tool',
  windsurf: 'tool',
  trae: 'tool',
  traework: 'tool',
  qoder: 'tool',
  augment: 'reasoning',
  antigravity: 'tool',
  iflow: 'tool',
  codebuddy: 'reasoning',
  workbuddy: 'tool',
  zcode: 'tool',
  kiro: 'tool',
  zed: 'tool',
  copilot: 'tool',
  forge: 'tool',
  chatgpt: 'reasoning',
  doubao: 'reasoning',
});

/**
 * 创建空 Episode
 * @param {object} init
 */
export function createEpisode(init = {}) {
  return {
    id: init.id,
    source: init.source,
    project: init.project,
    threadId: init.threadId,
    tool: init.tool,
    title: init.title || '',
    summary: init.summary || '',
    prompt: init.prompt || '',          // 原始用户请求（任务指令）
    groundTruth: init.groundTruth || '', // 期望结果（结论/最终答案）
    messages: init.messages || [],      // 归一化消息序列 [{role, content, toolCalls, timestamp}]
    evidence: init.evidence || {
      scores: {},                       // {completeness: 0-1, ...}
      score: 0,
      reasons: [],
    },
    gate: null,                         // {decision, reasons, at, by}
    task: null,                         // 构建产物（任务规格/偏好/RL/奖励）
    verification: null,                 // 审计验证结果
    calibration: null,                  // 难度校准结果
    annotations: [],                    // 人工标注与评论 [{id, content, label, by, at}]
    status: STATE_MACHINE.MINED,
    provenance: [],                     // 溯源链 [{stage, at, detail}]
    createdAt: init.createdAt || new Date().toISOString(),
    updatedAt: init.updatedAt || new Date().toISOString(),
  };
}

/**
 * 创建空 Task（可回放编码任务）
 */
export function createTask(episode) {
  return {
    id: `task-${episode.id}`,
    episodeId: episode.id,
    title: episode.title,
    instructions: episode.prompt,
    acceptanceCriteria: [],
    repo: null,         // 仓库基线 {path, files, patch, baselineCommit}
    replay: null,       // 请求回放 {steps, verified}
    preference: null,   // {chosen, rejected, reasoning}
    rlEnv: null,        // {state, actionSpace, rewardCandidates}
    rewardCandidates: [],
    status: STATE_MACHINE.BUILT,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 状态迁移校验：允许的下一状态
 */
export function canTransition(from, to) {
  if (from === STATE_MACHINE.REJECTED || from === STATE_MACHINE.FAILED) {
    // 失败关闭状态仅允许重新挖掘（人工重置）
    return to === STATE_MACHINE.MINED;
  }
  const fromIdx = STAGE_ORDER.indexOf(from);
  const toIdx = STAGE_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx === fromIdx + 1;
}
