/**
 * Episode Miner — 轨迹挖掘器（借鉴 EvoTrace /init + /review Episode Miner）
 *
 * 输入：统一 schema records（normalizeAll 产物，17+ 工具）
 * 输出：Episode 列表 —— 每个 Episode 是「一个用户请求 + 直到下一请求的完整 agent 轨迹」
 *
 * 职责：
 *   1. 将线程切分为语义完整的 episode（对话回合分组）
 *   2. 提取证据信号（指令、执行步骤、工具调用、代码变更、结论）
 *   3. 隐藏子代理噪音（将 subagent 的内部轮次折叠为 summary）
 *   4. 为证据排序提供原始特征
 */
import crypto from 'node:crypto';
import { createEpisode, STATE_MACHINE } from './schema.js';

/** 工具调用模式（跨工具消息内容） */
const TOOL_CALL_PATTERNS = [
  /```(?:bash|sh|shell|terminal)\s*\n/i,  // shell 代码块
  /\b(?:tool_use|tool_calls|tool_call)\b/i,
  /\b(?:bash|shell|terminal|exec|execute)\s+[-"'`]/i,
  /^[ \t]*[>$]\s+[^\n]{3,}/m,             // 内联 shell 命令
  /\b(?:apply_patch|write_file|create_file|edit_file|insert)\b/i,
  /\b(?:read_file|grep|glob|search)\b/i,
  /\b(?:git\s+(?:commit|push|checkout|apply|diff|log))\b/,
];

/** 结论信号 */
const CONCLUSION_PATTERNS = [
  /\b(?:done|complete|finished|resolved|fixed)\b|成功|完成|已修复|已完成/i,
  /\b(?:test passed|tests? pass(?:ed)?|all green)\b|测试通过/i,
  /\b(?:summary|conclusion)\b|总结|结论/i,
  /\b(?:merge|merged|approved)\b/i,
];

/** 子代理噪音信号 */
const SUBAGENT_PATTERNS = [
  /\b(?:sub-agent|subagent|delegat(?:e|ion))\b/i,
  /\b(?:thinking|planning|research(?:ing)?|explor(?:e|ing))\b/i,
  /\b(?:multi-agent|task agent|code-explorer)\b/i,
];

/** 敏感信息信号（安全证据） */
const SENSITIVE_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9_-]{20,})\b/,          // OpenAI key
  /\b(?:ghp_[A-Za-z0-9]{20,})\b/,           // GitHub PAT
  /\b(?:AKIA[0-9A-Z]{16})\b/,               // AWS AK
  /\b(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/, // private key
  /\b(?:password|passwd|secret)\s*[:=]\s*["'][^"']{6,}["']/i, // creds in code
  /\b(?:Authorization|Bearer)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i,
  /\b(?:api[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i,
];

/** 有害内容信号 */
const HARMFUL_PATTERNS = [
  /\b(?:malware|ransomware|exploit|0-day|buffer overflow)\b/i,
  /\b(?:bypass(?:ing)?\s+(?:security|auth|firewall))\b/i,
  /\b(?:credit card generator|phishing kit)\b/i,
];

/** 联合预筛正则：绝大多数文本不含敏感/有害信号，一次扫描即可短路，避免逐个模式全文匹配 */
const SENSITIVE_JOINT = new RegExp(SENSITIVE_PATTERNS.map((r) => r.source).join('|'), 'i');
const HARMFUL_JOINT = new RegExp(HARMFUL_PATTERNS.map((r) => r.source).join('|'), 'i');

/**
 * 从统一 schema records 挖掘 episodes
 * @param {Array} records - normalizeAll 的输出
 * @param {object} opts
 * @returns {Promise<Array<object>>} episodes
 */
export async function mineEpisodes(records, opts = {}) {
  const {
    minPromptLength = 8,
    maxMessagesPerEpisode = 200,
    collapseSubagents = true,
  } = opts;

  const episodes = [];

  for (const record of records) {
    if (!record || record.type !== 'thread') continue;
    const msgs = record.messages || [];
    if (msgs.length === 0) continue;

    // 按用户请求切分 episode
    const segments = splitByUserTurn(msgs, { minPromptLength, maxMessagesPerEpisode });

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const prompt = firstUserContent(seg);
      if (!prompt || prompt.trim().length < minPromptLength) continue;

      const messages = collapseSubagents ? foldSubagentMessages(seg) : seg;
      const evidence = extractEvidence(messages, record);

      const episode = createEpisode({
        id: makeEpisodeId(record.thread_id, i),
        source: record.meta?.source || 'unknown',
        project: record.meta?.project || 'unknown',
        threadId: record.thread_id,
        tool: record.meta?.source || 'unknown',
        title: makeTitle(prompt),
        summary: makeSummary(messages),
        prompt: prompt.trim(),
        groundTruth: extractGroundTruth(messages),
        messages,
        evidence,
        status: STATE_MACHINE.MINED,
      });

      episode.provenance.push({
        stage: 'mine',
        at: new Date().toISOString(),
        detail: `mined from ${record.meta?.file_path || record.thread_id}`,
      });
      episodes.push(episode);
    }
  }

  return episodes;
}

// ─── 切分 ─────────────────────────────────────────────────────────────────────

/**
 * 按用户消息将消息序列切分为 episode 段。
 * 每个段：1 条用户消息（或连续用户消息的首条）+ 后续直到下一个用户消息。
 * 短促/延续消息（"keep going"、"继续"、"好的"、过短）并入当前段，不开启新 episode。
 */
export function splitByUserTurn(messages, { minPromptLength = 8, maxMessagesPerEpisode = 200 } = {}) {
  const segments = [];
  let current = [];
  let currentHasUser = false;

  for (const m of messages) {
    const isUser = m.role === 'user';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');

    if (isUser && isContinuation(content, minPromptLength)) {
      // 短促/延续消息：并入当前段（段首的延续消息无意义，跳过）
      if (current.length === 0) continue;
      current.push(m);
    } else if (isUser && currentHasUser) {
      // 连续 user 消息：视为新一轮（保留前段；新用户消息开启新段）
      segments.push(current);
      current = [m];
      currentHasUser = true;
    } else if (isUser && current.length > 0) {
      // 已有 assistant 内容后出现新 user → 结束当前段
      segments.push(current);
      current = [m];
      currentHasUser = true;
    } else {
      current.push(m);
      if (isUser) currentHasUser = true;
    }

    if (current.length >= maxMessagesPerEpisode) {
      segments.push(current);
      current = [];
      currentHasUser = false;
    }
  }
  if (current.length > 0) segments.push(current);

  // 过滤掉只有一条空 user 的段
  return segments.filter((seg) => {
    const content = firstUserContent(seg);
    return content && content.trim().length >= minPromptLength;
  });
}

// 延续性指令前缀（"keep going" 等 → 并入当前段而不是开启新任务）
const CONTINUATION_LEAD = [
  /^\s*(?:keep going|keep it up|continue|go on|please continue|go ahead|proceed|and then|next(?: step)?|keep working|keep going and|please keep going|make sure it passes)[,:.!]?\s/i,
  /^\s*(?:继续|接着|接着做|请继续|往下|继续做|继续下去|继续吧)[，。]?\s?/,
];

// 纯确认/收尾短消息
const CONFIRMATION_SHORT = [
  /^\s*(?:ok(?:ay)?|yes|yeah|yep|sure|right|good|great|perfect|done|thanks|thank you|got it|understood|cool|nice|fine|alright|works?|passed|ok ok|all good|looks good)\s*[.!?]*\s*$/i,
  /^\s*(?:好的|好|可以|是的|对|嗯|嗯嗯|谢谢|没问题|明白了|知道了|收到|行|可以了|搞定|不错|好嘞)\s*[.!?。]*\s*$/,
];

/**
 * 判断用户消息是否为延续/短促消息（不应开启新 episode）。
 * 太短、延续指令开头、或纯确认收尾 → 延续。
 */
function isContinuation(content, minPromptLength) {
  const t = content.trim();
  if (!t) return true;
  if (t.length < minPromptLength) return true;
  if (t.length <= 80 && CONTINUATION_LEAD.some((re) => re.test(t))) return true;
  if (t.length <= 30 && CONFIRMATION_SHORT.some((re) => re.test(t))) return true;
  return false;
}

function firstUserContent(segment) {
  const user = segment.find((m) => m.role === 'user');
  if (!user) return null;
  return typeof user.content === 'string' ? user.content : JSON.stringify(user.content || '');
}

function makeEpisodeId(threadId, idx) {
  const h = crypto.createHash('sha1').update(`${threadId}:${idx}`).digest('hex').slice(0, 16);
  return `ep-${h}`;
}

function makeTitle(prompt) {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

// ─── 子代理折叠 ───────────────────────────────────────────────────────────────

/**
 * 折叠子代理噪音：识别 agent 将任务委托给子代理而产生的内部轮次，
 * 用一个 summary 消息替换，保留主 agent 决策链。
 */
export function foldSubagentMessages(messages) {
  const out = [];
  let buffer = [];
  let bufferHasSubagent = false;

  const flush = () => {
    if (buffer.length === 0) return;
    if (bufferHasSubagent) {
      const text = buffer.map((m) => m.content || '').join(' ');
      out.push({
        role: 'assistant',
        content: `[subagent summary] ${text.slice(0, 400)}`,
        folded: true,
      });
    } else {
      out.push(...buffer);
    }
    buffer = [];
    bufferHasSubagent = false;
  };

  for (const m of messages) {
    const isUser = m.role === 'user';
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (isUser) {
      flush();
      out.push(m);
      continue;
    }
    if (SUBAGENT_PATTERNS.some((re) => re.test(text))) {
      bufferHasSubagent = true;
      buffer.push(m);
      continue;
    }
    flush();
    out.push(m);
  }
  flush();
  return out;
}

// ─── 证据提取 ─────────────────────────────────────────────────────────────────

/**
 * 提取 episode 的原始证据特征（供 evidence.js 打分）。
 */
export function extractEvidence(messages, record = {}) {
  const text = messages.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n');
  const userText = messages.filter((m) => m.role === 'user').map((m) => m.content || '').join(' ');
  const assistantText = messages.filter((m) => m.role === 'assistant').map((m) => m.content || '').join(' ');

  const toolCalls = [];
  // shell 代码块
  const shellRe = /```(?:bash|sh|shell|terminal)\s*\n([\s\S]*?)```/g;
  let m1;
  while ((m1 = shellRe.exec(text)) !== null) toolCalls.push(m1[1].trim().slice(0, 500));
  // 内联命令
  const inlineRe = /^[ \t]*[>$]\s+(.+)$/gm;
  let m2;
  while ((m2 = inlineRe.exec(text)) !== null) toolCalls.push(m2[1].trim().slice(0, 500));
  // 兜底：无 shell 块但含命令模式时记录单条
  if (toolCalls.length === 0 && /(?:npm|npx|pip|python|node|git|yarn|pnpm|bun|go test|make)\s+\S+/.test(assistantText)) {
    toolCalls.push(assistantText.match(/(?:npm|npx|pip|python|node|git|yarn|pnpm|bun|go test|make)\s+\S+[^\n]*/)?.[0].trim().slice(0, 500));
  }

  // 代码块（变更证据）
  const codeBlocks = [];
  const codeMatches = text.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g);
  for (const m of codeMatches) codeBlocks.push(m[1].slice(0, 1000));

  const rawSignals = {
    userText,
    assistantText,
    toolCalls,
    codeBlocks,
    hasToolCall: TOOL_CALL_PATTERNS.some((re) => re.test(assistantText)),
    toolCallCount: (assistantText.match(TOOL_CALL_PATTERNS[0]) || []).length + toolCalls.length,
    hasConclusion: CONCLUSION_PATTERNS.some((re) => re.test(assistantText)),
    hasSubagentNoise: SUBAGENT_PATTERNS.some((re) => re.test(text)),
    sensitiveHits: SENSITIVE_JOINT.test(text) ? SENSITIVE_PATTERNS.filter((re) => re.test(text)).map((re) => re.source) : [],
    harmfulHits: HARMFUL_JOINT.test(text) ? HARMFUL_PATTERNS.filter((re) => re.test(text)).map((re) => re.source) : [],
    messageCount: messages.length,
    userMessageCount: messages.filter((m) => m.role === 'user').length,
    assistantMessageCount: messages.filter((m) => m.role === 'assistant').length,
    totalChars: text.length,
    tokenEstimate: Math.ceil(text.length / 4),
    diffCount: record.context?.diffs?.length || 0,
    fileCount: record.context?.files?.length || 0,
  };

  return {
    scores: {},
    score: 0,
    raw: rawSignals,
    reasons: [],
  };
}

function extractGroundTruth(messages) {
  // 取最后一条 assistant 消息的结论部分作为 ground truth
  const assistants = messages.filter((m) => m.role === 'assistant');
  if (assistants.length === 0) return '';
  const last = assistants[assistants.length - 1];
  let content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
  // 尽量提取结论性句子
  const lines = content.split('\n').filter((l) => l.trim());
  const conclusionLines = lines.filter((l) => CONCLUSION_PATTERNS.some((re) => re.test(l)));
  const picked = conclusionLines.length > 0 ? conclusionLines.slice(-3).join(' ') : lines.slice(-5).join(' ');
  return picked.slice(0, 2000);
}

function makeSummary(messages) {
  const prompt = firstUserContent(messages);
  const asst = messages.filter((m) => m.role === 'assistant');
  if (asst.length === 0) return '';
  const first = typeof asst[0].content === 'string' ? asst[0].content.replace(/\s+/g, ' ') : '';
  const parts = [prompt ? `Task: ${prompt.slice(0, 120)}` : ''];
  if (first) parts.push(first.slice(0, 200));
  return parts.filter(Boolean).join('\n').slice(0, 500);
}
