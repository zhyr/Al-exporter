#!/usr/bin/env node
/**
 * Transfer2Eval 性能基准
 *
 * 用法: node scripts/benchmark-t2e.js [sessionsPerTool] [outDir]
 *   - 默认每个工具 20 条会话（共 ~180 条），导出到 /tmp/t2e-benchmark-<ts>
 *   - 输出各阶段耗时与吞吐
 */
import { runPipeline } from '../core/t2e/index.js';

const sessionsPerTool = Number(process.argv[2] || 20);
const outDir = process.argv[3] || `/tmp/t2e-benchmark-${Date.now()}`;

// ── 合成数据生成器（覆盖全部工具源 + 多种 schema）──
const TOOLS = [
  { source: 'cursor', name: 'Cursor', path: '/Users/u/.cursor/composer_todos.json' },
  { source: 'claude_code', name: 'Claude Code', path: '/Users/u/.claude/projects/xyz.jsonl' },
  { source: 'codex', name: 'Codex', path: '/Users/u/.codex/sessions/abc.jsonl' },
  { source: 'trae', name: 'Trae', path: '/Users/u/Library/Application Support/Trae CN/User/workspaceStorage/x/state.vscdb' },
  { source: 'codebuddy', name: 'CodeBuddy', path: '/Users/u/.codebuddy/projects/p1/sessions.jsonl' },
  { source: 'chatgpt', name: 'ChatGPT', path: '/Users/u/.chatgpt/conversations/conversation-123.json' },
  { source: 'doubao', name: 'Doubao', path: '/Users/u/Library/Application Support/Doubao/conversations/123.jsonl' },
  { source: 'workbuddy', name: 'WorkBuddy', path: '/Users/u/.workbuddy/agents/session-1.json' },
  { source: 'traework', name: 'TraeWork', path: '/Users/u/.traework/workspaces/ws1/history.jsonl' },
];

const shells = ['npm test', 'npm run build', 'pytest tests/', 'go test ./...', 'make test'];

// 任务池足够大，保证同工具的不同 session 任务互不相同（避免 gate 去重干扰吞吐统计）
const taskParts = {
  verbs: ['fix', 'add', 'refactor', 'rewrite', 'optimize', 'document', 'test', 'debug', 'extend', 'tune'],
  areas: ['auth.ts', 'user list API', 'payment module', 'csv exporter', 'scan.js', 'settings store', 'notification service', 'billing endpoint', 'cache layer', 'migration script'],
};
function taskFor(i) {
  const v = taskParts.verbs[i % taskParts.verbs.length];
  const a = taskParts.areas[(i * 7) % taskParts.areas.length];
  const scope = ['', ' with better error handling', ' for edge cases', ' end to end'][i % 4];
  return `${v} the ${a}${scope}`;
}

function fakeSession(tool, i) {
  const msgs = [];
  const task = `${taskFor(i)} (${tool.source} #${i})`;
  msgs.push({ role: 'user', content: task });
  for (let j = 0; j < 6; j++) {
    msgs.push({
      role: 'assistant',
      content: `Step ${j + 1}: read the relevant files, then run ${shells[(i + j) % shells.length]}\n\n\`\`\`bash\n${shells[(i + j) % shells.length]}\n\`\`\`\n\nNow I will continue implementing the change for: ${task}`,
    });
    msgs.push({ role: 'user', content: `keep going, make sure it passes` });
  }
  msgs.push({ role: 'assistant', content: `Done. All tests passed, build succeeded, fix verified for: ${task}` });
  return msgs;
}

// 同一工具的不同会话使用不同文件路径（真实世界各会话落在独立文件里）
function uniquePath(p, i) {
  const dot = p.lastIndexOf('.');
  return dot === -1 ? `${p}-${i}` : `${p.slice(0, dot)}-${i}${p.slice(dot)}`;
}

// JSONL 工具按真实导出格式逐行序列化（每行一个对象）
function jsonlLineFor(source, m, t) {
  if (source === 'codex') {
    if (m.role === 'user') {
      return JSON.stringify({ type: 'input_text', text: m.content, timestamp: t });
    }
    return JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] },
      timestamp: t,
    });
  }
  if (source === 'claude_code' || source === 'traework') {
    return JSON.stringify({ type: 'message_create', message: { role: m.role, content: m.content }, timestamp: t });
  }
  // codebuddy / doubao
  return JSON.stringify({ role: m.role, content: m.content, timestamp: t });
}

function toRawRecord(tool, i) {
  const msgs = fakeSession(tool, i);
  const title = `${taskFor(i)} (${tool.source} #${i})`;
  const filePath = uniquePath(tool.path, i);
  if (tool.source === 'chatgpt') {
    // ChatGPT mapping 结构
    const mapping = {};
    let parent = null;
    let t = 1_700_000_000 + i * 100;
    for (const m of msgs) {
      const nodeId = `n_${m.role}_${t}`;
      mapping[nodeId] = {
        id: nodeId,
        parent,
        children: [],
        message: {
          id: `msg_${t}`,
          author: { role: m.role === 'assistant' ? 'assistant' : 'user' },
          create_time: t,
          content: { content_type: 'text', parts: [m.content] },
        },
      };
      if (parent) mapping[parent].children.push(nodeId);
      parent = nodeId;
      t += 1;
    }
    return {
      id: `${tool.source}-${i}`,
      meta: { source: tool.source, tool: tool.name, timestamp: new Date().toISOString() },
      path: filePath,
      content: JSON.stringify({ items: [{ id: 'convo', title, mapping }] }),
    };
  }
  if (tool.path.endsWith('.jsonl')) {
    let t = 1_700_000_000 + i * 100;
    return {
      id: `${tool.source}-${i}`,
      meta: { source: tool.source, tool: tool.name, timestamp: new Date().toISOString() },
      path: filePath,
      content: msgs.map((m) => jsonlLineFor(tool.source, m, t++)).join('\n'),
    };
  }
  return {
    id: `${tool.source}-${i}`,
    meta: { source: tool.source, tool: tool.name, timestamp: new Date().toISOString() },
    path: filePath,
    content: JSON.stringify(msgs),
  };
}

const records = [];
for (const tool of TOOLS) {
  for (let i = 0; i < sessionsPerTool; i++) records.push(toRawRecord(tool, i));
}

// ── 跑流水线并计时 ──
const stages = {};
const t0 = performance.now();
let last = t0;

const result = await runPipeline({
  rawRecords: records,
  outDir,
  split: 'candidate_generated',
  onProgress: (stage) => {
    const now = performance.now();
    stages[stage] = (stages[stage] || 0) + (now - last);
    last = now;
  },
});
const total = performance.now() - t0;

const fmt = (ms) => `${ms.toFixed(0)}ms`;

console.log(`sessions: ${records.length} (${TOOLS.length} tools × ${sessionsPerTool})`);
console.log(`total:    ${fmt(total)}  (~${(records.length / (total / 1000)).toFixed(0)} sessions/sec)`);
console.log('stages:');
for (const [k, v] of Object.entries(stages)) console.log(`  ${k.padEnd(10)} ${fmt(v)}`);
console.log(`result:   mined=${result.stats.mined} accepted=${result.stats.accepted} review=${result.stats.review} rejected=${result.stats.rejected} verified=${result.stats.verified}`);
console.log(`export:   ${outDir}`);
