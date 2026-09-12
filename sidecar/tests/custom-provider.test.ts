import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHarness, type TestHarness } from "./helpers.ts";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
): string {
  return sseChunk({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

describe("custom OpenAI-compatible provider", () => {
  test("通过自定义 URL 调用模型并完成工具审批", async () => {
    let modelCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [
              { id: "mock-model", object: "model", owned_by: "plex-test" },
            ],
          });
        }
        if (
          request.method === "POST" &&
          url.pathname === "/v1/chat/completions"
        ) {
          const body = (await request.json()) as {
            messages?: Array<{ role?: string }>;
          };
          const hasToolResult = (body.messages ?? []).some(
            (message) => message.role === "tool",
          );
          modelCalls += 1;
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const write = (value: string) => {
                controller.enqueue(encoder.encode(value));
              };
              if (!hasToolResult) {
                write(
                  chatChunk(
                    {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-write",
                          type: "function",
                          function: {
                            name: "write_text_file",
                            arguments: "",
                          },
                        },
                      ],
                    },
                    null,
                  ),
                );
                write(
                  chatChunk(
                    {
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            arguments: JSON.stringify({
                              path: "summary.md",
                              content: "# 自定义供应商\n\n已完成写入。\n",
                            }),
                          },
                        },
                      ],
                    },
                    null,
                  ),
                );
                write(chatChunk({}, "tool_calls"));
              } else {
                write(chatChunk({ role: "assistant", content: "已生成 " }, null));
                write(chatChunk({ content: "summary.md" }, null));
                write(chatChunk({}, "stop"));
              }
              write("data: [DONE]\n\n");
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const harness = await createHarness();
    harnesses.push(harness);
    await Bun.write(join(harness.workspace, "a.md"), "# Alpha");

    const started = await harness.runner.startTask({
      prompt: "整理资料并写入 summary.md",
      workspace: harness.workspace,
      provider: {
        id: "custom:test",
        name: "Local Test Gateway",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiStyle: "chat_completions",
        modelId: "mock-model",
        reasoningEffort: "high",
        apiKey: "test-key",
      },
    });

    const approval = await harness.waitForEvent(
      (event) => event.event.type === "approval.requested",
    );
    const callId = String(approval.event.data.callId ?? "");
    await harness.runner.approve(started.taskId, callId);
    await harness.waitForEvent(
      (event) =>
        event.event.type === "task.completed" &&
        event.event.taskId === started.taskId,
    );

    const written = await Bun.file(
      join(harness.workspace, "summary.md"),
    ).text();
    expect(written).toContain("# 自定义供应商");
    expect(modelCalls).toBe(2);

    const detail = harness.runner.getTaskDetail(started.taskId);
    expect(detail.task.providerId).toBe("custom:test");
    expect(detail.task.providerName).toBe("Local Test Gateway");
    expect(detail.task.reasoningEffort).toBe("high");
    expect(detail.task.status).toBe("completed");

    server.stop(true);
  });
});
