# Plex 实现状态与验证记录

最后更新：2026-09-12

## 已完成实现

### 工程与工具链

- 使用 Bun 初始化依赖与脚本，提交 `bun.lock`。
- Tauri 2 桌面工程使用 React 19、TypeScript 和 Vite。
- `scripts/build-sidecar.ts` 通过 `bun build --compile` 生成 `src-tauri/binaries/plex-agent-<target-triple>`。
- Tauri `beforeDevCommand` 与 `beforeBuildCommand` 都会先构建 Sidecar。
- 编译后的 Sidecar 约 62 MB，包含 Bun 运行时，可独立执行。

### Bun Sidecar

- `sidecar/src/main.ts` 实现 JSONL 请求/事件协议，stdout 只传输协议消息，日志同样以结构化消息返回。
- 支持命令：`ping`、`start_task`、`approve`、`reject`、`cancel`、`list_tasks`、`get_task`、`shutdown`。
- `sidecar/src/db.ts` 使用 `bun:sqlite` 保存任务、消息、事件、工具调用和审批记录，启用 WAL。
- Sidecar 启动时把 `pending`、`running`、`awaiting_approval` 状态的任务标记为 `interrupted`。
- `sidecar/src/agent.ts` 使用 OpenAI Agents SDK 的 `run(..., { stream: true })`，消费 `output_text_delta` 事件，并处理 `interruptions`、`state.approve()` 与 `state.reject()`。
- 任务取消通过 `AbortController` 传递给 SDK；等待审批时取消会立即完成状态转换，并标记未决审批为 `cancelled`。
- `ProviderRuntimeConfig` 支持按任务传入供应商、Base URL、协议、模型与思考强度；OpenAI 走 Responses，兼容供应商走 Chat Completions。
- 任务表新增 `provider_id`、`provider_name`、`reasoning_effort`，历史界面可以显示供应商与强度。

### 文件工具

- `list_directory`：列出授权目录内的直接子项。
- `search_text`：递归搜索文本，跳过 `.git`、`node_modules`，限制结果数量与深度。
- `read_text_file`：读取 UTF-8 文本，限制 1 MB，检测二进制内容。
- `write_text_file`：创建或覆盖文本文件，写入上限 2 MB，强制审批。

路径守卫在每次读写时解析真实路径，检查 `..` 越界和符号链接逃逸。写入审批保存目标路径、原内容、新内容、字节数与 unified diff；执行前重新检查文件哈希，审批期间外部修改会导致写入停止。

### Rust 宿主

- `src-tauri/src/lib.rs` 管理 Sidecar 生命周期，读取 stdout 并按行解析 JSON，通过 `sidecar-event` 事件转发给前端。
- Sidecar 优先使用编译二进制，回退到 `bun run sidecar/src/main.ts`。
- 数据库位于 Tauri 应用数据目录的 `plex.sqlite`。
- `models_catalog` 下载并缓存 models.dev 目录，缓存有效期 24 小时，网络失败时回退本地缓存。
- macOS 使用 `security` 命令读写钥匙串，服务名为 `com.plex.desktop.provider`，账号为供应商 ID。
- `provider_key_status` 检查环境变量、钥匙串和本地服务；`save_provider_key` 与 `delete_provider_key` 管理单个供应商。
- `start_task` 在 Rust 侧解析 Key，构建 Sidecar 请求并注入密钥，密钥不经过前端持久化。
- `list_custom_providers`、`save_custom_provider`、`delete_custom_provider` 管理自定义供应商，配置保存在应用数据目录的 `custom-providers.json`。
- `fetch_provider_models` 调用 `{Base URL}/models`，支持 Bearer Key、OpenAI `data[]`、Ollama `models[]` 和字符串数组响应。
- 应用退出时终止 Sidecar 子进程。

### React 界面

- Codex 风格布局：左侧任务列表，中间对话与工具记录，底部任务输入框。
- 默认白色主题，设置页支持黑白切换，选择保存在本地并在启动前恢复。
- 任务列表与历史记录。
- 新建任务：目录选择、目标描述、模型供应商与模型选择、思考强度选择。
- 流式文本、工具执行卡片、失败信息。
- 写入审批卡片展示 unified diff，支持批准与拒绝。
- 运行中任务支持取消。
- 模型选择器支持供应商搜索、模型搜索、工具调用能力过滤与思考强度按钮。
- 设置页按供应商管理 Key，展示目录来源、更新时间、支持状态和不可用原因。
- 自定义供应商表单支持名称、Base URL、API Key、拉取模型列表、勾选模型和手动添加模型 ID。

### 模型供应商

- `src/catalog.ts` 解析 models.dev 目录，支持 OpenAI、OpenAI-compatible 与 OpenRouter。
- 模型列表过滤掉 `tool_call == false` 的条目，避免选择无法驱动 Agent 循环的模型。
- 思考强度读取 `reasoning_options` 中的 `effort.values`，默认优先 `medium`。
- 专用协议供应商（Anthropic、Google、Bedrock 等）显示为不可用，并给出原因。
- 自定义供应商与 models.dev 目录合并后进入同一个模型选择器；自定义模型支持 OpenAI-compatible 调用。
- 详细协议和边界见 `docs/models-and-providers.md`。

## 验证结果

以下命令在 2026-09-12 的实际 checkout 上执行通过：

```bash
bun run verify
bun run tauri build --debug --no-bundle
bun run tauri dev
```

验证内容：

- TypeScript 前端与 Sidecar 类型检查通过。
- 20 项 Bun 测试通过，72 个断言。
- `cargo check` 通过。
- `cargo test --lib` 通过 6 项本地测试；`models_dev_is_reachable` 网络测试手动执行通过。
- Tauri debug 无打包构建成功，产物为 `src-tauri/target/debug/plex`。
- 开发态启动时，主进程成功拉起 `plex-agent-aarch64-apple-darwin`；退出后两个进程都已清理。
- 开发态启动时成功拉取 models.dev，缓存文件约 4.4 MB，包含 213 个供应商。
- 编译后的 Sidecar 可独立启动，通过 `ping` 返回版本与数据库信息。
- 二进制验收测试在编译后的 Sidecar 中完成供应商字段传递、`list_directory`、两次 `read_text_file`、`write_text_file` 审批与写入，最终 `summary.md` 内容正确，任务状态为 `completed`。
- 本地 OpenAI-compatible mock 服务测试通过自定义 Base URL 完成 Chat Completions 工具调用、审批和写入，验证了自定义供应商完整链路。

验收测试使用 `PLEX_TEST_MODEL_SCRIPT` 注入 ScriptedModel，覆盖 SDK Agent 循环、流式运行、工具调用与审批恢复，不依赖外部网络。该变量仅用于测试。

## 尚未验证

- 真实 OpenAI 模型调用：本机未配置 `OPENAI_API_KEY`。
- 真实第三方供应商调用：尚未使用 OpenRouter、DeepSeek 等账号实测。
- 真实自定义网关调用：尚未连接用户的私有服务实测。
- 真实网络请求下的取消时延与 SDK 重试行为。
- 应用重启后恢复审批暂停点。当前仅保留历史记录并将未完成任务标记为 `interrupted`。
- `tauri build` 生成 DMG/APP 安装包、签名与公证。
- 拒绝审批时真实模型生成的后续回答。
- Windows、Linux 以及跨架构 Sidecar 打包。

## 已知设计限制

- 审批恢复依赖 Sidecar 进程内保存的 `RunState`。Sidecar 重启后无法继续原审批，只能重新发起任务。
- 工具结果与写入内容完整保存在本地 SQLite，未实现加密或保留期限。
- API Key 通过 `security` 命令行参数写入钥匙串，短暂出现在子进程参数中；后续可以改成更严格的原生 Keychain API。
- 前端历史回放以事件流为准，未对大量事件做虚拟滚动。
- 首个版本只允许写入已存在的目录，不自动创建中间目录。
- 供应商支持范围目前为 OpenAI 与 OpenAI-compatible。专用协议供应商需要后续适配器。
- `budget_tokens` 思考预算和供应商自定义参数尚未进入界面。
- 自定义供应商的模型能力依赖用户自行确认；当前不读取自定义模型的上下文长度和思考强度元数据。
