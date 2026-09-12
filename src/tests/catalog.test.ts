import { describe, expect, test } from "bun:test";
import {
  defaultEffort,
  normalizeCatalog,
  parseEfforts,
  sortProviders,
} from "../catalog";

const fixture = {
  openai: {
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-6-astra": {
        name: "GPT-6 Astra",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "xhigh"] },
        ],
        tool_call: true,
        limit: { context: 400000, output: 128000 },
      },
      "embedding-only": {
        name: "Embedding",
        tool_call: false,
      },
    },
  },
  openrouter: {
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    npm: "@openrouter/ai-sdk-provider",
    env: ["OPENROUTER_API_KEY"],
    models: {
      "deepseek/deepseek-chat": {
        name: "DeepSeek Chat",
        reasoning: false,
        tool_call: true,
      },
    },
  },
  anthropic: {
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-4-6": {
        name: "Claude Sonnet 4.6",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "max"] },
        ],
        tool_call: true,
      },
    },
  },
};

describe("models.dev catalog", () => {
  test("解析供应商支持范围与模型能力", () => {
    const providers = normalizeCatalog(fixture);
    const openai = providers.find((provider) => provider.id === "openai");
    const openrouter = providers.find(
      (provider) => provider.id === "openrouter",
    );
    const anthropic = providers.find(
      (provider) => provider.id === "anthropic",
    );

    expect(openai?.supported).toBe(true);
    expect(openai?.apiStyle).toBe("responses");
    expect(openai?.models).toHaveLength(1);
    expect(openai?.models[0]?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(openrouter?.supported).toBe(true);
    expect(openrouter?.apiStyle).toBe("chat_completions");
    expect(anthropic?.supported).toBe(false);
    expect((anthropic?.reason ?? "").length).toBeGreaterThan(0);
  });

  test("解析思考强度并选择默认值", () => {
    expect(
      parseEfforts({
        reasoning_options: [
          { type: "budget_tokens", min: 1024 },
          { type: "effort", values: ["low", "high"] },
        ],
      }),
    ).toEqual(["low", "high"]);
    expect(defaultEffort(["low", "medium", "high"])).toBe("medium");
    expect(defaultEffort(["low", "high"])).toBe("low");
    expect(defaultEffort([])).toBeNull();
  });

  test("支持的供应商排在前面", () => {
    const providers = sortProviders(normalizeCatalog(fixture));
    expect(providers[0]?.id).toBe("openai");
    expect(providers[1]?.id).toBe("openrouter");
  });
});
