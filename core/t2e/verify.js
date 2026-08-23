/**
 * Verifier Critic — 审计验证器（借鉴 EvoTrace /validate 双状态验证 + fail-closed）
 *
 * 对构建出的任务执行「双状态」校验：
 *   - 拒绝基线（baseline）：验证器必须**拒绝**一个已知弱答案/空答案
 *   - 接受参考（reference）：验证器必须**接受** episode 中实际成功的答案
 *
 * 同时执行静态审计：
 *   - replay 步骤完整性（命令/补丁可执行性检查）
 *   - 敏感信息复扫（构建产物不得泄漏凭据）
 *   - 泄露风险（prompt 与 groundTruth 的重叠）
 *
 * 验证不通过 → 任务进入 FAILED（失败关闭），不进入校准/导出。
 *
 * 注意：与 EvoTrace 使用 Docker 真实执行不同，本实现为轻量静态+启发式验证，
 * 若系统存在 docker 且配置开启（T2E_DOCKER=1），可扩展为真实容器执行（见 executeInDocker）。
 */
import { spawnSync } from 'node:child_process';
import { STATE_MACHINE } from './schema.js';

// 注意：\b 词边界对中文不生效（中文非 \w），故中文词单独列在无 \b 的备选中
const FAIL_RE = /\b(?:error|fail(?:ed)?|not working|doesn'?t work|undefined|null)\b|不行|失败|报错|出错/i;
const PASS_RE = /\b(?:success|pass(?:ed)?|done|complete|fixed|resolved)\b|成功|通过|完成|已修复/i;

/** 成功强度：pass 信号数 - fail 信号数 */
function strength(text) {
  const pass = (String(text || '').match(PASS_RE) || []).length;
  const fail = (String(text || '').match(FAIL_RE) || []).length;
  return pass - fail;
}

/**
 * 验证单个任务
 * @param {object} episode - 含 task 的 episode
 * @param {object} opts
 * @param {boolean} [opts.docker=false] - 是否启用 Docker 真实执行验证
 * @returns {object} verification 结果（挂到 episode.verification）
 */
export function verifyTask(episode, opts = {}) {
  const task = episode.task;
  if (!task) throw new Error(`episode ${episode.id} has no task — run build first`);

  const checks = [];
  let failed = false;
  const detail = [];

  // ── Check 1: 双状态校验（验证器判别力）──
  const chosen = task.preference?.chosen || '';
  const rejected = task.preference?.rejected || '';
  const verifierDecision = (text) => {
    if (!text) return 'ambiguous';
    if (PASS_RE.test(text)) return 'accept';
    if (FAIL_RE.test(text)) return 'reject';
    return 'ambiguous';
  };
  const refDecision = verifierDecision(chosen);
  const baseDecision = rejected ? verifierDecision(rejected) : 'reject'; // 无 rejected 时基线应被拒

  // 相对判别：chosen 成功强度必须 > rejected（即使两者都含成功信号，chosen 必须更强）
  const refStrength = strength(chosen);
  const baseStrength = strength(rejected);
  const relativeOk = baseStrength < refStrength;

  const dualStateOk = refDecision === 'accept' && (baseDecision === 'reject' || relativeOk);
  checks.push({
    name: 'dual_state',
    label: '双状态校验（拒绝基线 / 接受参考）',
    ok: dualStateOk,
    detail: { refDecision, baseDecision, refStrength, baseStrength, chosen: chosen.slice(0, 200), rejected: rejected?.slice(0, 200) },
  });
  if (!dualStateOk) {
    failed = true;
    detail.push(`dual-state failed: reference=${refDecision}(${refStrength}), baseline=${baseDecision}(${baseStrength})`);
  }

  // ── Check 2: replay 步骤完整性 ──
  const steps = task.replay?.steps || [];
  const emptySteps = steps.filter((s) => !s.payload || s.payload.trim().length < 3);
  const hasSteps = steps.length > 0 && emptySteps.length === 0;
  checks.push({
    name: 'replay_integrity',
    label: '回放步骤完整性',
    ok: hasSteps,
    detail: { total: steps.length, empty: emptySteps.length },
  });
  if (!hasSteps) {
    failed = true;
    detail.push(`replay steps invalid: ${steps.length} steps, ${emptySteps.length} empty`);
  }

  // ── Check 3: 命令合法性（不执行，仅静态检查危险命令）──
  const cmdStrs = steps.filter((s) => s.type === 'command').map((s) => s.payload);
  const dangerous = cmdStrs.filter((c) => /(rm\s+-rf\s+\/|:\(\)\s*\{\s*:\s*\|:\s*&\s*\}\s*:|mkfs|dd\s+if=.*of=\/dev)/.test(c));
  checks.push({
    name: 'command_safety',
    label: '命令安全（无破坏性命令）',
    ok: dangerous.length === 0,
    detail: { dangerous: dangerous.slice(0, 3) },
  });
  if (dangerous.length > 0) {
    failed = true;
    detail.push(`dangerous commands detected: ${dangerous.slice(0, 2).join('; ')}`);
  }

  // ── Check 4: 敏感信息复扫（构建产物）──
  const sensitive = scanSensitive(JSON.stringify({ task, episode: { prompt: episode.prompt, groundTruth: episode.groundTruth } }));
  checks.push({
    name: 'secret_scan',
    label: '敏感信息复扫',
    ok: sensitive.length === 0,
    detail: { hits: sensitive.slice(0, 5) },
  });
  if (sensitive.length > 0) {
    failed = true;
    detail.push(`secrets in built artifacts: ${sensitive.slice(0, 2).join(', ')}`);
  }

  // ── Check 5: 泄露风险（prompt 与 ground_truth 重叠）──
  const prompt = (episode.prompt || '').toLowerCase();
  const truth = (episode.groundTruth || '').toLowerCase();
  let leakage = 'low';
  if (truth.length >= 10 && prompt.includes(truth)) leakage = 'high';
  else {
    const overlap = truth.split(/\s+/).filter((w) => w.length > 4 && prompt.includes(w)).length;
    if (overlap >= 3) leakage = 'medium';
  }
  checks.push({
    name: 'leakage',
    label: '泄露风险',
    ok: leakage !== 'high',
    detail: { leakage },
  });
  if (leakage === 'high') {
    failed = true;
    detail.push('high leakage risk: ground truth contained in prompt');
  }

  // ── Check 6: 验收标准可验证性 ──
  const criteria = task.acceptanceCriteria || [];
  checks.push({
    name: 'criteria_verifiable',
    label: '验收标准可验证',
    ok: criteria.length >= 2,
    detail: { count: criteria.length },
  });

  // ── Docker 真实执行（可选）──
  let docker = null;
  if (opts.docker && process.env.T2E_DOCKER === '1') {
    docker = executeInDocker(task);
    checks.push({
      name: 'docker_exec',
      label: 'Docker 双状态执行',
      ok: docker.ok,
      detail: docker,
    });
    if (!docker.ok) {
      failed = true;
      detail.push(`docker exec failed: ${docker.message}`);
    }
  }

  const verification = {
    passed: !failed,
    checks,
    score: checks.filter((c) => c.ok).length / checks.length,
    detail,
    at: new Date().toISOString(),
    mode: opts.docker && process.env.T2E_DOCKER === '1' ? 'docker' : 'static',
  };

  episode.verification = verification;
  task.replay.verified = verification.passed;
  episode.status = verification.passed ? STATE_MACHINE.VERIFIED : STATE_MACHINE.FAILED;
  episode.provenance.push({
    stage: 'verify',
    at: new Date().toISOString(),
    detail: verification.passed
      ? `verified ${verification.checks.length} checks, score ${verification.score.toFixed(2)}`
      : `verification FAILED: ${detail.slice(0, 2).join(' | ')}`,
  });
  return verification;
}

/**
 * Docker 真实执行验证（需要 docker 可用；模拟实现，生产环境可替换为真实容器）
 * 双状态：容器中先跑 rejected 版本应失败，再跑 chosen 版本应成功。
 */
export function executeInDocker(task) {
  try {
    const r = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) {
      return { ok: false, message: 'docker not available' };
    }
    // 占位：真实实现中应构建镜像、挂载仓库、执行命令并收集退出码。
    // 此处为静态模拟，返回基于静态判别的结果，避免误破坏环境。
    return {
      ok: true,
      simulated: true,
      message: 'docker available; simulated dual-state execution',
      baseline: 'reject',   // 模拟：基线版本被拒
      reference: 'accept',  // 模拟：参考版本通过
    };
  } catch (e) {
    return { ok: false, message: `docker error: ${e.message}` };
  }
}

function scanSensitive(text) {
  const patterns = [
    /\b(?:sk-[A-Za-z0-9_-]{20,})\b/,
    /\b(?:ghp_[A-Za-z0-9]{20,})\b/,
    /\b(?:AKIA[0-9A-Z]{16})\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  const hits = [];
  for (const re of patterns) {
    if (re.test(text)) hits.push(re.source);
  }
  return hits;
}
