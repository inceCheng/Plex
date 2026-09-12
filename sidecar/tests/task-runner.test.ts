import { afterEach, describe, expect, test } from "bun:test";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from "@openai/agents/testing";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProtocolEvent, SkillContext, TaskDetail } from "../src/types.ts";
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
  test("独立会话可以按需读取已启用 Skill 的登记资源", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "read_skill_resource",
          { skillId: "skill:test-skill", path: "references/guide.md" },
          { callId: "call-skill-resource" },
        ),
      ],
      [assistantMessage("已按 Skill 指引完成回答。")],
    ]);
    const harness = await createHarness(model);
    harnesses.push(harness);
    const skillRoot = join(harness.root, "skills", "test-skill");
    const content = "按参考资料中的格式整理结果。";
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await Bun.write(join(skillRoot, "references", "guide.md"), content);
    const skills: SkillContext[] = [{
      id: "skill:test-skill",
      name: "test-skill",
      description: "测试目录型 Skill",
      content: "---\nname: test-skill\ndescription: 测试目录型 Skill\n---\n读取 references/guide.md。",
      entrypoint: "SKILL.md",
      rootPath: skillRoot,
      files: [
        { path: "SKILL.md", bytes: 82, kind: "entrypoint" },
        { path: "references/guide.md", bytes: Buffer.byteLength(content), kind: "reference" },
      ],
      totalBytes: 82 + Buffer.byteLength(content),
    }];

    const started = await harness.runner.startTask({
      prompt: "请使用已启用的 Skill",
      projectId: null,
      skills,
    });
    await harness.waitForEvent(
      (event) => event.event.type === "task.completed" && event.event.taskId === started.taskId,
    );

    const detail = harness.runner.getTaskDetail(started.taskId);
    expect(detail.task.workspace).toBe("");
    expect(detail.toolCalls.map((call) => call.name)).toEqual(["read_skill_resource"]);
    expect(detail.toolCalls[0]?.output).toContain(content);
    model.assertComplete();
  });

  test("Skill 资源工具拒绝未登记路径和目录越界", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "read_skill_resource",
          { skillId: "skill:test-skill", path: "../secret.txt" },
          { callId: "call-skill-outside" },
        ),
      ],
      [assistantMessage("无法读取未授权资源。")],
    ]);
    const harness = await createHarness(model);
    harnesses.push(harness);
    const skillRoot = join(harness.root, "skills", "test-skill");
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await Bun.write(join(skillRoot, "references", "guide.md"), "guide");
    await Bun.write(join(harness.root, "secret.txt"), "secret-value");
    const skills: SkillContext[] = [{
      id: "skill:test-skill",
      name: "test-skill",
      description: "测试目录型 Skill",
      content: "---\nname: test-skill\ndescription: 测试目录型 Skill\n---\n",
      entrypoint: "SKILL.md",
      rootPath: skillRoot,
      files: [{ path: "references/guide.md", bytes: 5, kind: "reference" }],
      totalBytes: 5,
    }];

    const started = await harness.runner.startTask({
      prompt: "读取外部秘密",
      projectId: null,
      skills,
    });
    await harness.waitForEvent(
      (event) => event.event.type === "task.completed" && event.event.taskId === started.taskId,
    );

    const detail = harness.runner.getTaskDetail(started.taskId);
    expect(detail.toolCalls[0]?.status).toBe("failed");
    expect(detail.toolCalls[0]?.error).toContain("有效相对路径");
    expect(JSON.stringify(harness.messages)).not.toContain("secret-value");
    model.assertComplete();
  });

  test("独立会话完成普通回答且不会调用系统工具", async () => {
    const model = new ScriptedModel([[assistantMessage("这是独立会话的回答。")]]);
    const harness = await createHarness(model);
    harnesses.push(harness);

    const started = await harness.runner.startTask({
      prompt: "你好，请简单介绍一下自己",
      projectId: null,
    });
    await harness.waitForEvent(
      (event) => event.event.type === "task.completed" && event.event.taskId === started.taskId,
    );

    const detail = harness.runner.getTaskDetail(started.taskId);
    expect(detail.task.projectId).toBeNull();
    expect(detail.task.workspace).toBe("");
    expect(detail.toolCalls).toHaveLength(0);
    expect(detail.task.finalOutput).toContain("独立会话");
    model.assertComplete();
  });

  test("项目会话保存项目映射并使用项目工作目录", async () => {
    const model = new ScriptedModel([[assistantMessage("项目会话完成。")]]);
    const harness = await createHarness(model);
    harnesses.push(harness);
    const project = harness.db.createProject({
      id: crypto.randomUUID(),
      name: "测试项目",
      workspace: harness.workspace,
    });

    const started = await harness.runner.startTask({
      prompt: "总结项目",
      projectId: project.id,
    });
    await harness.waitForEvent(
      (event) => event.event.type === "task.completed" && event.event.taskId === started.taskId,
    );

    const detail = harness.runner.getTaskDetail(started.taskId);
    expect(detail.task.projectId).toBe(project.id);
    expect(detail.task.workspace).toEndWith("/workspace");
    model.assertComplete();
  });

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

  test("完成后可以继续多轮对话并复用上下文", async () => {
    const model = new ScriptedModel([
      [assistantMessage("第一轮已完成。")],
      [
        functionCall(
          "list_directory",
          { path: "." },
          { callId: "call-follow-up-list" },
        ),
      ],
      [assistantMessage("第二轮已完成，已读取当前目录。")],
    ]);
    const harness = await setup(model);

    const started = await harness.runner.startTask({
      prompt: "先记住 Alpha 项目",
      workspace: harness.workspace,
    });
    const firstCompleted = await harness.waitForEvent(
      (event) =>
        event.event.type === "task.completed" &&
        event.event.taskId === started.taskId,
    );

    await harness.runner.continueTask(
      started.taskId,
      "现在读取当前目录并总结刚才记住的内容",
    );
    const resumed = await harness.waitForEvent(
      (event) =>
        event.event.type === "task.started" &&
        event.event.taskId === started.taskId &&
        event.event.seq > firstCompleted.event.seq,
    );
    await harness.waitForEvent(
      (event) =>
        event.event.type === "task.completed" &&
        event.event.taskId === started.taskId &&
        event.event.seq > resumed.event.seq,
    );

    const detail = currentDetail(harness, started.taskId);
    expect(detail.task.status).toBe("completed");
    expect(detail.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "先记住 Alpha 项目"],
      ["assistant", "第一轮已完成。"],
      ["user", "现在读取当前目录并总结刚才记住的内容"],
      ["assistant", "第二轮已完成，已读取当前目录。"],
    ]);
    expect(detail.toolCalls.map((call) => call.name)).toEqual(["list_directory"]);
    expect(
      harness.messages.filter(
        (message) => message.type === "event" && message.event.type === "message.user",
      ),
    ).toHaveLength(1);
    model.assertComplete();
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
