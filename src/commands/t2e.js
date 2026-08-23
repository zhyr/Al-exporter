/**
 * AI Exporter CLI — Transfer2Eval 命令
 * 借鉴 EvoTrace：mine → evidence → gate → build → verify → calibrate → export
 *
 * Usage:
 *   ai-exporter t2e pipeline --input ./agent-backup [--out ./agent-backup/transfer2eval]
 *   ai-exporter t2e mine --input ./agent-backup
 *   ai-exporter t2e status
 *   ai-exporter t2e export --format eval|cms_sft|cms_dpo|all [--out <dir>]
 *   ai-exporter t2e annotate --episode <id> --label valid|invalid|needs_fix --content "..."
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.resolve(__dirname, "../../agent-backup/transfer2eval");

const T2E_HELP = `
Transfer2Eval — 借鉴 EvoTrace 的轨迹→评估数据集编译流水线

Usage:
  ai-exporter t2e <subcommand> [options]

Subcommands:
  pipeline  运行完整流水线（扫描→挖掘→门控→构建→验证→校准→导出）
  mine      仅挖掘 episodes + 证据排序 + 门控（不做构建/验证）
  status    查看管线统计与状态分布
  list     列出 episodes（可按 --status/--source 过滤）
  gate      对指定 episode 执行人工门控（accept/review/reject）
  annotate  对指定 episode 添加人工标注/评论/修改
  build     构建指定 task（可回放任务/偏好/RL/奖励）
  verify    对指定 task 执行审计验证
  calibrate 对指定 task 执行难度校准
  export    导出数据集（eval | cms_sft | cms_dpo | all）
  help      显示本帮助

Options:
  --input <dir>    备份数据目录（默认 ./agent-backup）
  --out <dir>      输出目录（默认 ./agent-backup/transfer2eval）
  --status <s>     过滤状态（mined/gated/built/verified/calibrated/exported/rejected/failed）
  --source <s>     过滤来源工具
  --episode <id>   指定 episode id
  --task <id>      指定 task id
  --decision <d>   gate 决策（accept/review/reject）
  --label <l>      标注（valid/invalid/needs_fix/comment）
  --content <txt>  标注/评论内容
  --format <f>     导出格式（eval/cms_sft/cms_dpo/all）
  --split <s>      导出 split（candidate_generated/seed_train/dev_eval/private_test）
  --json           机器可读 JSON 输出
`;

export async function runT2E(args = {}) {
  const sub = args._[0] || "help";
  if (sub === "help" || args.help) {
    process.stdout.write(T2E_HELP + "\n");
    return { ok: true };
  }

  switch (sub) {
    case "pipeline": return runPipelineCmd(args);
    case "mine": return runMineCmd(args);
    case "status": return runStatusCmd(args);
    case "list": return runListCmd(args);
    case "gate": return runGateCmd(args);
    case "annotate": return runAnnotateCmd(args);
    case "build": return runBuildCmd(args);
    case "verify": return runVerifyCmd(args);
    case "calibrate": return runCalibrateCmd(args);
    case "export": return runExportCmd(args);
    default:
      log.error(`Unknown t2e subcommand: ${sub}`);
      process.stdout.write(T2E_HELP + "\n");
      return { ok: false };
  }
}

async function runPipelineCmd(args) {
  const { runPipeline, store } = await import("../../core/t2e/index.js");
  const { loadRecordsFromBackup } = await import("../server/t2e-routes.js");
  const input = path.resolve(args.input || path.resolve(__dirname, "../../agent-backup"));
  const outDir = args.out || path.join(DEFAULT_OUTPUT, `export-${Date.now()}`);

  log.info(`[t2e] pipeline: loading backup from ${input}`);
  const records = await loadRecordsFromBackup(input);
  if (records.length === 0) {
    log.warn("no normalized records found — run `ai-exporter export` first");
    return { ok: false, reason: "empty backup" };
  }

  const result = await runPipeline({
    normalized: records,
    outDir,
    split: args.split || "candidate_generated",
    onProgress: (stage, detail) => log.info(`[t2e] ${stage}: ${detail}`),
  });
  log.info(`[t2e] pipeline done: ${JSON.stringify(result.stats)}`);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n");
  return result;
}

async function runMineCmd(args) {
  const { runMineAndGate, store } = await import("../../core/t2e/index.js");
  const { loadRecordsFromBackup } = await import("../server/t2e-routes.js");
  const input = path.resolve(args.input || path.resolve(__dirname, "../../agent-backup"));
  const records = await loadRecordsFromBackup(input);
  const result = await runMineAndGate({ normalized: records });
  log.info(`[t2e] mined=${result.mined} accepted=${result.accepted.length} review=${result.review.length} rejected=${result.rejected.length}`);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, stats: { mined: result.mined, accepted: result.accepted.length, review: result.review.length, rejected: result.rejected.length } }, null, 2) + "\n");
  return result;
}

async function runStatusCmd(args) {
  const { store } = await import("../../core/t2e/index.js");
  const stats = store.stats();
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, ...stats }, null, 2) + "\n");
  } else {
    log.info(`[t2e] episodes=${stats.episodes} tasks=${stats.tasks}`);
    for (const [status, count] of Object.entries(stats.byStatus)) {
      log.info(`  ${status}: ${count}`);
    }
  }
  return stats;
}

async function runListCmd(args) {
  const { store } = await import("../../core/t2e/index.js");
  let episodes = store.listEpisodes();
  if (args.status) episodes = episodes.filter((e) => e.status === args.status);
  if (args.source) episodes = episodes.filter((e) => e.source === args.source);
  episodes.sort((a, b) => (b.evidence?.score || 0) - (a.evidence?.score || 0));
  const items = episodes.map((e) => ({
    id: e.id,
    title: (e.title || "").slice(0, 60),
    source: e.source,
    status: e.status,
    score: e.evidence?.score || 0,
    gate: e.gate?.decision || null,
    verified: e.verification?.passed ?? null,
  }));
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, total: items.length, items }, null, 2) + "\n");
  } else {
    for (const it of items) log.info(`  ${it.status.padEnd(10)} ${it.score.toFixed(2)}  ${it.id}  ${it.title}`);
  }
  return { total: items.length, items };
}

async function runGateCmd(args) {
  const { store, manualGate } = await import("../../core/t2e/index.js");
  const episode = store.getEpisode(args.episode);
  if (!episode) { log.error(`episode not found: ${args.episode}`); return { ok: false }; }
  const updated = manualGate(episode, args.decision, args.by || "human", args.content || "");
  store.saveEpisode(updated);
  log.info(`[t2e] gate ${updated.id} → ${updated.status} (${args.decision})`);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, id: updated.id, status: updated.status, gate: updated.gate }, null, 2) + "\n");
  return { ok: true, id: updated.id };
}

async function runAnnotateCmd(args) {
  const { store, addAnnotation, listAnnotations } = await import("../../core/t2e/index.js");
  const episode = store.getEpisode(args.episode);
  if (!episode) { log.error(`episode not found: ${args.episode}`); return { ok: false }; }
  const ann = addAnnotation(episode, {
    label: args.label || "comment",
    content: args.content || "",
    by: args.by || "human",
    modify: args.modify ? JSON.parse(args.modify) : null,
  });
  store.saveEpisode(episode);
  log.info(`[t2e] annotated ${episode.id} (${ann.id})`);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, annotation: ann, all: listAnnotations(episode) }, null, 2) + "\n");
  return { ok: true, annotation: ann };
}

async function runBuildCmd(args) {
  const { store, buildTask } = await import("../../core/t2e/index.js");
  const episode = store.getEpisode(args.episode);
  if (!episode) { log.error(`episode not found: ${args.episode}`); return { ok: false }; }
  const task = buildTask(episode);
  store.saveEpisode(episode);
  store.saveTask(task);
  log.info(`[t2e] built ${task.id} (replay=${task.replay?.steps?.length || 0} steps, rewards=${task.rewardCandidates?.length || 0})`);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, task }, null, 2) + "\n");
  return { ok: true, task };
}

async function runVerifyCmd(args) {
  const { store, verifyTask } = await import("../../core/t2e/index.js");
  const task = store.getTask(args.task || `task-${args.episode}`);
  const episode = task ? store.getEpisode(task.episodeId) : store.getEpisode(args.episode);
  if (!episode) { log.error(`episode not found`); return { ok: false }; }
  if (!episode.task) { log.error("task not built — run build first"); return { ok: false }; }
  const verification = verifyTask(episode);
  store.saveEpisode(episode);
  if (episode.task) store.saveTask(episode.task);
  log.info(`[t2e] verify ${episode.id}: passed=${verification.passed} checks=${verification.checks.length}`);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, verification }, null, 2) + "\n");
  return verification;
}

async function runCalibrateCmd(args) {
  const { store, calibrateTask } = await import("../../core/t2e/index.js");
  const task = store.getTask(args.task || `task-${args.episode}`);
  const episode = task ? store.getEpisode(task.episodeId) : store.getEpisode(args.episode);
  if (!episode) { log.error(`episode not found`); return { ok: false }; }
  if (!episode.task) { log.error("task not built — run build first"); return { ok: false }; }
  const calibration = calibrateTask(episode);
  store.saveEpisode(episode);
  if (episode.task) store.saveTask(episode.task);
  log.info(`[t2e] calibrate ${episode.id}: difficulty=${calibration.difficulty} confidence=${calibration.confidence.toFixed(2)}`);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, calibration }, null, 2) + "\n");
  return calibration;
}

async function runExportCmd(args) {
  const { store, exportDatasets, DOWNSTREAM_TARGETS } = await import("../../core/t2e/index.js");
  const outDir = args.out || DEFAULT_OUTPUT;
  const episodes = store.listEpisodes();
  const result = exportDatasets(episodes, { outDir, split: args.split || "candidate_generated" });
  const summary = {
    ok: true,
    outDir: result.outDir,
    split: result.split,
    counts: result.counts,
    files: {
      eval: result.evalFile,
      sft: result.sftFile,
      dpo: result.dpoFile,
    },
  };
  log.info(`[t2e] export: ${JSON.stringify(summary.counts)} → ${result.outDir}`);
  if (args.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

// 兼容主 CLI 的调用方式（scan 完成后直接接 t2e）
export default runT2E;
