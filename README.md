# AI Exporter

> 一键扫描、备份、导出 AI 编码工具对话数据，支持 26+ 主流 Agent，数据可转换为 Markdown/JSON/训练格式，赋能 AI 训练与跨工具迁移。

**Version 2.2.2** · MIT License

[中文](#中文)  | [English](#english)

![Overview](overview.png)
![Detail](detail-interactive-threads.png)

---
## 中文

### 项目简介

AI Exporter 是一款强大的 AI 编码工具对话数据扫描、备份、导出和分析工具。它帮助开发者保存 AI 交互历史，并将其转换为适合训练、分析或在不同的 AI 编码工具之间迁移的格式。

### 核心功能

- **多源扫描**: 自动发现和扫描多种 AI 编码工具的数据
- **格式识别**: 智能识别各种数据格式
- **统一 Schema**: 导出为标准化 JSON 格式
- **多种导出格式**:
  - JSON / JSONL (机器处理)
  - Markdown (人类可读)
  - 训练数据格式 (SFT, ShareGPT)
- **导入功能**: 将数据导入到指定的 AI 编码 Agent
- **Web 界面**: 用户友好的 Web 操作界面
- **实时进度**: 使用 SSE 推送扫描进度

### 支持的 AI 编码工具

| 工具 | 目录 | 状态 |
|------|------|------|
| Cursor | `.cursor/` | ✅ |
| Claude Code | `.claude/` | ✅ |
| OpenCode/Codex | `.opencode/`, `.codex/` | ✅ |
| Antigravity | `.antigravity/` | ✅ |
| Cline | `.cline/` | ✅ |
| Windsurf | `.windsurf/` | ✅ |
| CodeBuddy / CodeBuddy CN | `.codebuddy/`、`Application Support/CodeBuddy*` | 目录已覆盖；通用 chat / tool / log（未经官方安装包核对） |
| WorkBuddy / WorkBuddy CN（腾讯） | `.workbuddy/`、`.workbuddy-ai/`、`Application Support/WorkBuddy*` | 专用会话解析：`projects/<cwd>/<uuid>.jsonl` + `workbuddy.db`；剥 `<system-reminder>` / 取 `<user_query>`；保留 tool 调用 |
| Cursor CLI（`cursor agent`） | `~/.cursor/chats/*/*/store.db` | 来源 `cursor_cli`（与 IDE Cursor 分开）；从 blobs 启发式提取 `<user_query>` 文本 |
| ZCode（智谱 Z.ai） | `.zcode/`、`Application Support/ZCode*` | 目录已覆盖；通用 chat / tool / log（未经官方安装包核对） |
| Kiro | `.kiro/` | ✅ |
| iFlow | `.iflow/` | ✅ |
| Qoder | `.qoder/` | ✅ |
| Trae / Trae CN | `.trae/`、`Application Support/Trae*` | 来源 `trae`。目录已覆盖；通用 chat / tool / log（未经官方安装包核对） |
| Trae Work / Trae Work CN | `.trae-work/`、`.traework/`、`Application Support/Trae Work*` | 来源 `traework`。目录已覆盖；通用 chat / tool / log（未经官方安装包核对） |
| Augment | `.augment/` | ✅ |
| Zed | `.zed/` | ✅ |
| Aider | `.aider/` | ✅ |
| Continue | `.continue/` | ✅ |
| GitHub Copilot | `.github/copilot/` | ✅ |
| Tabnine | `.tabnine/` | ✅ |
| Amazon Q | `.aws/amazonq/` | ✅ |
| DeepSeek | `.deepseek/` | ✅ |
| 通义灵码 | `.tongyi/` | ✅ |
| 讯飞 iFlyCode | `.iflycode/` | ✅ |
| Fitten Code | `.fitten/` | ✅ |
| Devin | `.devin/` | ✅ |
| Replit | `.replit/` | ✅ |
| Lovable/Bolt/v0 | `.lovable/`, `.bolt/`, `.v0/` | ✅ |

### 安装

```bash
# 克隆仓库
git clone https://github.com/zhyr/Al-exporter.git
cd ai-exporter

# 安装依赖
npm install
```

### 使用方法

#### 命令行

```bash
# 设置工作区
npm install

# 扫描所有支持的工具
node index.js scan

# 导出数据
node index.js export

# 启动 Web 服务
node open-viewer.js
npm run serve
```

#### Web 界面

1. 启动 Web 服务器:
   ```bash
   node open-viewer.js
   ```
2. 在浏览器中打开 `http://127.0.0.1:8080`
3. 使用 Web 界面:
   - 选择工作区并扫描
   - 预览数据
   - 导出为各种格式
   - 将数据导入到指定的 Agent

### 配置

默认存储位置 (macOS):

- **数据输出**: `./agent-backup/`
- **Web 服务**: `http://127.0.0.1:8080`

### 协同导出契约（Interop，schema 1.1.0）

导出结果可被下游工具 [AI Coding Timeline Scanner](https://github.com/zhyr/multi-agent-coding-timeline) 直接识别与去重，不再依赖 `meta.file_path` 反推会话身份。完整字段表、兼容策略和已知缺口见 [docs/export-format.md](docs/export-format.md)。

- **会话原生标识**：每条记录新增 `session.native_id`（来源可为 `sessionId`、会话文件名或会话目录名）、`session.cwd`、`session.git_remote`、`session.agent_version`，并标注每个值的来源字段。
- **消息级定位**：每条消息新增 `id`（原生 uuid / 事件 id；同一源记录展开多条时以 `#n` 后缀保证唯一）、`id_source`、`line`（源文件 1-based 行号），以及结构化 `tool_call {name, status, call_id, phase}`。状态只取源里显式值，拿不到就是 `null`。
- **设备身份独立**：`device.source_device_id` 与 `device.collector_device_id` 分开记录；跨机器导出备份时用 `--source-device` 声明被扫描端，避免把事件归到采集端。
- **能力清单**：每次导出写 `interop.json`，逐字段给出 `applicable / non_empty / empty / status`，明确区分「字段不存在」与「字段为空」，并列出 `known_gaps`。
- **兼容**：新增字段全部可选，旧消费者不受影响；schema 升级后 `.export_state.json` 自动失效一次，确保旧文件也会补齐新字段。`thread_id` 不变，按 `manifest.json` 读取即可。

```bash
# 跨机器备份：声明被扫描设备
ai-exporter export --output ./agent-backup --source-device alice-laptop

# 查看能力清单
jq '.capabilities, .known_gaps' agent-backup/interop.json
```

### 与 AI Coding Timeline Scanner 的关系

本项目（AI Exporter）与 [AI Coding Timeline Scanner（`zhyr/multi-agent-coding-timeline`）](https://github.com/zhyr/multi-agent-coding-timeline)
是**上游导出器 / 下游应用**的互补关系：

| | AI Exporter（本项目，上游） | AI Coding Timeline Scanner（下游） |
| --- | --- | --- |
| 目标 | 从 26+ 种 Agent 抽取并导出对话，产出可移植归档（`manifest.json`、逐会话 JSON/Markdown、`interop.json`）。 | 把同一个项目在多个 Agent、多台设备与 Git 历史中的活动重建为统一、可校验的时间线，并按项目聚簇。 |
| 产物 | 导出归档、Markdown、JSON、训练/评估格式（Transfer2Eval）。 | Timeline 包：证据等级、provenance、SHA-256 完整性校验、离线 Viewer、交互式本地应用。 |
| 身份 | `thread_id`、`session.native_id`、`messages[].id`、`device.source_device_id`。 | `dedup_key` + `content_hash` + provenance；`source_device_id` 与 `scanner_device_id` 分离。 |

上面的协同导出契约（schema 1.1.0）正是为这条链路设计的：下游工具内置的 `al-exporter`
导入适配器以 `--source-root` + `manifest.json` 读取归档，采用 `device.source_device_id`
声明的源设备身份，用 `session.native_id` / `messages[].id` / `tool_call` 做确定性去重，并依据
`interop.json` 的实际非空率判定各字段能力等级（`empty` / `absent` 视为 `unavailable`）。
导入事件在该工具中一律标记为 `agent_reported` / `derived`，Git 事实由其自带的只读 Git
Scanner 独立提供，不从归档推断。

两者可独立使用：AI Exporter 不需要下游工具即可完成备份与导出；下游工具也能直接扫描原生
Agent 日志（`~/.codex`、`~/.cursor` 等），归档只是可选的输入源之一。契约细节见下游
[README 的「Relationship with AI Exporter」](https://github.com/zhyr/multi-agent-coding-timeline/blob/main/README.md)。

### 项目结构

```
AI-exporter/
├── core/               # 核心扫描和处理逻辑
│   ├── scan.js        # 多源扫描
│   ├── normalize.js   # 数据标准化
│   ├── convert.js     # 格式转换
│   └── import.js     # Agent 特定导入
├── src/               # CLI 和服务器
│   ├── server/       # Express 服务器和 REST API
│   └── cli.js        # 命令行接口
├── viewer/            # Web 界面
├── tests/             # 单元测试
└── adapter/          # 格式适配器
```

### API 接口

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/scan` | 开始扫描 |
| GET | `/api/scan/status` | 扫描状态 |
| POST | `/api/export` | 导出数据 |
| POST | `/api/import-file` | 导入文件 |
| POST | `/api/import-to-agent` | 导入到 Agent |
| GET | `/api/agents` | 支持的 Agent 列表 |
| GET | `/api/stats` | 统计数据 |

### Transfer2Eval（会话轨迹 → 评估数据集）
![Overview](Transfer2Eval.png)
![Detail](Transfer2Eval2.png)

将 17+ 工具的会话轨迹编译为**可回放任务 / 偏好数据 / RL 环境 / 执行奖励候选**，输出可直接用于评估与训练的数据集：

- **挖掘**：从会话中提取独立任务段（含延续消息合并），构建可回放轨迹
- **证据排序**：基于交互深度、执行痕迹、覆盖度等 5 维证据打分
- **门控路由**：按证据分数自动路由到 accept / review / reject
- **构建**：编译为任务、偏好、RL 环境、奖励四类数据集
- **双状态验证**：运行时一致性 + 离线静态验证（含危险命令 / 敏感信息 / 泄露检测）
- **难度校准**：基于上下文长度与证据强度自动估算难度等级
- **人工标注**：Web 界面逐条标注（标签 / 内容 / 修正 Prompt / 修正 ground_truth）
- **导出**：Eval CSV（12 列）与 SFT / DPO JSONL，附带幂等 SHA-256 manifest

**CLI**：`node src/cli.js t2e`（子命令：`mine` / `build` / `verify` / `calibrate` / `export` / `annotate` / `stats`）

**Web**：启动 `npm run serve` 后访问 `http://127.0.0.1:8080`，「🧠 Transfer2Eval」菜单，含 API 与标注面板。

**数据存储**：`./agent-backup/transfer2eval/`（episodes / tasks / datasets，JSON 持久化，含 provenance 溯源链）。

**CLI 子命令**：

| 子命令 | 说明 |
|--------|------|
| `pipeline` | 运行完整流水线（扫描→挖掘→门控→构建→验证→校准→导出） |
| `mine` | 仅挖掘 episodes + 证据排序 + 门控 |
| `status` | 管线统计与状态分布 |
| `list` | 列出 episodes（`--status` / `--source` 过滤） |
| `gate` | 人工门控（`--episode` + `--decision accept/review/reject`） |
| `annotate` | 标注/评论/修改（`--episode` + `--label` + `--content`） |
| `build` | 构建指定 task（可回放任务/偏好/RL/奖励） |
| `verify` | 对指定 task 执行审计验证 |
| `calibrate` | 对指定 task 执行难度校准 |
| `export` | 导出数据集（`--format eval/cms_sft/cms_dpo/all`） |

示例：

```bash
node src/cli.js t2e pipeline --input ./agent-backup
node src/cli.js t2e mine --input ./agent-backup --json
node src/cli.js t2e gate --episode ep-xxxx --decision accept
node src/cli.js t2e annotate --episode ep-xxxx --label valid --content "ok"
node src/cli.js t2e export --format all --split candidate_generated
```

**REST API（`/api/t2e/*`）**：

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/t2e/status` | 管线状态统计 |
| POST | `/api/t2e/pipeline` | 运行完整流水线（异步 job） |
| POST | `/api/t2e/mine` | 挖掘 + 证据 + 门控（异步 job） |
| GET | `/api/t2e/episodes` | 列出 episodes（分页/状态过滤） |
| GET | `/api/t2e/episodes/:id` | 单 episode 详情 |
| POST | `/api/t2e/episodes/:id/gate` | 人工门控 |
| POST | `/api/t2e/episodes/:id/annotate` | 人工标注/评论/修改 |
| GET | `/api/t2e/tasks` | 列出 tasks |
| GET | `/api/t2e/tasks/:id` | 单 task 详情 |
| POST | `/api/t2e/tasks/:id/build` | 构建任务 |
| POST | `/api/t2e/tasks/:id/verify` | 审计验证 |
| POST | `/api/t2e/tasks/:id/calibrate` | 难度校准 |
| POST | `/api/t2e/export` | 导出数据集（eval/cms_sft/cms_dpo/all） |
| GET | `/api/t2e/datasets` | 已导出数据集清单 |

### 常见问题（FAQ）

**Q：扫描不到我的会话（数据不在默认目录）？**
默认只扫描 HOME 下的已知目录。若工具使用了自定义数据目录（如 `CODEX_HOME`、便携版安装），打开 Web 界面的「设置 → 额外扫描目录」，把会话目录逐行填入后重新「增量扫描」。该目录支持 `~` 展开，可指向任意绝对路径。

**Q：Trae / Trae CN / Trae Work / Trae Work CN 都支持吗？**
目录发现覆盖 `.trae/`、`.trae-work/`、`.traework/`、`Application Support/Trae*`、`.config/Trae*`（含 Windows `%APPDATA%` 与 Linux XDG）。Trae / Trae CN 的来源是 `trae`，Trae Work / Trae Work CN 的来源是 `traework`。会话、工具调用和运行日志按通用 chat / tool / log 解析，尚未用官方安装包逐字段核对。非默认位置用「额外扫描目录」加入。

**Q：WorkBuddy / ZCode / CodeBuddy 等新工具支持吗？**
默认数据目录和来源识别已覆盖（含 CN 变体，以及 macOS / Linux / Windows）。VS Code 系的 `*.vscdb` 仍用现有键读取；JSON / JSONL 里的 session、chat、tool use 和运行日志走通用解析。这不是各产品私有格式的完整证明。非默认目录用「设置 → 额外扫描目录」。

**Q：扫描完成但没有数据载入？**
依次排查：① 确认目标工具确实产生过会话记录；② 会话是否在「额外扫描目录」之外的位置；③ 查看扫描日志中「Found N candidate files」是否非零；④ 若文件格式不支持，可先通过「导入」添加。

### 更新日志

#### v2.2.2

- WorkBuddy 专用会话解析：`projects/<cwd>/<uuid>.jsonl` + `workbuddy.db`（含 `.workbuddy-ai`）；清洗 `<user_query>` / `<system-reminder>`，工具调用仍保留。
- 导出增加按源文件 mtime 的 `.export_state.json` 增量游标；Claude Code 本地截断信号写入 `meta.extra.transcript_truncated`（不联网）。
- 新增来源 `cursor_cli`（`~/.cursor/chats` store.db 启发式提取）；T2E 不再把 `tool_result` 当成新的用户轮次。
- 测试与 fixture 仅使用合成路径（如 `/Users/demo`）；真实 `agent-backup` / `.env` 不进入仓库。

#### v2.2.1

- 同一文件里带明确 `sessionId` / `session_id` / `trace_id` 的会话会拆成多条 thread；工具调用写入 `message.meta.kind`（`tool_use` / `tool_result`），工具结果上的 `name` 会计入 T2E 证据。
- 运行日志归一为 `type: log`，不进入评估挖掘。路径在 log/run 下、行首带时间戳的 WorkBuddy 启动记录（`_type: mark|summary`）按阶段和 `epochMs` 保留。
- Trae Work / Trae Work CN 的来源是 `traework`（与 `trae` 分开）。CodeBuddy、WorkBuddy、ZCode、Trae 的目录发现覆盖 macOS、Linux 与 Windows；JSON / JSONL 仍走通用解析，尚未对照官方安装包逐字段核对。
- 导出前把真实数据里见到的非法形状对齐到 schema（`recognition_confidence: medium`、字符串形式的 `context.files`）。`t2e pipeline` 读取已导出备份，不在这一步重新扫描磁盘。带用户轮次的 `agent` 记录可以进入挖掘。
- 诊断脚本要求传入真实导出目录，不再生成假会话。本版本不执行脚本、不回放工具链，也不把运行日志重跑成任务。

#### v2.2.0

- 新增 **WorkBuddy**（腾讯）与 **ZCode**（智谱 Z.ai）支持：内置默认数据目录扫描、来源识别与 `*.vscdb` 会话提取；`detectTool`、source 枚举、schema 校验与 T2E 域映射同步扩展。

#### v2.1.1

- 支持 **Trae 家族全版本**（Trae / Trae CN / Trae Work / Trae Work CN），自动扫描各版默认数据目录。
- Web 设置新增 **「额外扫描目录」**：自定义 Codex / Trae 等非默认会话目录（如自定义 `CODEX_HOME`）不再需要改代码。
- 修复导出 schema 校验：记录类型补充 `agent`（此前含 agent 会话的导出无法通过校验）。
- 依赖安全升级：`fast-uri` 3.1.7（修复 GHSA-v39h-62p7-jpjc / GHSA-q3j6-qgpj-74h6）。

#### v2.1.0

- 新增 **Transfer2Eval** 模块：将 17+ 工具的会话轨迹编译为可回放任务 / 偏好数据 / RL 环境 / 执行奖励候选（证据排序 → 门控路由 → 构建 → 双状态验证 → 难度校准 → 人工标注 → 数据集导出）。
- Web 界面新增「🧠 Transfer2Eval」顶部菜单与 `/api/t2e/*` REST API；标注弹窗自动回填对应 episode 的标签、内容、Prompt 与 ground_truth。
- 规范化增强：JSONL 整行数组解析、延续消息（"keep going" 等）并入当前任务段，避免碎段误判。
- 数据集导出支持 Eval CSV（12 列）与 SFT/DPO JSONL，附带幂等 SHA-256 manifest。

### 开发

```bash
# 运行测试
npm test

# 运行测试并生成覆盖率报告
npm run test:cov
```

### 许可证

MIT License

## English

### Overview

One-click tool to scan, backup, and export AI coding assistant conversations. Supports 26+ popular agents, converts data to Markdown/JSON/training formats for AI training and cross-tool migration.

### Features

- **Multi-Source Scanning**: Automatically discover and scan AI coding tool data from multiple sources
- **Format Recognition**: Intelligent identification of various data formats
- **Unified Schema**: Export to standardized JSON format with consistent structure
- **Multiple Export Formats**: 
  - JSON / JSONL for machine processing
  - Markdown for human-readable documentation
  - Training data formats (SFT, ShareGPT)
- **Import Functionality**: Import data into specific AI coding agents
- **Web Interface**: User-friendly web UI for easy operation
- **Real-time Progress**: Live scanning progress with SSE updates

### Supported AI Coding Tools

| Tool | Directory | Status |
|------|-----------|--------|
| Cursor | `.cursor/` | ✅ |
| Claude Code | `.claude/` | ✅ |
| OpenCode/Codex | `.opencode/`, `.codex/` | ✅ |
| Antigravity | `.antigravity/` | ✅ |
| Cline | `.cline/` | ✅ |
| Windsurf | `.windsurf/` | ✅ |
| CodeBuddy / CodeBuddy CN | `.codebuddy/`, `Application Support/CodeBuddy*` | Dirs covered; generic chat / tool / log (not verified against an official install) |
| WorkBuddy / WorkBuddy CN (Tencent) | `.workbuddy/`, `.workbuddy-ai/`, `Application Support/WorkBuddy*` | Dedicated parse: `projects/<cwd>/<uuid>.jsonl` + `workbuddy.db`; strip `<system-reminder>` / keep `<user_query>`; tool calls retained |
| Cursor CLI (`cursor agent`) | `~/.cursor/chats/*/*/store.db` | Source `cursor_cli` (separate from IDE Cursor); heuristic `<user_query>` extraction from blobs |
| ZCode (Zhipu Z.ai) | `.zcode/`, `Application Support/ZCode*` | Dirs covered; generic chat / tool / log (not verified against an official install) |
| Kiro | `.kiro/` | ✅ |
| iFlow | `.iflow/` | ✅ |
| Qoder | `.qoder/` | ✅ |
| Trae / Trae CN | `.trae/`, `Application Support/Trae*` | Source `trae`. Dirs covered; generic chat / tool / log (not verified against an official install) |
| Trae Work / Trae Work CN | `.trae-work/`, `.traework/`, `Application Support/Trae Work*` | Source `traework`. Dirs covered; generic chat / tool / log (not verified against an official install) |
| Augment | `.augment/` | ✅ |
| Zed | `.zed/` | ✅ |
| Aider | `.aider/` | ✅ |
| Continue | `.continue/` | ✅ |
| GitHub Copilot | `.github/copilot/` | ✅ |
| Tabnine | `.tabnine/` | ✅ |
| Amazon Q | `.aws/amazonq/` | ✅ |
| DeepSeek | `.deepseek/` | ✅ |
| 通义灵码 | `.tongyi/` | ✅ |
| 讯飞 iFlyCode | `.iflycode/` | ✅ |
| Fitten Code | `.fitten/` | ✅ |
| Devin | `.devin/` | ✅ |
| Replit | `.replit/` | ✅ |
| Lovable/Bolt/v0 | `.lovable/`, `.bolt/`, `.v0/` | ✅ |

### Installation

```bash
# Clone the repository
git clone https://github.com/zhyr/Al-exporter.git
cd ai-exporter

# Install dependencies
npm install
```

### Usage

#### Command Line Interface

```bash
# Scan all supported tools
node index.js scan

# Export data
node index.js export

# Start web server
node open-viewer.js
npm run serve
```

#### Web Interface

1. Start the web server:
   ```bash
   node open-viewer.js
   ```
2. Open your browser to `http://127.0.0.1:8080`
3. Use the web UI to:
   - Select workspace and scan
   - Preview data
   - Export in various formats
   - Import data to specific agents

### Configuration

Default storage locations by platform (macOS):

- **Data Output**: `./agent-backup/`
- **Web Server**: `http://127.0.0.1:8080`

### Interop Contract (schema 1.1.0)

Exports can be consumed and deduplicated directly by the downstream [AI Coding Timeline Scanner](https://github.com/zhyr/multi-agent-coding-timeline) without reverse-engineering session identity from `meta.file_path`. See [docs/export-format.md](docs/export-format.md) for the full field table, compatibility rules and known gaps.

- **Native session identity**: every record carries `session.native_id` (from `sessionId`, the session file name, or the session directory name), plus `session.cwd`, `session.git_remote`, `session.agent_version`, each with a provenance field.
- **Message-level identity**: every message carries `id` (native uuid / event id), `id_source`, `line` (1-based source line), and a structured `tool_call {name, status, call_id, phase}`. Status comes only from the source; otherwise it is `null`.
- **Separate device identity**: `device.source_device_id` and `device.collector_device_id` are distinct. Use `--source-device` when exporting a backup from another machine.
- **Capability report**: `interop.json` records `applicable / non_empty / empty / status` per field, distinguishing “field absent” from “field present but empty”, and lists `known_gaps`.
- **Compatibility**: all fields are additive; existing consumers keep working. A schema bump invalidates `.export_state.json` once so unchanged sources are re-read. `thread_id` stays stable; read `manifest.json` as the archive index.

```bash
ai-exporter export --output ./agent-backup --source-device alice-laptop
jq '.capabilities, .known_gaps' agent-backup/interop.json
```

### Relationship with AI Coding Timeline Scanner

This project (AI Exporter) and
[AI Coding Timeline Scanner (`zhyr/multi-agent-coding-timeline`)](https://github.com/zhyr/multi-agent-coding-timeline)
are complementary **upstream exporter / downstream application** tools:

| | AI Exporter (this project, upstream) | AI Coding Timeline Scanner (downstream) |
| --- | --- | --- |
| Goal | Extract and export conversations from 26+ agents into a portable archive (`manifest.json`, per-thread JSON/Markdown, `interop.json`). | Reconstruct one project's activity across agents, devices and Git history into a unified, verifiable timeline, clustered by project. |
| Output | Export archive, Markdown, JSON, training/eval formats (Transfer2Eval). | Timeline Package with evidence levels, provenance, SHA-256 integrity, an offline viewer and an interactive local app. |
| Identity | `thread_id`, `session.native_id`, `messages[].id`, `device.source_device_id`. | `dedup_key` + `content_hash` + provenance; `source_device_id` / `scanner_device_id` are separated. |

The interop contract above (schema 1.1.0) exists for exactly this link: the downstream
tool's built-in `al-exporter` import adapter reads an archive via `--source-root` +
`manifest.json`, adopts the `device.source_device_id` declared source device, deduplicates
deterministically using `session.native_id` / `messages[].id` / `tool_call`, and derives
per-field capability levels from `interop.json` actual non-empty rates (`empty` / `absent` mean
`unavailable`). Imported events are always `agent_reported` / `derived` there; Git facts come
only from its own read-only Git Scanner and are never inferred from the archive.

Both tools work independently: AI Exporter needs no downstream tool to back up or export,
and the downstream tool scans native agent logs (`~/.codex`, `~/.cursor`, ...) directly —
an archive is just one optional input source. See the downstream
[README ("Relationship with AI Exporter")](https://github.com/zhyr/multi-agent-coding-timeline/blob/main/README.md)
for the contract from the consumer side.

### Project Structure

```
AI-exporter/
├── core/               # Core scanning and processing logic
│   ├── scan.js        # Multi-source scanning
│   ├── normalize.js   # Data normalization
│   ├── convert.js     # Format conversion
│   └── import.js      # Agent-specific import
├── src/               # CLI and server
│   ├── server/       # Express server with REST API
│   └── cli.js        # Command line interface
├── viewer/            # Web UI
├── tests/             # Unit tests
└── adapter/           # Format adapters
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/scan` | Start scanning |
| GET | `/api/scan/status` | Scan status |
| POST | `/api/export` | Export data |
| POST | `/api/import-file` | Import file |
| POST | `/api/import-to-agent` | Import to agent |
| GET | `/api/agents` | List supported agents |
| GET | `/api/stats` | Statistics |

### Transfer2Eval (Session → Eval Datasets)

Compile sessions from 17+ tools into **replayable tasks / preference data / RL environments / execution-reward candidates** for evaluation and training:

- **Mining**: extract self-contained task segments (with continuation-message merging) into replayable trajectories
- **Evidence ranking**: score on 5 dimensions (interaction depth, execution traces, coverage, ...)
- **Gate routing**: auto-route to accept / review / reject based on evidence score
- **Build**: compile tasks, preference, RL-environment and reward datasets
- **Dual-state verification**: runtime consistency + offline static checks (dangerous commands / sensitive info / leakage detection)
- **Difficulty calibration**: estimate difficulty level from context length and evidence strength
- **Human annotation**: per-episode labeling (label / content / prompt fix / ground_truth fix) in the web UI
- **Export**: Eval CSV (12 columns) and SFT / DPO JSONL with idempotent SHA-256 manifest

**CLI**: `node src/cli.js t2e` (subcommands: `mine` / `build` / `verify` / `calibrate` / `export` / `annotate` / `stats`)

**Web**: run `npm run serve`, open `http://127.0.0.1:8080`, use the "🧠 Transfer2Eval" topbar menu (API + annotation panel).

**Storage**: `./agent-backup/transfer2eval/` (episodes / tasks / datasets, JSON persistence with provenance chain).

**CLI subcommands**:

| Subcommand | Description |
|------------|-------------|
| `pipeline` | Run the full pipeline (scan → mine → gate → build → verify → calibrate → export) |
| `mine` | Mine episodes + evidence ranking + gating only |
| `status` | Pipeline stats and status distribution |
| `list` | List episodes (filter by `--status` / `--source`) |
| `gate` | Manual gating (`--episode` + `--decision accept/review/reject`) |
| `annotate` | Annotation/comment/fix (`--episode` + `--label` + `--content`) |
| `build` | Build a task (replay / preference / RL / reward) |
| `verify` | Run audit verification on a task |
| `calibrate` | Difficulty calibration on a task |
| `export` | Export datasets (`--format eval/cms_sft/cms_dpo/all`) |

Examples:

```bash
node src/cli.js t2e pipeline --input ./agent-backup
node src/cli.js t2e mine --input ./agent-backup --json
node src/cli.js t2e gate --episode ep-xxxx --decision accept
node src/cli.js t2e annotate --episode ep-xxxx --label valid --content "ok"
node src/cli.js t2e export --format all --split candidate_generated
```

**REST API (`/api/t2e/*`)**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/t2e/status` | Pipeline status stats |
| POST | `/api/t2e/pipeline` | Run full pipeline (async job) |
| POST | `/api/t2e/mine` | Mine + evidence + gate (async job) |
| GET | `/api/t2e/episodes` | List episodes (paged / status filter) |
| GET | `/api/t2e/episodes/:id` | Episode detail |
| POST | `/api/t2e/episodes/:id/gate` | Manual gating |
| POST | `/api/t2e/episodes/:id/annotate` | Annotation / comment / fix |
| GET | `/api/t2e/tasks` | List tasks |
| GET | `/api/t2e/tasks/:id` | Task detail |
| POST | `/api/t2e/tasks/:id/build` | Build task |
| POST | `/api/t2e/tasks/:id/verify` | Audit verification |
| POST | `/api/t2e/tasks/:id/calibrate` | Difficulty calibration |
| POST | `/api/t2e/export` | Export datasets (eval/cms_sft/cms_dpo/all) |
| GET | `/api/t2e/datasets` | List exported datasets |

### FAQ

**Q: My sessions are not found (data is not in a default location)?**
Only well-known directories under HOME are scanned by default. If a tool uses a custom data dir (e.g. `CODEX_HOME`, portable installs), open **Settings → Extra scan directories** in the web UI and list the session directory line by line, then run an incremental scan again. `~` expansion and any absolute path are supported.

**Q: Is Trae / Trae CN / Trae Work / Trae Work CN supported?**
Directory discovery covers `.trae/`, `.trae-work/`, `.traework/`, `Application Support/Trae*`, `.config/Trae*` (including Windows `%APPDATA%` and Linux XDG). Trae / Trae CN map to source `trae`; Trae Work / Trae Work CN map to `traework`. Sessions, tool calls, and runtime logs use the generic chat / tool / log parser and have not been checked field-by-field against an official install. Add non-default locations via **Extra scan directories**.

**Q: Are newer tools like WorkBuddy / ZCode / CodeBuddy supported?**
Default data directories and source detection are covered (including CN variants, on macOS / Linux / Windows). VS Code-family `*.vscdb` files are still read with the existing keys. Session, chat, tool use, and runtime logs in JSON / JSONL use the generic parser. That is not a complete proof of each product's private format. Point **Settings → Extra scan directories** at a non-default directory.

**Q: Scan completes but no data is loaded?**
Check in order: ① make sure the tool actually produced sessions; ② whether sessions live outside any scanned directory; ③ whether the scan log shows a non-zero "Found N candidate files"; ④ if the file format is unsupported, try **Import** instead.

### Changelog

#### v2.2.2

- WorkBuddy dedicated session parse: `projects/<cwd>/<uuid>.jsonl` + `workbuddy.db` (including `.workbuddy-ai`); clean `<user_query>` / `<system-reminder>`; tool calls retained.
- Export gains a per-source-file `.export_state.json` mtime cursor; Claude Code local truncation signals land in `meta.extra.transcript_truncated` (offline only).
- New source `cursor_cli` (`~/.cursor/chats` store.db heuristic extract); T2E no longer treats `tool_result` as a new user turn.
- Tests/fixtures use synthetic paths only (e.g. `/Users/demo`); real `agent-backup` / `.env` stay out of the repo.

#### v2.2.1

- A file with explicit `sessionId` / `session_id` / `trace_id` values splits into separate threads. Tool calls are stored as `message.meta.kind` (`tool_use` / `tool_result`), and a tool result's `name` counts as T2E evidence.
- Runtime logs normalize to `type: log` and stay out of eval mining. WorkBuddy startup lines under a log/run path that begin with a timestamp (`_type: mark|summary`) keep the phase and `epochMs`.
- Trae Work / Trae Work CN use source `traework`, separate from `trae`. CodeBuddy, WorkBuddy, ZCode, and Trae directory discovery covers macOS, Linux, and Windows. JSON / JSONL still uses the generic parser and has not been checked field-by-field against an official install.
- Export conforms shapes seen in real data before write (`recognition_confidence: medium`, string `context.files`). `t2e pipeline` reads an existing backup and does not scan disk in that step. `agent` records that contain a user turn can be mined.
- Diagnostic scripts require a real export directory and no longer synthesize sessions. This release does not execute scripts, replay tool chains, or turn runtime logs into tasks.

#### v2.2.0

- New **WorkBuddy** (Tencent) and **ZCode** (Zhipu Z.ai) support: built-in default data-dir scanning, source detection and `*.vscdb` conversation extraction; `detectTool`, source enum, schema validation and T2E domain maps extended accordingly.

#### v2.1.1

- **Full Trae family support** (Trae / Trae CN / Trae Work / Trae Work CN); all default data dirs are scanned automatically.
- New **"Extra scan directories"** setting in the web UI: point the scanner at custom Codex/Trae session dirs (e.g. custom `CODEX_HOME`) without editing code.
- Fix schema validation on export: `agent` records are now valid (previously agent sessions failed validation).
- Security: bumped `fast-uri` to 3.1.7 (fixes GHSA-v39h-62p7-jpjc / GHSA-q3j6-qgpj-74h6).

#### v2.1.0

- Added **Transfer2Eval**: compiles sessions from 17+ tools into replayable tasks / preference data / RL environments / reward candidates (evidence ranking → gate routing → build → dual-state verification → difficulty calibration → human annotation → dataset export).
- Added "🧠 Transfer2Eval" topbar menu and `/api/t2e/*` REST API; annotation modal auto-fills label, content, prompt and ground_truth from the selected episode.
- Normalization: JSONL array-line parsing and continuation-message merging ("keep going" etc.) to avoid fragmenting sessions.
- Dataset export: Eval CSV (12 columns) and SFT/DPO JSONL with idempotent SHA-256 manifest.

### Development

```bash
# Run tests
npm test

# Run with coverage
npm run test:cov
```

### License

MIT License

---