# Plex

本地优先的通用桌面 Agent。用户在桌面界面选择工作目录并描述目标，Agent 通过工具读取资料、连续执行步骤，并在写入文件前请求审批。

第一阶段聚焦本地文本文件任务：列目录、搜索、读取，以及审批后创建或覆盖文件。

## 技术栈

- Tauri 2：桌面窗口、系统对话框、Sidecar 进程管理与事件转发。
- React 19 + TypeScript + Vite：任务、对话、工具记录、审批与设置界面。
- Bun 1.3：依赖管理、脚本、测试、Sidecar 运行时与单文件编译。
- OpenAI Agents SDK TypeScript `@openai/agents` 0.18：Agent 循环、流式事件、工具调用与审批暂停。
- Bun SQLite：任务、消息、事件、工具调用和审批记录持久化。
- models.dev：供应商与模型目录，缓存 24 小时。
- macOS Keychain：按供应商保存 API Key，密钥不进入 SQLite、日志或前端持久化。

## 开发命令

```bash
bun install          # 安装依赖
bun run tauri dev    # 构建 Sidecar、启动 Vite 与 Tauri 窗口
bun run verify       # 构建 Sidecar、类型检查、16 项测试、Rust 检查
bun run sidecar:build
bun run test
```

首次执行 Rust 检查前需要先生成 Sidecar 二进制，因为 Tauri `externalBin` 配置要求对应文件存在：

```bash
bun run sidecar:build
bun run check:rust
```

## 目录结构

```text
src/                    React 界面与 Tauri 调用封装
src/components/         模型选择器与供应商设置
src/catalog.ts          models.dev 目录解析与支持范围判断
sidecar/src/            Bun Agent Sidecar：协议、SQLite、工具、任务执行
sidecar/tests/          Bun 测试：路径、工具、任务循环与协议验收
scripts/build-sidecar.ts 使用 bun build --compile 生成 Tauri sidecar
src-tauri/              Tauri Rust 宿主、Sidecar 管理与 macOS 钥匙串
docs/product-scope.md   产品范围与验收条件
docs/implementation-status.md  当前实现与验证边界
docs/models-and-providers.md   供应商、协议、密钥与思考强度说明
```

## 运行链路

```text
React 界面
  → Tauri invoke
  → Rust SidecarManager
  → Bun Agent 进程（JSONL stdin/stdout）
  → OpenAI Agents SDK / 本地文件工具 / SQLite
  → Rust 事件转发
  → React 实时渲染
```

Sidecar 由 Rust 拉起，优先使用 `src-tauri/binaries/plex-agent-<target-triple>`，找不到时回退到 `bun run sidecar/src/main.ts`。发布构建通过 Tauri `externalBin` 打包编译后的 Sidecar，终端用户不需要安装 Bun。

## 权限与安全边界

- 工作目录在任务创建时解析为真实路径，文件工具在每次访问时检查路径与符号链接目标，越界访问会被拒绝。
- 创建或覆盖文件前记录审批快照，包含目标路径、当前内容、拟写入内容和 unified diff。
- 审批绑定具体工具调用与内容。执行写入前再次校验文件状态，审批期间文件发生变化时停止覆盖。
- 拒绝审批不会执行写入；取消任务会中止当前模型请求并阻止后续工具调用。
- 应用异常退出后，未完成任务标记为 `interrupted`，历史记录可查看；自动恢复尚未实现。

## 模型配置

界面使用接近 Codex 的深色布局：左侧任务列表，中间对话与工具记录，底部是任务输入框和模型选择器。

模型选择器读取 models.dev 目录，支持：

- 在供应商之间搜索和切换。
- 在所选供应商的模型之间搜索和切换。
- 按模型的 `reasoning_options` 选择思考强度。
- 在供应商设置中分别保存多个 API Key。

OpenAI 使用 Responses API；OpenAI-compatible 供应商使用 Chat Completions。Provider、模型和思考强度的完整说明见 `docs/models-and-providers.md`。

也可以直接使用环境变量：

```bash
OPENAI_API_KEY=sk-... bun run tauri dev
OPENROUTER_API_KEY=sk-or-... bun run tauri dev
```

默认优先选择 `openai/gpt-6-astra`；目录不可用时回退到环境变量和默认模型。

## 测试

`bun run test` 覆盖：

- 路径越界与符号链接逃逸。
- 目录列举、文本搜索、文本读取与写入快照校验。
- Agent 多步读取、写入审批、拒绝、取消和审批期间文件变化。
- JSONL 协议启动、无 API Key 失败回执、历史查询。
- 编译后 Sidecar 执行完整验收任务并写入 `summary.md`。
- models.dev 目录解析、供应商支持范围、模型工具能力和思考强度选项。

二进制验收测试使用 `PLEX_TEST_MODEL_SCRIPT` 注入 ScriptedModel，不访问网络。该变量只用于测试；生产运行需要配置 API Key。

## 当前限制

- 真实模型调用尚未验证，本机没有配置 API Key。
- Anthropic、Google、Bedrock 等专用协议供应商暂未接入，界面会显示不可用原因。
- `budget_tokens` 思考预算和供应商自定义参数暂未支持。
- 审批暂停状态保存在 Sidecar 内存中，应用重启后只保留历史记录，不能继续原审批。
- 已取消任务的模型请求依赖 SDK 的 `AbortSignal` 支持；真实网络请求下的取消行为仍待实测。
- 安装包、签名、公证和 Windows/Linux 分发尚未验证。
