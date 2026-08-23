/**
 * Task Builder — 任务构建器（借鉴 EvoTrace Task Builder）
 *
 * 将已通过门控的 Episode 编译为四种可复用资产：
 *   1. Replayable Task  — 可回放编码任务（指令 + 验收标准 + 仓库基线 + 回放步骤）
 *   2. Preference Data  — 偏好数据（chosen = 主轨迹最终答案 / rejected = 失败尝试或弱响应）
 *   3. RL Environment   — 状态 + 动作空间 + 转换描述（供 RL 训练）
 *   4. Reward Candidate — 执行奖励候选（成功信号 / 中间奖励）
 *
 * 构建产物全部挂到 episode.task 上，并产生独立 task 记录。
 */
import { createTask, STATE_MACHINE, EVAL_ENUMS, TOOL_DOMAIN_MAP } from './schema.js';

/**
 * 构建任务（含四种资产）
 * @param {object} episode - 已 gated 的 episode
 * @param {object} opts
 * @returns {object} task
 */
export function buildTask(episode, opts = {}) {
  const {
    repo = null,           // {path, files:[], patch, baselineCommit}
    extraCriteria = [],
  } = opts;

  const task = createTask(episode);
  const messages = episode.messages || [];
  const userMsgs = messages.filter((m) => m.role === 'user').map((m) => str(m.content));
  const asstMsgs = messages.filter((m) => m.role === 'assistant').map((m) => str(m.content));

  // ── 1. 可回放任务规格 ──
  task.repo = repo;
  task.acceptanceCriteria = buildAcceptanceCriteria(asstMsgs, extraCriteria);
  task.replay = buildReplay(messages);

  // ── 2. 偏好数据 ──
  task.preference = buildPreference(episode, userMsgs, asstMsgs);

  // ── 3. RL 环境 ──
  task.rlEnv = buildRlEnv(episode, task.replay);

  // ── 4. 执行奖励候选 ──
  task.rewardCandidates = buildRewardCandidates(task.replay, asstMsgs);

  // Eval 元信息（供 export 映射）
  task.evalMeta = {
    domain: mapDomain(episode.tool),
    taskType: inferTaskType(episode.prompt, task.replay),
    difficulty: inferDifficulty(task),
    scoringType: inferScoringType(task),
    source: 'llm_generated',
  };

  task.status = STATE_MACHINE.BUILT;
  episode.task = task;
  episode.status = STATE_MACHINE.BUILT;
  episode.provenance.push({
    stage: 'build',
    at: new Date().toISOString(),
    detail: `built task ${task.id} with ${task.replay?.steps?.length || 0} replay steps, ${task.rewardCandidates.length} reward candidates`,
  });
  return task;
}

// ─── 构建子逻辑 ───────────────────────────────────────────────────────────────

function buildAcceptanceCriteria(asstMsgs, extra) {
  const criteria = [];
  const all = asstMsgs.join('\n');
  // 从结论中提取可验证信号
  if (/\btests? pass/i.test(all) || /测试通过|测试全部通过/.test(all)) {
    criteria.push('All tests pass');
  }
  if (/build succeeded|编译通过|构建成功/.test(all)) {
    criteria.push('Build succeeds without errors');
  }
  if (/fix|修复|resolved|fixed/.test(all)) {
    criteria.push('Reported issue is resolved');
  }
  if (/lint|eslint|format/i.test(all) && /no error/i.test(all)) {
    criteria.push('Lint check passes with no errors');
  }
  if (criteria.length === 0) {
    criteria.push('Agent must produce a working implementation that satisfies the user request');
    criteria.push('Agent must explain its approach and confirm completion');
  }
  return [...criteria, ...extra];
}

/** 从消息中提取可回放的步骤（命令/工具调用序列） */
function buildReplay(messages) {
  const steps = [];
  for (const m of messages) {
    const content = str(m.content);
    // 提取 bash 命令块
    const cmdRe = /```(?:bash|sh|shell|terminal)\n([\s\S]*?)```/g;
    let mm;
    while ((mm = cmdRe.exec(content)) !== null) {
      steps.push({ type: 'command', payload: mm[1].trim(), source: 'codeblock' });
    }
    // 提取内联 $ 命令
    const inlineRe = /^[ \t]*[>$]\s+(.+)$/gm;
    while ((mm = inlineRe.exec(content)) !== null) {
      const cmd = mm[1].trim();
      if (cmd && !cmd.startsWith('#')) steps.push({ type: 'command', payload: cmd, source: 'inline' });
    }
    // 提取文件写入
    const fileRe = /```(?:diff|patch)\n([\s\S]*?)```/g;
    while ((mm = fileRe.exec(content)) !== null) {
      steps.push({ type: 'patch', payload: mm[1].trim(), source: 'diff' });
    }
  }
  // 去重（按 payload）
  const seen = new Set();
  const unique = steps.filter((s) => {
    if (seen.has(s.payload)) return false;
    seen.add(s.payload);
    return true;
  });
  return {
    steps: unique.slice(0, 50),
    verified: null, // 由 verifier 填充
  };
}

/**
 * 偏好数据构建：
 *  chosen = 最终 assistant 结论（主轨迹，通常是最佳）
 *  rejected = 若轨迹中有显式的失败/撤回/修正尝试，取其作为 rejected；否则取中间轮次
 */
function buildPreference(episode, userMsgs, asstMsgs) {
  if (asstMsgs.length === 0) return null;
  const prompt = userMsgs[0] || episode.prompt;
  const chosen = asstMsgs[asstMsgs.length - 1];

  const failRe = /\b(?:error|fail(?:ed)?|not working|doesn'?t work)\b|不行|失败|报错|出错/i;
  const passRe = /\b(?:pass(?:ed)?|success|fixed|resolved)\b|成功|通过|完成/i;

  let rejected = null;
  let rejectedReason = '';

  // 1. 显式失败尝试（最高优先级）
  for (let i = asstMsgs.length - 2; i >= 0; i--) {
    if (failRe.test(asstMsgs[i])) {
      rejected = asstMsgs[i];
      rejectedReason = 'intermediate attempt contains explicit failure signals';
      break;
    }
  }
  // 2. 无成功结论的中间轮次（对验证器有判别力）
  if (!rejected && asstMsgs.length >= 2) {
    for (let i = asstMsgs.length - 2; i >= 0; i--) {
      if (!passRe.test(asstMsgs[i])) {
        rejected = asstMsgs[i];
        rejectedReason = 'intermediate attempt lacks completion signal';
        break;
      }
    }
  }
  // 3. 兜底：中间轮次中最短的（弱结论）
  if (!rejected && asstMsgs.length >= 2) {
    const mid = Math.floor((asstMsgs.length - 1) / 2);
    // 选择与 chosen 最不相似（重叠最少）的中间轮次
    let bestIdx = mid;
    let bestOverlap = Infinity;
    for (let i = 0; i < asstMsgs.length - 1; i++) {
      const a = asstMsgs[i].split(/\s+/);
      const b = chosen.split(/\s+/);
      const setA = new Set(a);
      const overlap = b.filter((w) => setA.has(w)).length;
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    rejected = asstMsgs[bestIdx];
    rejectedReason = 'no explicit failed attempt; selected least-similar intermediate as negative sample';
  }

  return {
    chosen,
    rejected,
    reasoning: rejected
      ? rejectedReason + '; chosen is the final resolution'
      : 'no explicit failed attempt; chosen is the final assistant response',
    format: 'prompt_chosen_rejected', // 与 CMS DPO 对齐
  };
}

function buildRlEnv(episode, replay) {
  const files = episode.messages
    .flatMap((m) => {
      const c = str(m.content);
      const fRe = /(?:`([\w./-]+\.(?:js|ts|py|tsx|jsx|go|rs|java|json|css|html|md))`)/g;
      const hits = [];
      let mm;
      while ((mm = fRe.exec(c)) !== null) hits.push(mm[1]);
      return hits;
    })
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 20);

  return {
    state: {
      description: `Repository with files: ${files.length > 0 ? files.join(', ') : 'unknown'}`,
      files,
      initialPrompt: episode.prompt,
    },
    actionSpace: [
      { name: 'write_file', description: 'Write or modify a file' },
      { name: 'run_command', description: 'Execute a shell command (test/build)' },
      { name: 'read_file', description: 'Read a file' },
      { name: 'search', description: 'Search codebase' },
      { name: 'final_answer', description: 'Produce the final response' },
    ],
    transitions: {
      write_file: 'updates repo state',
      run_command: 'produces observable output (success/failure)',
      final_answer: 'terminates episode with final message',
    },
    terminal: 'final_answer',
  };
}

/**
 * 执行奖励候选：从成功信号中推导稀疏奖励 + 从步骤推导中间奖励
 */
function buildRewardCandidates(replay, asstMsgs) {
  const candidates = [];
  const all = asstMsgs.join('\n');

  const testPass = /\btests? pass|测试通过|all green/i.test(all);
  const buildOk = /build succeeded|编译通过|构建成功/i.test(all);
  const hasPatch = replay.steps.some((s) => s.type === 'patch');
  const hasCmd = replay.steps.some((s) => s.type === 'command');

  // 稀疏成功奖励
  candidates.push({
    type: 'sparse',
    signal: 'task_completion',
    description: '1.0 if agent reaches a conclusion with completion signal, else 0.0',
    value: testPass || buildOk ? 1.0 : 0.0,
  });
  // 测试通过奖励
  if (testPass) {
    candidates.push({ type: 'sparse', signal: 'tests_pass', description: '1.0 if tests pass', value: 1.0 });
  }
  // 中间奖励：命令执行成功（基于有无明确失败词）
  const hasFailure = /error|fail|失败|报错/i.test(all);
  candidates.push({
    type: 'shaped',
    signal: 'command_success',
    description: '+0.1 per successful command, -0.2 on failure',
    value: hasCmd ? (hasFailure ? -0.2 : 0.1) : 0,
  });
  // 过程奖励：产生补丁
  candidates.push({
    type: 'shaped',
    signal: 'patch_produced',
    description: '+0.3 when a code patch is produced',
    value: hasPatch ? 0.3 : 0,
  });
  // 长度惩罚
  candidates.push({
    type: 'shaped',
    signal: 'verbosity_penalty',
    description: '-0.01 per 1k tokens of redundant output',
    value: -0.01,
  });

  return candidates;
}

// ─── Eval 元信息映射 ──────────────────────────────────────────────────────────

function mapDomain(tool) {
  const mapped = TOOL_DOMAIN_MAP[tool];
  if (mapped && EVAL_ENUMS.DOMAIN.includes(mapped)) return mapped;
  return 'reasoning';
}

function inferTaskType(prompt, replay) {
  const p = String(prompt || '');
  if (/\b(?:修复|fix|bug|error|broken)\b/i.test(p)) return 'fact_verification';
  if (/\b(?:测试|test)\b/i.test(p)) return 'workflow_design';
  if (/\b(?:重构|refactor|优化|optimize|improve)\b/i.test(p)) return 'optimization';
  if (/\b(?:规划|plan|roadmap|设计|design)\b/i.test(p)) return 'project_planning';
  if (/\b(?:解释|explain|why|what is|什么是|为什么)\b/i.test(p)) return 'open_qa';
  if (/\b(?:实现|implement|build|create|添加|add|feature)\b/i.test(p)) return 'api_orchestration';
  if (replay?.steps?.some((s) => s.type === 'command')) return 'api_orchestration';
  return 'closed_qa';
}

function inferDifficulty(task) {
  const replayCount = task.replay?.steps?.length || 0;
  const criteriaCount = task.acceptanceCriteria?.length || 0;
  const promptLen = (task.instructions || '').length;
  let level = 1;
  if (replayCount >= 6 || criteriaCount >= 3) level = 3;
  else if (replayCount >= 3 || promptLen > 400) level = 2;
  return EVAL_ENUMS.DIFFICULTY[Math.min(level, 4) - 1] || 'L2';
}

function inferScoringType(task) {
  const hasCmd = task.replay?.steps?.some((s) => s.type === 'command');
  const hasPatch = task.replay?.steps?.some((s) => s.type === 'patch');
  if (hasCmd || hasPatch) return 'rule_based';
  return 'llm_judge';
}

function str(v) {
  return typeof v === 'string' ? v : v ? JSON.stringify(v) : '';
}
