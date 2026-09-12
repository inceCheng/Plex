import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  type ScriptedModelInput,
} from "@openai/agents/testing";

interface TestToolStep {
  type: "tool";
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

interface TestMessageStep {
  type: "message";
  text: string;
}

type TestStep = TestToolStep | TestMessageStep;

function isTestStep(value: unknown): value is TestStep {
  if (!value || typeof value !== "object") {
    return false;
  }
  const step = value as Record<string, unknown>;
  if (step.type === "message") {
    return typeof step.text === "string";
  }
  return (
    step.type === "tool" &&
    typeof step.name === "string" &&
    typeof step.callId === "string" &&
    Boolean(step.args) &&
    typeof step.args === "object"
  );
}

export function createTestModelFromEnvironment(): ScriptedModel | undefined {
  const raw = process.env.PLEX_TEST_MODEL_SCRIPT;
  if (!raw) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isTestStep)) {
    throw new Error("PLEX_TEST_MODEL_SCRIPT 格式不正确");
  }

  const steps: ScriptedModelInput[] = parsed.map((step) => {
    if (step.type === "message") {
      return [assistantMessage(step.text)];
    }
    return [
      functionCall(step.name, step.args, {
        callId: step.callId,
      }),
    ];
  });
  return new ScriptedModel(steps);
}
