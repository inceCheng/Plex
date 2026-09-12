# Plex 项目记忆

最后更新：2026-09-12

## 协作约定

- 使用中文沟通，表达直接，说明具体职责与执行过程。
- 禁止使用“不是……而是……”的句式。
- 明确区分用户已确认的方向、设计建议、实际实现与验证结果。
- 开始工作前阅读本文件及 `docs/product-scope.md`，并检查当前文件和 Git 状态；以实际代码和验证结果为准。
- 完成重要实现、验证或设计变更后，更新本文件，保留简洁且准确的当前状态。
- 不在项目记忆中保存 API Key、令牌或其他秘密。

## 产品目标与已确认方向

- 项目名称：Plex。
- 项目目录：`/Volumes/AppleDrive/dev/Plex`。
- 用户希望使用 Tauri 与 OpenAI Agents SDK 构建通用桌面 Agent。
- 用户已明确选择 Bun 作为 JavaScript/TypeScript 的统一工具链与 Agent 运行时，覆盖依赖管理、脚本、测试和构建；Sidecar 使用 Bun。
- 用户通过自然语言提出目标，Agent 选择工具、连续执行步骤、检查结果，并按需提问或申请审批。
- 文件处理是第一个验证场景；产品需要支持后续扩展至代码、命令、网页及外部服务。
- 各类任务共用进度展示、权限审批、取消、历史记录与结果交付机制。

## 当前状态

- 已完成 Tauri 2 + React 19 + TypeScript 工程初始化，依赖和脚本由 Bun 管理，`bun.lock` 已生成。
- 已实现 Bun Sidecar：JSONL 协议、SQLite 持久化、OpenAI Agents SDK 运行循环、流式事件、工具审批、取消与中断标记。
- 已实现首批文件工具：`list_directory`、`search_text`、`read_text_file`、`write_text_file`。
- 已实现 Rust 宿主：Sidecar 进程管理、stdio JSON 转发、事件推送、models.dev 目录缓存、多供应商钥匙串读写与应用退出清理。
- 已实现 React 界面：Codex 风格深色布局、任务列表、新建任务、目录选择、模型供应商选择、思考强度选择、流式回复、工具记录、审批 diff、取消与历史查看。
- 已接入 models.dev：缓存供应商与模型目录，支持 OpenAI Responses、OpenAI-compatible Chat Completions 与本地服务；专用协议供应商显示不可用原因。
- 已实现多供应商密钥配置：每个供应商独立保存到 macOS 钥匙串，Rust 在启动任务时读取并仅通过 Sidecar stdin 传递。
- Sidecar 使用 `bun build --compile` 生成 `src-tauri/binaries/plex-agent-<target-triple>`，Tauri 通过 `externalBin` 打包。
- 本机 macOS 26.6、arm64、Bun 1.3.13、Rust 1.98、Xcode 26.5 环境验证通过。
- `bun run verify` 已通过：前端与 Sidecar 类型检查、16 项 Bun 测试、`cargo check`。
- `cargo test --lib` 的 2 项本地测试通过；models.dev 网络测试已单独执行通过。
- `bun run tauri build --debug --no-bundle` 已通过，产物为 `src-tauri/target/debug/plex`。
- `bun run tauri dev` 已验证主进程能够拉起编译后的 Sidecar，退出后两个进程都被清理。
- 开发态启动时成功从 models.dev 拉取目录，缓存约 4.4 MB、213 个供应商。
- 编译后的 Sidecar 已通过二进制验收测试：多步读取、写入审批、批准后写入 `summary.md`、历史查询全部成功。
- 本机没有配置 `OPENAI_API_KEY`，真实模型调用、真实网络取消和真实模型下的拒绝分支尚未验证。
- 生成安装包、签名、公证、Windows 与 Linux 分发尚未验证。
- 当前项目已初始化为 Git 仓库；提交状态以 `git log` 和 `git status` 为准。
- `AGENTS.md` 与 `docs/product-scope.md` 曾在脚手架阶段被 `create-tauri-app --force` 覆盖，已根据本轮会话上下文恢复并更新。

## 当前设计建议

以下方案已落地为第一阶段实现，具体依赖版本和发布兼容性继续以验证记录为准：

- Tauri 2：桌面窗口、系统集成与进程管理。
- React + TypeScript：聊天、任务、执行记录、审批和设置界面。
- Bun Sidecar + OpenAI Agents SDK TypeScript：智能体执行与工具调度。
- SQLite：任务、消息、工具记录及审批状态持久化。
- 通信链路：前端 WebView → Tauri Rust IPC → Bun Sidecar → 模型 API / 工具 / 存储；事件沿原链路返回。
- Sidecar 协议、模型配置、密钥保存与数据库结构已有首版实现，后续变更需要同步更新 `docs/implementation-status.md`。

原型暂按 macOS、个人使用、用户自带 API Key 推进。Key 按供应商保存于 macOS 钥匙串，服务名为 `com.plex.desktop.provider`，账号为供应商 ID。

## Bun 工具链与打包约定

- 使用 `bun install` 管理依赖并提交 `bun.lock`；JavaScript/TypeScript 工具链统一使用 Bun。
- 使用 `bun run` 组织开发和构建脚本，使用 `bun test` 运行 JavaScript/TypeScript 测试；Rust 测试仍由 Cargo 执行。
- 开发态 Agent 进程可由 Bun 直接运行 TypeScript。开发脚本统一使用 `bun run`。
- Sidecar 使用 `bun build --compile` 生成包含 Bun 运行时的可执行文件，已在本机验证可独立启动、可访问 `bun:sqlite`，并由 Tauri `externalBin` 打包。
- 前端构建通过 Bun 脚本执行 Vite；界面代码运行于 Tauri WebView。
- 桌面构建入口统一由 Bun 脚本调用 Tauri CLI，Rust 编译和安装包生成使用 Tauri / Cargo 及平台工具链。
- 后续引入 MCP 时需要验证子进程、资源路径与编译后 Sidecar 的兼容性。
- 发布前仍需验证签名、公证、安装包运行和目标架构。

## 第一阶段范围

- 聊天、任务列表与流式回复。
- 用户选择工作目录；列目录、搜索和读取文本文件。
- Agent 可按目标组合多次工具调用。
- 创建和修改文本文件前展示内容或差异，并申请审批。
- 支持取消、记录工具执行、保存会话和查看结果文件。
- 异常退出后的未完成任务标记为中断；自动恢复执行待后续设计。

后续建议依次扩展命令执行、网页检索、MCP、可复用任务配置，再按需求加入浏览器操作、后台任务和多 Agent 协作。

## 关键设计边界

- 文件权限由工具执行层校验，包括路径越界与符号链接；Tauri 权限机制不能替代 Sidecar 的访问约束。
- 审批绑定具体操作、参数和内容；写入前检查文件是否在审批期间发生变化。
- 取消后停止启动新工具调用，并尝试中止当前操作；记录已发生的修改。
- 外部文件与工具返回内容不能自行扩大任务权限。
- SDK 的运行状态与会话支持仍需结合应用实现任务持久化、幂等和崩溃恢复。
- 云模型调用需要联网，发送给模型的文件内容可能离开本机。
- OpenAI Agents SDK 官方接口已在 2026-09-12 核对：`run`、function tools、`stream: true`、`needsApproval`、`interruptions`、`state.approve()` 与 `state.reject()`。
- 供应商适配边界：OpenAI 使用 Responses；`@ai-sdk/openai-compatible` 与 OpenRouter 使用 Chat Completions；Anthropic、Google、Bedrock 等专用协议暂不接入。
- 思考强度来自 models.dev 的 `reasoning_options.effort.values`，写入 SDK 的 `modelSettings.reasoning.effort`。

## 首个验收场景

用户选择包含 Markdown 或文本资料的目录，要求“阅读这个目录里的资料，整理一份项目概览和待办清单，写入 summary.md”。

验证多步读取、真实执行状态、写入预览、批准与拒绝分支、目录权限、取消，以及重启后的历史记录。完整验收条件见 `docs/product-scope.md`。

2026-09-12 验证结果：使用 `PLEX_TEST_MODEL_SCRIPT` 注入 ScriptedModel 后，编译后的 Sidecar 已完成多步读取、审批预览、批准写入与历史查询；批准、拒绝、取消、审批期间文件变化和路径越界均由 Bun 测试覆盖。真实模型调用仍待配置 API Key 后验证。

## 下一步

1. 配置真实 OpenAI 或 OpenRouter API Key，运行首个完整模型验收，核对流式输出、工具调用、审批恢复与最终回答。
2. 验证第三方供应商的工具调用兼容性、思考强度参数和错误处理。
3. 验证真实网络请求下的取消行为、错误重试和超时处理。
4. 实现审批暂停状态的持久化与自动恢复，替换当前仅标记中断的行为。
5. 生成并验证 macOS 安装包，补齐签名、公证和首次启动说明。
6. 按产品路线进入第二阶段：受约束的命令执行、网页检索与 MCP 工具接入。

## 文档入口

- `AGENTS.md`：当前项目记忆与协作约定。
- `docs/product-scope.md`：产品范围、能力路线、设计边界和验收条件。
- `docs/implementation-status.md`：已实现内容、验证命令、测试证据和未验证边界。
- `docs/models-and-providers.md`：models.dev、供应商协议、密钥与思考强度说明。
- `README.md`：开发命令、目录结构和运行说明。

历史交接文件位于系统临时目录，其关键上下文已整理到项目文档中；后续接续无需依赖该临时文件。
