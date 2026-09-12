import { afterEach, describe, expect, test } from "bun:test";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from "@openai/agents/testing";
import { join } from "node:path";
import type { ProtocolEvent, TaskDetail } from "../src/types.ts";
import { createHarness, type TestHarness } from "./helpers.ts";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

async function setup(
  model: ScriptedModel | ((task: { workspace: string }) => ScriptedModel),
): Promise<TestHarness> {
  const harness = await createHarness(model);
  harnesses.push(harness);
  await Bun.write(join(harness.workspace, "a.md"), "# Alpha\n待办：写概览");
  await Bun.write(join(harness.workspace, "b.md"), "# Beta\n待办：列清单");
  return harness;
}

function eventCallId(event: ProtocolEvent): string {
  const callId = event.event.data.callId;
  if (typeof callId !== "string") {
    throw new Error("事件缺少 callId");
  }
  return callId;
}

function currentDetail(harness: TestHarness, taskId: string): TaskDetail {
  return harness.runner.getTaskDetail(taskId);
}

describe("TaskRunner", () => {
  test("完成多步读取并在审批后写入 summary.md", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "list_directory",
          { path: "." },
          { callId: "call-list" },
        ),
      ],
      [
        functionCall(
          "read_text_file",
          { path: "a.md" },
          { callId: "call-a" },
        ),
      ],
      [
        functionCall(
          "read_text_file",
          { path: "b.md" },
          { callId: "call-b" },
        ),
      ],
      [
        functionCall(
          "write_text_file",
          {
            path: "summary.md",
            content: "# 项目概览\n\n- Alpha\n- Beta\n\n## 待办\n\n- 写概览\n- 列清单\n",
          },
          { callId: "call-write" },
        ),
      ],
      [assistantMessage("已生成 summary.md，包含项目概览和待办清单。")],
    ]);
    const harness = await setup(model);

    const started = await harness.runner.startTask({
      prompt: "阅读这个目录里的资料，整理一份项目概览和待办清单，写入 summary.md",
      workspace: harness.workspace,
    });
    const approval = await harness.waitForEvent(
      (event) => event.event.type === "approval.requested",
    );
    const callId = eventCallId(approval);
    const preview = approval.event.data.preview as Record<string, unknown>;
    expect(String(preview.diff)).toContain("+# 项目概览");
    expect(preview.existed).toBe(false);

    await harness.runner.approve(started.taskId, callId);
    await harness.waitForEvent(
      (event) =>
        event.event.type === "task.completed" &&
        event.event.taskId === started.taskId,
    );

    const written = await Bun.file(
      join(harness.workspace, "summary.md"),
    ).text();
    expect(written).toContain("# 项目概览");
    expect(written).toContain("- 写概览");

    const detail = currentDetail(harness, started.taskId);
    expect(detail.task.status).toBe("completed");
    expect(detail.task.finalOutput).toContain("已生成 summary.md");
    expect(detail.toolCalls.map((call) => call.name)).toEqual([
      "list_directory",
      "read_text_file",
      "read_text_file",
      "write_text_file",
    ]);
    expect(detail.toolCalls.every((call) => call.status === "completed")).toBe(
      true,
    );
    expect(detail.approvals[0]?.status).toBe("approved");
    model.assertComplete();
  });

  test("拒绝审批时保持文件不变", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "write_text_file",
          { path: "summary.md", content: "不应写入" },
          { callId: "call-write" },
        ),
      ],
      [assistantMessage("已拒绝写入，文件保持原状。")],
    ]);
    const harness = await setup(model);

    const started = await harness.runner.startTask({
      prompt: "写入 summary.md",
      workspace: harness.workspace,
    });
    const approval = await harness.waitForEvent(
      (event) => event.event.type === "approval.requested",
    );
    await harness.runner.reject(
      started.taskId,
      eventCallId(approval),
      "用户选择不写入",
    );
    await harness.waitForEvent(
      (event) => event.event.type === "task.completed",
    );

    expect(await Bun.file(join(harness.workspace, "summary.md")).exists()).toBe(
      false,
    );
    const detail = currentDetail(harness, started.taskId);
    expect(detail.approvals[0]?.status).toBe("rejected");
    expect(detail.task.finalOutput).toContain("已拒绝写入");
  });

  test("等待审批时取消，不会执行写入", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "write_text_file",
          { path: "summary.md", content: "不应写入" },
          { callId: "call-write" },
        ),
      ],
    ]);
    const harness = await setup(model);

    const started = await harness.runner.startTask({
      prompt: "写入 summary.md",
      workspace: harness.workspace,
    });
    await harness.waitForEvent(
      (event) => event.event.type === "approval.requested",
    );
    const cancelled = harness.runner.cancel(started.taskId);
    expect(cancelled).toBe(true);
    await harness.waitForEvent((event) => event.event.type === "task.cancelled");

    expect(await Bun.file(join(harness.workspace, "summary.md")).exists()).toBe(
      false,
    );
    const detail = currentDetail(harness, started.taskId);
    expect(detail.task.status).toBe("cancelled");
    expect(detail.approvals[0]?.status).toBe("cancelled");
  });

  test("审批期间文件变化时停止覆盖", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "write_text_file",
          { path: "notes.md", content: "agent content" },
          { callId: "call-write" },
        ),
      ],
      [assistantMessage("检测到文件已变化，本次没有覆盖。")],
    ]);
    const harness = await setup(model);
    await Bun.write(join(harness.workspace, "notes.md"), "original");

    const started = await harness.runner.startTask({
      prompt: "更新 notes.md",
      workspace: harness.workspace,
    });
    const approval = await harness.waitForEvent(
      (event) => event.event.type === "approval.requested",
    );
    await Bun.write(join(harness.workspace, "notes.md"), "external change");
    await harness.runner.approve(started.taskId, eventCallId(approval));
    await harness.waitForEvent(
      (event) => event.event.type === "task.completed",
    );

    expect(await Bun.file(join(harness.workspace, "notes.md")).text()).toBe(
      "external change",
    );
    const failedTool = harness.messages.find(
      (message) =>
        message.type === "event" && message.event.type === "tool.failed",
    );
    expect(failedTool).toBeTruthy();
  });

  test("工具层拒绝工作目录之外的读取", async () => {
    const harness = await setup(
      (task) =>
        new ScriptedModel([
          [
            functionCall(
              "list_directory",
              { path: join(task.workspace, "..", "outside") },
              { callId: "call-outside" },
            ),
          ],
          [assistantMessage("无法访问工作目录之外的位置。")],
        ]),
    );
    await Bun.write(join(harness.root, "outside", "secret.txt"), "secret");

    const started = await harness.runner.startTask({
      prompt: "列出外部目录",
      workspace: harness.workspace,
    });
    await harness.waitForEvent(
      (event) =>
        event.event.type === "task.completed" &&
        event.event.taskId === started.taskId,
    );

    const detail = currentDetail(harness, started.taskId);
    expect(detail.task.status).toBe("completed");
    expect(detail.toolCalls[0]?.status).toBe("failed");
    expect(detail.toolCalls[0]?.error).toContain("路径越出授权工作目录");
    expect(JSON.stringify(harness.messages)).not.toContain("secret");
  });
});
