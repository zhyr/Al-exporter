# AI Exporter

> 一键扫描、备份、导出 AI 编码工具对话数据，支持 26+ 主流 Agent，数据可转换为 Markdown/JSON/训练格式，赋能 AI 训练与跨工具迁移。

**Version 2.1.0** · MIT License

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
| CodeBuddy | `.codebuddy/` | ✅ |
| Kiro | `.kiro/` | ✅ |
| iFlow | `.iflow/` | ✅ |
| Qoder | `.qoder/` | ✅ |
| Trae | `.trae/` | ✅ |
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

### 更新日志

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
| CodeBuddy | `.codebuddy/` | ✅ |
| Kiro | `.kiro/` | ✅ |
| iFlow | `.iflow/` | ✅ |
| Qoder | `.qoder/` | ✅ |
| Trae | `.trae/` | ✅ |
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

### Changelog

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