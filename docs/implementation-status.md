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
- Skill 作为完整目录导入，根目录必须包含 `SKILL.md`；宿主校验 YAML frontmatter 的 `name`、`description` 与官方字段范围，保留 `agents/`、`scripts/`、`references/`、`assets/` 及其他附属资源。
- Skill 目录复制到应用数据目录的 `skills/<name>/`，`skills.json` 保存入口、文件类型、相对路径、大小及启停状态。同名重导入通过临时目录和备份原子替换，删除同步清理整个安装目录。
- 导入拒绝符号链接、特殊文件、路径控制字符和超限内容；`SKILL.md` 最大 256 KB，单资源最大 10 MB，单 Skill 最多 512 个文件且总大小最大 50 MB，最多管理 32 个 Skill，所有入口正文合计最大 1 MB。
- 每次新建或继续会话时，Rust 把启用 Skill 的元数据、入口、资源清单和受限安装路径传给 Sidecar；Sidecar 再次校验数量、路径与大小，对模型只公开名称、说明和入口索引。

### React 界面

- Codex 风格布局：左侧任务列表，中间对话与工具记录，底部任务输入框。
- 默认白色主题，设置页支持黑白切换，选择保存在本地并在启动前恢复。
- 任务列表与历史记录。
- 新建任务：目录选择、目标描述、模型供应商与模型选择、思考强度选择。
- 流式文本、工具执行卡片、失败信息。
- 写入审批卡片展示 unified diff，支持批准与拒绝。
- 运行中任务支持取消。
- 同一任务支持多轮对话；完成一轮后可继续发送消息，用户消息靠右、Agent 消息靠左显示。
- 对话输入框持续显示；Agent 消息使用安全 Markdown 渲染，流式正文分段后与工具调用按事件序列排列。
- 聊天工作区使用 assistant-ui React 的 `AssistantRuntimeProvider`、Thread、Message 与 Message Parts primitives；本地 Sidecar 事件按原序映射为用户消息、Markdown 正文 Text part、处理状态 Reasoning part、工具与审批 Tool Call part。连续 Tool Call parts 通过官方推荐的 `MessagePrimitive.GroupedParts` 组成无边框折叠列表，单项显示名称、参数摘要、状态与耗时，展开后显示参数、结果、错误、审批 diff 与拒绝原因；输入框支持 Enter 发送与 Shift+Enter 换行。Motion 用于处理状态和工具列表进入动画。
- 同一次工具调用的开始与审批事件合并为一个 Tool Call part，并使用事件级唯一 ID，避免 assistant-ui `useResources` 因重复 `toolCallId` 中断前端渲染。
- 同一轮 Agent 的处理状态、工具调用与正文聚合为一个 Assistant UI 消息，保持事件顺序并只显示一次 Plex 标识；用户消息采用右侧浅色气泡，气泡宽度按折叠后可见行的文字宽度自适应并受最大宽度限制，溢出 6 行后显示展开控件，展开后可再次收起。
- 对话事件到达时自动跟随到底部；项目分组可折叠；模型选择器和任务提交都会过滤未配置凭据的供应商，本地服务可直接使用。
- 启动时先渲染启动壳，并并行请求本地项目与会话摘要；默认选中的会话和用户点击的会话才请求 `get_task` 加载详情。应用主体使用异步模块加载，聊天依赖初始化期间不会出现整页白板，运行时异常会展示错误与重新加载入口。
- 启动不请求 `models_catalog`。已保存的自定义供应商及模型只读取本地配置；用户展开设置中的供应商管理、手动刷新目录或保存自定义供应商时才加载 models.dev 目录及供应商 Key 状态。已存在会话直接使用 SQLite 持久化的供应商名称与模型 ID 显示。
- 模型选择器支持供应商搜索、模型搜索、工具调用能力过滤与思考强度按钮。
- 设置页按供应商管理 Key，展示目录来源、更新时间、支持状态和不可用原因。
- 自定义供应商表单支持名称、Base URL、API Key、拉取模型列表、勾选模型和手动添加模型 ID。
- 设置页使用系统目录选择器导入 Skill，展示入口文件、附属文件数量、目录总大小和可展开的资源清单；编辑器直接维护已安装目录中的 `SKILL.md`，名称和说明由 frontmatter 解析。
- 新建和继续会话时只注入启用 Skill 的名称、说明和入口索引。Sidecar 注册 `read_skill_resource` 专用工具；Agent 判断 Skill 与任务相关后先读取 `SKILL.md`，再按入口中引用的相对路径读取所需资源。工具拒绝绝对路径、`..`、未登记资源和符号链接逃逸。
- 独立会话可以使用启用 Skill 的受限资源读取工具，仍没有项目目录的列举、搜索、读写权限；附属脚本当前只可作为文本读取，尚未开放执行能力。
- 设置页供应商区域默认折叠为一级入口，显示已配置与可用数量；点击后才展开完整列表，避免信息冗余。
- SQLite 新增 `projects` 表，`tasks.project_id` 可为空并关联项目；侧栏按项目和最近会话分组展示。
- Rust 宿主在 `start_task` IPC 请求中转发 `projectId` 给 Sidecar，项目会话创建后会持久化在对应项目下，独立会话保留空归属。
- 项目下可创建多个会话，删除项目后会话保留为独立会话；独立会话使用空工作目录且不注册项目文件工具，仅在存在已启用目录型 Skill 时注册受限资源读取工具。
- Sidecar 提供 `create_project`、`list_projects`、`get_project` 和 `delete_project` 协议。
- 项目创建使用中文应用内弹窗，包含名称输入、工作目录选择、提交校验、错误提示、自动聚焦与 Escape 关闭。侧栏将项目作为父节点，会话以连接线和缩进作为子节点展示；独立会话只出现在“最近会话”。
- 侧栏品牌标识移除了装饰黑点，设置齿轮调整为更大的可聚焦按钮。
- 项目名称输入框仅在聚焦时显示单层蓝色边框；设置齿轮不使用外框。侧栏和会话输入区使用阴影保持清晰的悬浮层次；对话输入支持 Enter 发送和 Shift+Enter 换行。
- 对话主栏右上和右下角使用与输入框一致的 16px 圆角。设置弹窗打开时不读取 models.dev；供应商管理二级区域展开后，以及提交时缺少 Key 而直达该区域时，才按需读取目录和 Key 状态。
- 每条已完成 Agent 回复底部使用 assistant-ui `ActionBarPrimitive.Copy` 提供图标式复制操作，采用 Lucide 标准复制与完成图标；按钮只复制该消息的正文文本，复制后短暂显示成功状态。
- 侧栏会话列表采用 Codex 风格的紧凑单行布局：项目节点与会话条目约 30px 高，仅展示标题；项目内会话保留小幅左缩进，移除状态和更新时间的第二行元数据，提升列表信息密度。

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
- 25 项 Bun 测试通过，包含项目映射、独立会话、目录型 Skill 资源读取、多轮对话续跑、工具上下文与消息持久化验证。
- 前端与 Sidecar 类型检查通过，Sidecar 已重新编译以包含 `continue_task` 错误回执修复。
- `cargo check` 通过。
- `cargo test --lib` 通过 14 项本地测试，1 项 `models_dev_is_reachable` 网络测试按设计忽略；覆盖 Skill frontmatter、目录入口发现、资源清单、缺少入口与符号链接拒绝、内容限制和编辑状态保留。
- Tauri debug 无打包构建成功，产物为 `src-tauri/target/debug/plex`。
- 开发态启动时，主进程成功拉起 `plex-agent-aarch64-apple-darwin`；退出后两个进程都已清理。
- 开发态启动时成功拉取 models.dev，缓存文件约 4.4 MB，包含 213 个供应商。
- 编译后的 Sidecar 可独立启动，通过 `ping` 返回版本与数据库信息。
- 二进制验收测试在编译后的 Sidecar 中完成供应商字段传递、`list_directory`、两次 `read_text_file`、`write_text_file` 审批与写入，最终 `summary.md` 内容正确，任务状态为 `completed`。
- 本地 OpenAI-compatible mock 服务测试通过自定义 Base URL 完成 Chat Completions 工具调用、审批和写入，验证了自定义供应商完整链路。
- 启动分层加载改动已通过 `bun run build`、`bun run verify`（23 项测试）与 `bun run tauri build --debug --no-bundle`；当前生产前端主包约 694 KB，后续可继续把设置页等低频模块切分为异步 chunk，以进一步降低冷启动脚本解析成本。
- 最新聊天 UI 调整已通过 `bun run build`、`bun run verify`（23 项测试）和 `bun run tauri build --debug --no-bundle`；已启动 debug 桌面程序检查历史会话渲染。
- Agent 回复复制操作已通过 `bun run check:web`、`bun run build` 与 `git diff --check` 验证。
- 复制按钮显隐引发正文上移的问题已修复：回答容器固定预留 30px 底部操作区，按钮绝对定位，与正文容器的间隔由 6px 缩至 2px，对话区底部保留 48px。`bun run build`、`git diff --check` 通过；Playwright 挂载实际 `AssistantTimeline` 组件，在 1440px 和 390px 视口验证悬停显隐、复制反馈、正文不变时运行状态切换的显隐，正文坐标、滚动位置和滚动高度保持稳定，剪贴板内容正确。未进行原生 Tauri 窗口回归。
- 项目会话归属转发与复制控件调整已通过 `bun run build`、23 项 Bun 测试、`cargo check`、7 项 Rust 单元测试及 `git diff --check` 验证。
- 紧凑会话列表调整已通过 `bun run check:web`、`bun run build` 与 `git diff --check` 验证。
- 用户消息气泡按折叠可见行宽度自适应已通过 `bun run check:web`、`bun run build` 与 `git diff --check` 验证。
- 用户消息气泡最小宽度已设为 480px，展开和折叠状态均生效；窄窗口下受可用宽度限制并预留头像与间距。
- 气泡最小宽度调整通过 `bun run build` 和 `git diff --check`；Playwright 使用实际 CSS 的独立布局样例检查 1440px、390px、240px 视口，覆盖短消息、六行折叠消息与展开内容，确认最小宽度和头像间距，无横向溢出。此项未进行真实 Tauri 会话交互回归。

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
- Skill 列表接口仍会返回 `SKILL.md` 正文和完整资源清单；Skill 数量或入口体积继续增长时，可以拆分列表与详情接口以降低设置页首次读取开销。
- `budget_tokens` 思考预算和供应商自定义参数尚未进入界面。
- 自定义供应商的模型能力依赖用户自行确认；当前不读取自定义模型的上下文长度和思考强度元数据。
