/**
 * Transfer2Eval REST API 路由
 * 挂载于 /api/t2e/* —— 供 viewer 顶部菜单 "Transfer2Eval" 页面调用
 *
 * 端点：
 *   GET  /api/t2e/status                      管线状态统计
 *   POST /api/t2e/pipeline                    运行完整流水线（扫描→...→导出）
 *   POST /api/t2e/mine                        仅挖掘+证据+门控
 *   GET  /api/t2e/episodes                    列出 episodes（分页/状态过滤）
 *   GET  /api/t2e/episodes/:id                单 episode 详情
 *   POST /api/t2e/episodes/:id/gate           人工门控（accept/review/reject）
 *   POST /api/t2e/episodes/:id/annotate       人工标注/评论/修改
 *   GET  /api/t2e/tasks                       列出 tasks
 *   GET  /api/t2e/tasks/:id                   单 task 详情
 *   POST /api/t2e/tasks/:id/build             构建任务（从 episode）
 *   POST /api/t2e/tasks/:id/verify            审计验证
 *   POST /api/t2e/tasks/:id/calibrate         难度校准
 *   POST /api/t2e/export                      导出数据集（eval | cms_sft | cms_dpo | all）
 *   GET  /api/t2e/datasets                    已导出数据集清单
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runPipeline, runMineAndGate, store,
  manualGate, addAnnotation, listAnnotations,
  buildTask, verifyTask, calibrateTask, exportDatasets,
  STATE_MACHINE, EVAL_ENUMS,
} from '../../core/t2e/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../../agent-backup');
const DEFAULT_T2E_DIR = path.join(OUTPUT_DIR, 'transfer2eval');

const T2E_DATASETS_DIR = process.env.T2E_DATASETS_DIR || DEFAULT_T2E_DIR;

/** 路由分发：返回 true 表示已处理 */
export async function handleT2ERoute(method, pathname, url, req, res, respond) {
  // GET /api/t2e/status
  if (method === 'GET' && pathname === '/api/t2e/status') {
    return respond(res, 200, {
      stats: store.stats(),
      enums: {
        state_machine: STATE_MACHINE,
        eval_enums: EVAL_ENUMS,
      },
    });
  }

  // POST /api/t2e/pipeline — 完整流水线（异步 job 模式）
  if (method === 'POST' && pathname === '/api/t2e/pipeline') {
    const body = await readBody(req);
    const jobId = `t2e-pipeline-${Date.now()}`;
    respond(res, 202, { job_id: jobId });
    runPipelineAsync(jobId, body);
    return true;
  }

  // POST /api/t2e/mine — 挖掘+证据+门控（异步）
  if (method === 'POST' && pathname === '/api/t2e/mine') {
    const body = await readBody(req);
    const jobId = `t2e-mine-${Date.now()}`;
    respond(res, 202, { job_id: jobId });
    mineAsync(jobId, body);
    return true;
  }

  // POST /api/t2e/export — 导出数据集
  if (method === 'POST' && pathname === '/api/t2e/export') {
    const body = await readBody(req);
    try {
      const episodes = store.listEpisodes();
      const outDir = body.outDir || path.join(T2E_DATASETS_DIR, `export-${Date.now()}`);
      const result = exportDatasets(episodes, { outDir, split: body.split || 'candidate_generated' });
      respond(res, 200, { ...result, files: listExportFiles(outDir) });
    } catch (err) {
      respond(res, 400, { error: err.message });
    }
    return true;
  }

  // GET /api/t2e/datasets — 已导出数据集
  if (method === 'GET' && pathname === '/api/t2e/datasets') {
    const exports = [];
    if (existsSync(T2E_DATASETS_DIR)) {
      for (const entry of readdirSync(T2E_DATASETS_DIR)) {
        const dir = path.join(T2E_DATASETS_DIR, entry);
        const manifestPath = path.join(dir, 'manifest.json');
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            exports.push({ dir, name: entry, manifest });
          } catch { /* skip */ }
        }
      }
    }
    return respond(res, 200, { exports });
  }

  // POST /api/t2e/episodes/:id/gate
  let m = pathname.match(/^\/api\/t2e\/episodes\/([^/]+)\/gate$/);
  if (method === 'POST' && m) {
    const body = await readBody(req);
    const episode = store.getEpisode(m[1]);
    if (!episode) return respond(res, 404, { error: 'episode not found' });
    try {
      const updated = manualGate(episode, body.decision, body.by || 'human', body.note || '');
      store.saveEpisode(updated);
      respond(res, 200, { id: updated.id, status: updated.status, gate: updated.gate });
    } catch (err) {
      respond(res, 400, { error: err.message });
    }
    return true;
  }

  // POST /api/t2e/episodes/:id/annotate
  m = pathname.match(/^\/api\/t2e\/episodes\/([^/]+)\/annotate$/);
  if (method === 'POST' && m) {
    const body = await readBody(req);
    const episode = store.getEpisode(m[1]);
    if (!episode) return respond(res, 404, { error: 'episode not found' });
    try {
      const ann = addAnnotation(episode, {
        label: body.label,
        content: body.content,
        by: body.by || 'human',
        modify: body.modify || null,
      });
      store.saveEpisode(episode);
      respond(res, 200, { annotation: ann, annotations: listAnnotations(episode) });
    } catch (err) {
      respond(res, 400, { error: err.message });
    }
    return true;
  }

  // GET /api/t2e/episodes/:id（含详情）
  m = pathname.match(/^\/api\/t2e\/episodes\/([^/]+)$/);
  if (method === 'GET' && m) {
    const episode = store.getEpisode(m[1]);
    if (!episode) return respond(res, 404, { error: 'episode not found' });
    return respond(res, 200, episode);
  }

  // GET /api/t2e/episodes（分页/状态过滤）
  if (method === 'GET' && pathname === '/api/t2e/episodes') {
    const status = url.searchParams.get('status');
    const source = url.searchParams.get('source');
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const size = parseInt(url.searchParams.get('size') || '50', 10);
    let episodes = store.listEpisodes({ status, source });
    // 按证据分排序
    episodes.sort((a, b) => (b.evidence?.score || 0) - (a.evidence?.score || 0));
    const total = episodes.length;
    const items = episodes.slice((page - 1) * size, page * size).map((e) => ({
      id: e.id,
      title: e.title,
      source: e.source,
      project: e.project,
      tool: e.tool,
      status: e.status,
      score: e.evidence?.score || 0,
      evidence: e.evidence?.scores || {},
      gate: e.gate,
      prompt: e.prompt,
      groundTruth: e.groundTruth,
      annotations: e.annotations?.length || 0,
      verification: e.verification?.passed,
      createdAt: e.createdAt,
    }));
    return respond(res, 200, { total, page, size, items });
  }

  // GET /api/t2e/tasks/:id
  m = pathname.match(/^\/api\/t2e\/tasks\/([^/]+)$/);
  if (method === 'GET' && m) {
    const task = store.getTask(m[1]);
    if (!task) return respond(res, 404, { error: 'task not found' });
    return respond(res, 200, task);
  }

  // POST /api/t2e/tasks/:id/build — 从 episode 构建
  m = pathname.match(/^\/api\/t2e\/tasks\/([^/]+)\/build$/);
  if (method === 'POST' && m) {
    const task = store.getTask(m[1]);
    const episode = task ? store.getEpisode(task.episodeId) : null;
    if (!episode) return respond(res, 404, { error: 'episode not found for task' });
    try {
      const built = buildTask(episode);
      store.saveEpisode(episode);
      store.saveTask(built);
      respond(res, 200, { task: built });
    } catch (err) {
      respond(res, 400, { error: err.message });
    }
    return true;
  }

  // POST /api/t2e/tasks/:id/verify
  m = pathname.match(/^\/api\/t2e\/tasks\/([^/]+)\/verify$/);
  if (method === 'POST' && m) {
    const task = store.getTask(m[1]);
    const episode = task ? store.getEpisode(task.episodeId) : null;
    if (!episode || !episode.task) return respond(res, 404, { error: 'task not built' });
    try {
      const verification = verifyTask(episode);
      store.saveEpisode(episode);
      store.saveTask(episode.task);
      respond(res, 200, { verification });
    } catch (err) {
      respond(res, 400, { error: err.message });
    }
    return true;
  }

  // POST /api/t2e/tasks/:id/calibrate
  m = pathname.match(/^\/api\/t2e\/tasks\/([^/]+)\/calibrate$/);
  if (method === 'POST' && m) {
    const task = store.getTask(m[1]);
    const episode = task ? store.getEpisode(task.episodeId) : null;
    if (!episode || !episode.task) return respond(res, 404, { error: 'task not built' });
    try {
      const calibration = calibrateTask(episode);
      store.saveEpisode(episode);
      store.saveTask(episode.task);
      respond(res, 200, { calibration });
    } catch (err) {
      respond(res, 400, { error: err.message });
    }
    return true;
  }

  // GET /api/t2e/tasks（分页）
  if (method === 'GET' && pathname === '/api/t2e/tasks') {
    const status = url.searchParams.get('status');
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const size = parseInt(url.searchParams.get('size') || '50', 10);
    let tasks = store.listTasks({ status });
    const total = tasks.length;
    const items = tasks.slice((page - 1) * size, page * size).map((t) => ({
      id: t.id,
      episodeId: t.episodeId,
      title: t.title,
      status: t.status,
      acceptanceCriteria: t.acceptanceCriteria,
      replaySteps: t.replay?.steps?.length || 0,
      rewardCandidates: t.rewardCandidates?.length || 0,
      preference: !!t.preference,
      rlEnv: !!t.rlEnv,
      evalMeta: t.evalMeta,
      createdAt: t.createdAt,
    }));
    return respond(res, 200, { total, page, size, items });
  }

  return false; // 未匹配
}

// ─── 异步任务 ─────────────────────────────────────────────────────────────────

async function runPipelineAsync(jobId, body) {
  try {
    console.log(`[t2e] ${jobId}: pipeline started`);
    // 优先使用已备份的归一化 records；否则执行扫描
    const dataDir = body.dataDir || OUTPUT_DIR;
    let records;
    if (body.useBackup !== false) {
      records = await loadRecordsFromBackup(dataDir);
    } else {
      const { scanAllToolsIncremental } = await import('../../core/scan.js');
      const { normalizeAll } = await import('../../core/normalize.js');
      const files = await scanAllToolsIncremental({ workers: body.workers || 8 });
      records = normalizeAll(files);
    }
    const result = await runPipeline({
      normalized: records,
      thresholds: body.thresholds,
      docker: body.docker,
      outDir: body.outDir || path.join(T2E_DATASETS_DIR, `export-${Date.now()}`),
      split: body.split || 'candidate_generated',
      onProgress: (stage, detail) => console.log(`[t2e] ${jobId}: ${stage} — ${detail}`),
    });
    console.log(`[t2e] ${jobId}: done`, JSON.stringify(result.stats));
  } catch (err) {
    console.error(`[t2e] ${jobId}: FAILED`, err);
  }
}

async function mineAsync(jobId, body) {
  try {
    const dataDir = body.dataDir || OUTPUT_DIR;
    const records = await loadRecordsFromBackup(dataDir);
    const result = await runMineAndGate({
      normalized: records,
      thresholds: body.thresholds,
    });
    console.log(`[t2e] ${jobId}: mined=${result.mined}`, JSON.stringify({ accepted: result.accepted.length, review: result.review.length, rejected: result.rejected.length }));
  } catch (err) {
    console.error(`[t2e] ${jobId}: FAILED`, err);
  }
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

function listExportFiles(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir).map((f) => ({
    name: f,
    size: statSync(path.join(outDir, f)).size,
  }));
}

/** 从备份目录加载归一化 records（agent-backup/<source>/*.json） */
export async function loadRecordsFromBackup(dataDir) {
  const records = [];
  if (!existsSync(dataDir)) return records;
  const subDirs = readdirSync(dataDir);
  for (const sub of subDirs) {
    const subPath = path.join(dataDir, sub);
    if (!statSyncSafeIsDir(subPath)) continue;
    const files = readdirSync(subPath).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const record = JSON.parse(readFileSync(path.join(subPath, f), 'utf8'));
        if (record && record.thread_id) records.push(record);
      } catch { /* skip invalid */ }
    }
  }
  return records;
}

function statSyncSafeIsDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
