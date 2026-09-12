# Plex

本地优先的通用桌面 Agent。用户在桌面界面选择工作目录并描述目标，Agent 通过工具读取资料、连续执行步骤，并在写入文件前请求审批。

第一阶段聚焦本地文本文件任务：列目录、搜索、读取，以及审批后创建或覆盖文件。

## 技术栈

- Tauri 2：桌面窗口、系统对话框、Sidecar 进程管理与事件转发。
- React 19 + TypeScript + Vite：任务、对话、工具记录、审批与设置界面。
- Bun 1.3：依赖管理、脚本、测试、Sidecar 运行时与单文件编译。
- OpenAI Agents SDK TypeScript `@openai/agents` 0.18：Agent 循环、流式事件、工具调用与审批暂停。
- Bun SQLite：任务、消息、事件、工具调用和审批记录持久化。
- macOS Keychain：保存 OpenAI API Key，密钥不进入 SQLite、日志或前端持久化。

## 开发命令

```bash
bun install          # 安装依赖
bun run tauri dev    # 构建 Sidecar、启动 Vite 与 Tauri 窗口
bun run verify       # 构建 Sidecar、类型检查、13 项测试、Rust 检查
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
sidecar/src/            Bun Agent Sidecar：协议、SQLite、工具、任务执行
sidecar/tests/          Bun 测试：路径、工具、任务循环与协议验收
scripts/build-sidecar.ts 使用 bun build --compile 生成 Tauri sidecar
src-tauri/              Tauri Rust 宿主、Sidecar 管理与 macOS 钥匙串
docs/product-scope.md   产品范围与验收条件
docs/implementation-status.md  当前实现与验证边界
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

应用内设置页将 API Key 保存到 macOS 钥匙串。也可以直接使用环境变量：

```bash
OPENAI_API_KEY=sk-... PLEX_MODEL=gpt-6-astra bun run tauri dev
```

默认模型为 `gpt-6-astra`，可在新建任务时覆盖。

## 测试

`bun run test` 覆盖：

- 路径越界与符号链接逃逸。
- 目录列举、文本搜索、文本读取与写入快照校验。
- Agent 多步读取、写入审批、拒绝、取消和审批期间文件变化。
- JSONL 协议启动、无 API Key 失败回执、历史查询。
- 编译后 Sidecar 执行完整验收任务并写入 `summary.md`。

二进制验收测试使用 `PLEX_TEST_MODEL_SCRIPT` 注入 ScriptedModel，不访问网络。该变量只用于测试；生产运行需要配置 API Key。

## 当前限制

- 真实模型调用尚未验证，本机没有配置 API Key。
- 审批暂停状态保存在 Sidecar 内存中，应用重启后只保留历史记录，不能继续原审批。
- 已取消任务的模型请求依赖 SDK 的 `AbortSignal` 支持；真实网络请求下的取消行为仍待实测。
- 安装包、签名、公证和 Windows/Linux 分发尚未验证。
