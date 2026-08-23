#!/usr/bin/env node
/**
 * 诊断脚本：追踪 pipeline 各阶段流失点
 */
import { normalizeAll } from '../core/normalize.js';
import { mineEpisodes } from '../core/t2e/mine.js';
import { scoreEpisode } from '../core/t2e/evidence.js';
import { gateEpisodes } from '../core/t2e/gate.js';
import { buildTask } from '../core/t2e/builder.js';
import { verifyTask } from '../core/t2e/verify.js';

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
const tasks = [
  'fix the login race condition in auth.ts',
  'add pagination to the user list API',
  'refactor the payment module for clarity',
  'write unit tests for the csv exporter',
  'optimize the sqlite query in scan.js',
];

function fakeSession(tool, i) {
  const msgs = [];
  const task = `${tasks[i % tasks.length]} (${tool.source} #${i})`;
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
  const title = `${tasks[i % tasks.length]} (${tool.source} #${i})`;
  const filePath = uniquePath(tool.path, i);
  if (tool.source === 'chatgpt') {
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

const n = 5;
const records = [];
for (const tool of TOOLS) {
  for (let i = 0; i < n; i++) records.push(toRawRecord(tool, i));
}

const normalized = normalizeAll(records);
console.log(`normalized: ${normalized.length} records`);
// 检查每个工具的归一化情况
const bySource = {};
for (const r of normalized) {
  bySource[r.meta.source] = (bySource[r.meta.source] || 0) + 1;
}
console.log('bySource:', bySource);
// 检查消息数
const emptyMsg = normalized.filter((r) => r.messages.length === 0);
console.log(`records with 0 messages: ${emptyMsg.length}`);
for (const r of emptyMsg) console.log('  empty:', r.meta.source, r.meta.file_path);

const mined = await mineEpisodes(normalized);
console.log(`\nmined: ${mined.length} episodes`);
for (const ep of mined) console.log(`  ${ep.id} [${ep.source}] msgs=${ep.messages.length} prompt="${ep.prompt.slice(0, 60)}"`);

for (const ep of mined) scoreEpisode(ep);
const byScore = {};
for (const ep of mined) {
  const s = ep.evidence.score;
  const k = s >= 0.6 ? 'accept(>=0.6)' : s >= 0.4 ? 'review(0.4-0.6)' : 'reject(<0.4)';
  byScore[k] = (byScore[k] || 0) + 1;
  console.log(`  ${ep.id} score=${s.toFixed(2)} ${k} scores=${JSON.stringify(Object.entries(ep.evidence.scores).map(([k, v]) => `${k}:${v.toFixed(2)}`))}`);
}
console.log('byScore:', byScore);

const gated = gateEpisodes(mined);
console.log(`\ngate: accepted=${gated.accepted.length} review=${gated.review.length} rejected=${gated.rejected.length}`);
for (const ep of gated.rejected) console.log(`  rejected: ${ep.id} reasons=${JSON.stringify(ep.gate.reasons)}`);

const buildable = [...gated.accepted, ...gated.review.filter((e) => e.gate?.needsReview === false)];
const built = [];
for (const ep of buildable) {
  try {
    buildTask(ep);
    built.push(ep);
  } catch (e) {
    console.log(`  build fail: ${ep.id}: ${e.message}`);
  }
}
console.log(`\nbuilt: ${built.length}`);

let verified = 0;
for (const ep of built) {
  const v = verifyTask(ep);
  console.log(`  verify ${ep.id}: passed=${v.passed} checks=${v.checks.map((c) => `${c.name}:${c.ok ? 'OK' : 'FAIL'}`).join(' ')}`);
  if (v.passed) verified++;
}
console.log(`\nverified: ${verified}/${built.length}`);
