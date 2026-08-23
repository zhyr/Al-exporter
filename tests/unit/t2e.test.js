/**
 * Unit tests for core/t2e — Transfer2Eval pipeline
 * Run: node --test tests/unit/t2e.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  mineEpisodes, scoreEpisode, gateEpisodes, gateEpisode,
  buildTask, verifyTask, calibrateTask, addAnnotation,
  exportDatasets, toEvalRow, toSftLine, toDpoLine,
  runMineAndGate, runPipeline, canTransition, splitByUserTurn,
  STATE_MACHINE, GATE_DECISIONS, EVAL_ENUMS,
} from "../../core/t2e/index.js";
import T2EStore from "../../core/t2e/store.js";

// ── 测试用统一 records ──
function makeRecords(n = 3) {
  const records = [];
  for (let i = 0; i < n; i++) {
    records.push({
      schema_version: "1.0.0",
      type: "thread",
      thread_id: `thread-${i}`,
      messages: [
        { role: "user", content: `请为项目添加用户登录功能，需要验证码和会话管理（任务 ${i}）` },
        { role: "assistant", content: `我来实现。先创建 auth.js 并查看现有代码结构。\n\n\`\`\`bash\nls src/\n\`\`\`\n\n开始编写登录模块。` },
        { role: "assistant", content: `第一次运行测试：\n\n\`\`\`bash\nnpm test\n\`\`\`\n\n出现编译错误，需要修正导入路径。` },
        { role: "assistant", content: `修正后重新运行测试，全部通过。登录功能完成，已上线。` },
      ],
      context: { files: ["src/auth.js"], diffs: [{ file: "src/auth.js" }] },
      meta: { source: "cursor", project: "demo", file_path: `/fake/cursor/thread-${i}.json`, recognition_confidence: "high" },
    });
  }
  return records;
}

describe("t2e schema", () => {
  it("has full state machine", () => {
    assert.deepEqual(Object.keys(STATE_MACHINE).sort(),
      ["BUILT","CALIBRATED","EXPORTED","FAILED","GATED","MINED","REJECTED","VERIFIED"]);
  });
  it("canTransition enforces sequential order", () => {
    assert.ok(canTransition(STATE_MACHINE.MINED, STATE_MACHINE.GATED));
    assert.ok(!canTransition(STATE_MACHINE.MINED, STATE_MACHINE.VERIFIED));
    assert.ok(!canTransition(STATE_MACHINE.GATED, STATE_MACHINE.MINED));
  });
});

describe("Episode Miner", () => {
  it("mines episodes from unified records", async () => {
    const records = makeRecords(3);
    const episodes = await mineEpisodes(records);
    assert.equal(episodes.length, 3);
    assert.ok(episodes[0].id.startsWith("ep-"));
    assert.ok(episodes[0].evidence.raw.hasToolCall);
    assert.ok(episodes[0].groundTruth.length > 0);
    assert.equal(episodes[0].status, STATE_MACHINE.MINED);
  });

  it("folds subagent noise", async () => {
    const records = [{
      schema_version: "1.0.0",
      type: "thread",
      thread_id: "sub-agent-test",
      messages: [
        { role: "user", content: "帮我重构这个模块" },
        { role: "assistant", content: "我先让 sub-agent 探索代码库。" },
        { role: "assistant", content: "[sub-agent 探索完成] 发现 3 个相关文件" },
        { role: "assistant", content: "重构完成，所有测试通过。" },
      ],
      meta: { source: "claude_code", project: "p", file_path: "/x.json" },
    }];
    const episodes = await mineEpisodes(records);
    assert.equal(episodes.length, 1);
    const folded = episodes[0].messages.filter((m) => m.folded);
    assert.equal(folded.length, 1);
    assert.match(folded[0].content, /subagent summary/);
  });

  it("merges continuation messages into the current segment", () => {
    const messages = [
      { role: "user", content: "请实现支付模块，支持支付宝和微信支付" },
      { role: "assistant", content: "好的，开始实现。\n\n```bash\nls src/\n```" },
      { role: "user", content: "keep going, make sure it passes" },
      { role: "assistant", content: "继续完善实现。\n\n```bash\nnpm test\n```" },
      { role: "user", content: "继续" },
      { role: "assistant", content: "完成，所有测试通过，支付模块已上线。" },
      { role: "user", content: "接下来重构一下订单模块，把状态机抽成独立文件" },
      { role: "assistant", content: "好的，开始重构订单模块。" },
    ];
    const segments = splitByUserTurn(messages);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].length, 6); // 任务 + 两轮延续合并为一段
    assert.equal(segments[1].length, 2); // 新任务单独成段
  });
});

describe("Evidence ranking & gate", () => {
  it("scores episodes across all dimensions", async () => {
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    const ep = scoreEpisode(episodes[0]);
    for (const dim of ["completeness","executability","info_density","safety","diversity"]) {
      assert.ok(dim in ep.evidence.scores, `missing ${dim}`);
      assert.ok(ep.evidence.scores[dim] >= 0 && ep.evidence.scores[dim] <= 1);
    }
    assert.ok(ep.evidence.score > 0);
  });

  it("gates strong episodes to accept, weak to reject (fail-closed)", async () => {
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    scoreEpisode(episodes[0]);
    const result = gateEpisode(episodes[0]);
    assert.equal(result.decision, GATE_DECISIONS.ACCEPT);
  });

  it("rejects episodes with leaked secrets (safety veto)", async () => {
    const records = [{
      schema_version: "1.0.0",
      type: "thread",
      thread_id: "secret-thread",
      messages: [
        { role: "user", content: "帮我配置 AWS 密钥" },
        { role: "assistant", content: "使用 AKIAIOSFODNN7EXAMPLE 作为 access key。\n\n配置完成。" },
      ],
      meta: { source: "codex", project: "p", file_path: "/x.json" },
    }];
    const episodes = await mineEpisodes(records);
    scoreEpisode(episodes[0]);
    const result = gateEpisode(episodes[0]);
    assert.equal(result.decision, GATE_DECISIONS.REJECT);
    assert.ok(result.reasons.some((r) => /safety|sensitive/i.test(r)));
  });

  it("deduplicates by prompt fingerprint", async () => {
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    const seen = new Set();
    scoreEpisode(episodes[0]);
    const first = gateEpisode(episodes[0], { seenFingerprints: seen });
    const second = gateEpisode(episodes[0], { seenFingerprints: seen });
    assert.equal(first.decision, GATE_DECISIONS.ACCEPT);
    assert.equal(second.decision, GATE_DECISIONS.REJECT);
  });
});

describe("Task Builder", () => {
  it("builds replayable task with all four artifacts", async () => {
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    scoreEpisode(episodes[0]);
    const task = buildTask(episodes[0]);
    assert.ok(task.replay.steps.length >= 1);
    assert.ok(task.preference.chosen.length > 0);
    assert.ok(task.rlEnv.actionSpace.length >= 4);
    assert.ok(task.rewardCandidates.length >= 3);
    assert.ok(task.acceptanceCriteria.length >= 1);
    assert.ok(task.evalMeta.difficulty);
    assert.equal(episodes[0].status, STATE_MACHINE.BUILT);
  });
});

describe("Verifier", () => {
  it("verifies a valid task (dual-state)", async () => {
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    scoreEpisode(episodes[0]);
    buildTask(episodes[0]);
    const verification = verifyTask(episodes[0]);
    assert.equal(verification.passed, true);
    assert.ok(verification.checks.some((c) => c.name === "dual_state"));
    assert.equal(episodes[0].status, STATE_MACHINE.VERIFIED);
  });

  it("fails tasks with dangerous commands (fail-closed)", async () => {
    const records = [{
      schema_version: "1.0.0",
      type: "thread",
      thread_id: "danger-thread",
      messages: [
        { role: "user", content: "清理服务器磁盘空间" },
        { role: "assistant", content: "执行以下命令清理：\n\n```bash\nrm -rf /\n```\n\n完成。" },
      ],
      meta: { source: "cursor", project: "p", file_path: "/x.json" },
    }];
    const episodes = await mineEpisodes(records);
    scoreEpisode(episodes[0]);
    buildTask(episodes[0]);
    const verification = verifyTask(episodes[0]);
    assert.equal(verification.passed, false);
    assert.ok(verification.checks.some((c) => c.name === "command_safety" && !c.ok));
    assert.equal(episodes[0].status, STATE_MACHINE.FAILED);
  });
});

describe("Calibrator", () => {
  it("calibrates difficulty L1-L4", async () => {
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    scoreEpisode(episodes[0]);
    buildTask(episodes[0]);
    const cal = calibrateTask(episodes[0]);
    assert.ok(EVAL_ENUMS.DIFFICULTY.includes(cal.difficulty));
    assert.ok(cal.confidence > 0);
  });
});

describe("Annotator", () => {
  it("adds annotation and supports modification", async () => {
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    scoreEpisode(episodes[0]);
    buildTask(episodes[0]);
    const ann = addAnnotation(episodes[0], { label: "valid", content: "结构完整", by: "tester", modify: { prompt: "改写后的任务指令" } });
    assert.ok(ann.id);
    assert.equal(episodes[0].annotations.length, 1);
    assert.equal(episodes[0].prompt, "改写后的任务指令");
  });
});

describe("Exporter", () => {
  async function calibratedEpisode() {
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    scoreEpisode(episodes[0]);
    buildTask(episodes[0]);
    verifyTask(episodes[0]);
    calibrateTask(episodes[0]);
    return episodes[0];
  }

  it("maps to eval CSV row with 12 columns", async () => {
    const e = await calibratedEpisode();
    const row = toEvalRow(e, { index: 7 });
    assert.equal(row.id, "G00007");
    assert.ok(EVAL_ENUMS.DOMAIN.includes(row.domain));
    assert.ok(EVAL_ENUMS.TASK_TYPE.includes(row.task_type));
    assert.ok(EVAL_ENUMS.DIFFICULTY.includes(row.difficulty));
    assert.ok(row.prompt.length > 0);
    assert.ok(row.reference_answer.length > 0);
  });

  it("maps to SFT line (prompt_response)", async () => {
    const e = await calibratedEpisode();
    const line = toSftLine(e);
    assert.ok(line.prompt.length > 0);
    assert.ok(line.response.length > 0);
  });

  it("maps to DPO line (prompt_chosen_rejected)", async () => {
    const e = await calibratedEpisode();
    const line = toDpoLine(e);
    assert.ok(line.chosen.length > 0);
    assert.ok(line.rejected.length > 0);
  });

  it("exports datasets with manifest to temp dir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t2e-export-"));
    const episodes = await Promise.all([calibratedEpisode(), calibratedEpisode()]);
    const result = exportDatasets(episodes, { outDir: tmp, split: "candidate_generated" });
    assert.ok(fs.existsSync(result.evalFile));
    assert.ok(fs.existsSync(result.sftFile));
    assert.ok(fs.existsSync(result.dpoFile));
    assert.ok(fs.existsSync(result.manifestFile));
    const csv = fs.readFileSync(result.evalFile, "utf8");
    const headers = csv.split("\n")[0].replace(/^\ufeff/, "").split(",");
    assert.equal(headers.length, 12);
    assert.ok(headers.includes("domain") && headers.includes("ground_truth"));
    const manifest = JSON.parse(fs.readFileSync(result.manifestFile, "utf8"));
    assert.ok(manifest.files.evalFile.sha256.length === 64);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("runMineAndGate + runPipeline integration", () => {
  it("runMineAndGate returns routed buckets", async () => {
    const records = makeRecords(3);
    const result = await runMineAndGate({ normalized: records });
    assert.equal(result.mined, 3);
    assert.ok(result.accepted.length + result.review.length + result.rejected.length === 3);
  });

  it("runPipeline end-to-end (no export)", async () => {
    const records = makeRecords(3);
    const result = await runPipeline({ normalized: records });
    assert.ok(result.stats.scanned === 3);
    assert.ok(result.stats.verified >= 0);
    assert.ok(result.stats.verified <= result.stats.accepted);
  });

  it("store persists and reads episodes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t2e-store-"));
    const s = new T2EStore(tmp);
    const records = makeRecords(1);
    const episodes = await mineEpisodes(records);
    const ep = scoreEpisode(episodes[0]);
    s.saveEpisode(ep);
    const read = s.getEpisode(ep.id);
    assert.equal(read.id, ep.id);
    assert.equal(s.listEpisodes().length, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
