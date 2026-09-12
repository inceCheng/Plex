# 模型供应商与思考强度

最后更新：2026-09-12

## 数据来源

Plex 从 `https://models.dev/api.json` 获取供应商和模型目录。当前接口无需认证，返回全部供应商的模型元数据。

Rust 宿主负责下载和缓存：

- 缓存位置：Tauri 应用数据目录下的 `models.dev.json`。
- 缓存有效期：24 小时。
- 手动刷新：设置页的“刷新目录”。
- 网络失败时，如果存在本地缓存，继续使用缓存；没有缓存时返回错误。

当前目录包含 213 个供应商，文件约 4.6 MB。

## 支持的供应商范围

第一版通过 OpenAI SDK 的传输层接入供应商，支持范围如下：

| 类型 | 协议 | 说明 |
| --- | --- | --- |
| OpenAI | Responses API | `provider.id == "openai"`，使用 `OpenAIResponsesModel` |
| OpenAI-compatible | Chat Completions | `npm == "@ai-sdk/openai-compatible"` 或兼容的 npm 标记，使用 `OpenAIChatCompletionsModel` |
| OpenRouter | Chat Completions | 使用 OpenRouter 的 OpenAI-compatible 入口 |
| 本地服务 | Chat Completions | `127.0.0.1`、`localhost` 或 LMStudio 地址，不要求 API Key |
| 自定义供应商 | 可选 | 用户填写 Base URL、Key 和模型列表，按 OpenAI-compatible 接口调用 |
| 专用协议 | 暂不支持 | Anthropic、Google、Bedrock 等需要专用适配器的供应商在界面中显示不可用原因 |

模型列表只保留 `tool_call` 不为 false 的模型，因为 Plex 的 Agent 循环依赖工具调用，缺少工具能力的模型无法完成任务。

## 自定义供应商

设置页的“自定义供应商”用于接入不在 models.dev 目录中的服务，或者需要覆盖默认网关地址的部署。

配置步骤：

1. 填写供应商名称和 Base URL，例如 `https://gateway.example.com/v1`。
2. 填写 API Key。本地服务可以留空，或在保存后不要求认证。
3. 点击“拉取模型列表”。Plex 调用：

   ```http
   GET {Base URL}/models
   Authorization: Bearer {API Key}
   ```

4. 在返回的模型列表中勾选需要开放的模型。
5. 如果服务没有 `/models` 接口，可以手动添加模型 ID。
6. 保存后，自定义供应商会出现在模型选择器中。

接口响应支持以下形式：

- OpenAI 形式：`{ "data": [{ "id": "model-id", "name": "Model" }] }`
- Ollama 形式：`{ "models": [{ "model": "model-id" }] }`
- 字符串数组：`["model-a", "model-b"]`

自定义供应商默认使用 Chat Completions。若上游服务提供 Responses API，可以在配置中把协议改为 Responses。

自定义供应商配置保存在 Tauri 应用数据目录的 `custom-providers.json`。API Key 按供应商独立保存到 macOS 钥匙串，账号 ID 使用 `custom:<timestamp>`。自定义模型目前没有 models.dev 的思考强度元数据，界面不会显示强度按钮，也不会发送 `reasoning_effort`。

## 密钥管理

- 每个供应商的 Key 保存在 macOS 钥匙串，服务名为 `com.plex.desktop.provider`，账号为供应商 ID。
- 也支持通过 models.dev 给出的环境变量读取，例如 `OPENAI_API_KEY`、`OPENROUTER_API_KEY`。
- 启动任务时由 Rust 读取 Key，并只通过 Sidecar stdin 传递。
- API Key 不写入 SQLite、任务事件、工具记录或前端持久化存储。
- 本地供应商可以使用占位 Key，Rust 会按本地地址规则放行。

## 思考强度

思考强度来自模型的 `reasoning_options`：

- 读取 `type == "effort"` 的 `values`，在模型选择器中展示为可选按钮。
- 默认优先选择 `medium`，不存在时选择第一个值。
- 没有 `effort` 选项的模型不发送思考强度参数。
- Sidecar 把选择写入 Agents SDK 的 `modelSettings.reasoning.effort`。
- Responses API 将该值作为 `reasoning.effort` 发送；Chat Completions 路径由 SDK 映射为 `reasoning_effort`。

`budget_tokens` 类型暂未暴露，因为不同供应商的预算语义和 SDK 支持程度不一致。后续可以按供应商增加专用映射。

## 请求链路

```text
前端选择内置或自定义 provider + model + effort
  → Tauri command start_task
  → Rust 读取环境变量或钥匙串中的 Key
  → Sidecar 创建 OpenAIProvider(baseURL, apiKey, useResponses)
  → Agent 使用所选模型与 modelSettings.reasoning.effort
  → 流式事件沿原链路返回界面
```

任务记录保存 `provider_id`、`provider_name`、模型 ID 和 `reasoning_effort`，方便历史回放。密钥字段不进入数据库。

## 已知限制

- 只支持 OpenAI 与 OpenAI-compatible 协议。专用供应商适配器尚未实现。
- 自定义供应商的模型列表依赖 `/models` 接口，缺失时需要手动填写模型 ID。
- 自定义模型的上下文长度、思考强度、成本和工具能力需要用户根据服务文档自行确认。
- models.dev 的 `cost`、`modalities`、`structured_output` 等字段尚未用于筛选或展示。
- 供应商自定义参数，例如特定网关的路由偏好、缓存开关，尚未暴露。
- `budget_tokens` 思考预算暂未支持。
- 供应商可用性、模型访问权限和计费以实际账号为准，目录信息只作为选择参考。
