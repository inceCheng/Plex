export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  efforts: string[];
  toolCall: boolean;
  context: number | null;
  output: number | null;
}

export interface CatalogProvider {
  id: string;
  name: string;
  api: string | null;
  npm: string | null;
  env: string[];
  doc: string | null;
  models: CatalogModel[];
  supported: boolean;
  reason: string | null;
  apiStyle: "responses" | "chat_completions";
  local: boolean;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  reasoning_options?: unknown;
  tool_call?: unknown;
  limit?: { context?: unknown; output?: unknown } | null;
}

interface RawProvider {
  name?: unknown;
  api?: unknown;
  npm?: unknown;
  env?: unknown;
  doc?: unknown;
  models?: unknown;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseEfforts(model: RawModel): string[] {
  const options = Array.isArray(model.reasoning_options)
    ? model.reasoning_options
    : [];
  for (const option of options) {
    if (!option || typeof option !== "object") {
      continue;
    }
    const record = option as Record<string, unknown>;
    if (record.type !== "effort" || !Array.isArray(record.values)) {
      continue;
    }
    const values = record.values.filter(
      (value): value is string => typeof value === "string",
    );
    if (values.length > 0) {
      return values;
    }
  }
  return [];
}

export function defaultEffort(efforts: string[]): string | null {
  if (efforts.length === 0) {
    return null;
  }
  if (efforts.includes("medium")) {
    return "medium";
  }
  return efforts[0] ?? null;
}

function providerSupport(provider: {
  id: string;
  api: string | null;
  npm: string | null;
}): {
  supported: boolean;
  reason: string | null;
  apiStyle: "responses" | "chat_completions";
  local: boolean;
} {
  const local =
    provider.id === "lmstudio" ||
    (provider.api?.includes("127.0.0.1") ?? false) ||
    (provider.api?.includes("localhost") ?? false);

  if (provider.id === "openai") {
    return {
      supported: true,
      reason: null,
      apiStyle: "responses",
      local,
    };
  }

  const npm = provider.npm ?? "";
  const openAICompatible =
    npm === "@ai-sdk/openai-compatible" ||
    npm === "@openrouter/ai-sdk-provider" ||
    npm.includes("openai-compatible");

  if (openAICompatible && provider.api) {
    return {
      supported: true,
      reason: null,
      apiStyle: "chat_completions",
      local,
    };
  }

  return {
    supported: false,
    reason: provider.api
      ? `需要专用适配器（${npm || "unknown"}）`
      : "models.dev 未提供 OpenAI 兼容接口地址",
    apiStyle: "chat_completions",
    local,
  };
}

export function normalizeCatalog(raw: unknown): CatalogProvider[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }

  return Object.entries(raw as Record<string, RawProvider>).map(
    ([id, provider]) => {
      const api = stringValue(provider.api);
      const npm = stringValue(provider.npm);
      const support = providerSupport({ id, api, npm });
      const rawModels =
        provider.models && typeof provider.models === "object"
          ? (provider.models as Record<string, RawModel>)
          : {};
      const models = Object.entries(rawModels)
        .map(([modelId, model]): CatalogModel => ({
          id: modelId,
          name: stringValue(model.name) ?? modelId,
          reasoning: model.reasoning === true,
          efforts: parseEfforts(model),
          toolCall: model.tool_call !== false,
          context: numberValue(model.limit?.context),
          output: numberValue(model.limit?.output),
        }))
        .filter((model) => model.toolCall)
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        id,
        name: stringValue(provider.name) ?? id,
        api,
        npm,
        env: Array.isArray(provider.env)
          ? provider.env.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        doc: stringValue(provider.doc),
        models,
        supported: support.supported && models.length > 0,
        reason:
          support.supported && models.length === 0
            ? "目录中没有支持工具调用的模型"
            : support.reason,
        apiStyle: support.apiStyle,
        local: support.local,
      };
    },
  );
}

const FEATURED_PROVIDERS = [
  "openai",
  "openrouter",
  "deepseek",
  "mistral",
  "xai",
  "groq",
  "cerebras",
  "togetherai",
];

function providerRank(provider: CatalogProvider): number {
  const index = FEATURED_PROVIDERS.indexOf(provider.id);
  return index === -1 ? FEATURED_PROVIDERS.length : index;
}

export function sortProviders(
  providers: CatalogProvider[],
): CatalogProvider[] {
  return [...providers].sort((left, right) => {
    if (left.supported !== right.supported) {
      return left.supported ? -1 : 1;
    }
    const rank = providerRank(left) - providerRank(right);
    if (rank !== 0) {
      return rank;
    }
    if (left.models.length !== right.models.length) {
      return right.models.length - left.models.length;
    }
    return left.name.localeCompare(right.name);
  });
}

export function findProvider(
  providers: CatalogProvider[],
  providerId: string,
): CatalogProvider | undefined {
  return providers.find((provider) => provider.id === providerId);
}

export function findModel(
  provider: CatalogProvider | undefined,
  modelId: string,
): CatalogModel | undefined {
  return provider?.models.find((model) => model.id === modelId);
}
