import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolClient } from "./protocol-client.ts";

function hostTriple(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") {
    return `${arch}-apple-darwin`;
  }
  if (process.platform === "linux") {
    return `${arch}-unknown-linux-gnu`;
  }
  return `${arch}-pc-windows-msvc`;
}

const projectRoot = join(import.meta.dir, "..", "..");
const binaryPath = join(
  projectRoot,
  "src-tauri",
  "binaries",
  `plex-agent-${hostTriple()}`,
);

describe("compiled sidecar acceptance", () => {
  test.skipIf(!existsSync(binaryPath))(
    "通过编译后的 Sidecar 完成读取、审批和写入",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "plex-binary-"));
      const workspacePath = join(root, "workspace");
      await Bun.write(join(workspacePath, "a.md"), "# Alpha\n待办：写概览");
      await Bun.write(join(workspacePath, "b.md"), "# Beta\n待办：列清单");

      const script = [
        {
          type: "tool",
          name: "list_directory",
          args: { path: "." },
          callId: "call-list",
        },
        {
          type: "tool",
          name: "read_text_file",
          args: { path: "a.md" },
          callId: "call-a",
        },
        {
          type: "tool",
          name: "read_text_file",
          args: { path: "b.md" },
          callId: "call-b",
        },
        {
          type: "tool",
          name: "write_text_file",
          args: {
            path: "summary.md",
            content:
              "# 项目概览\n\n- Alpha\n- Beta\n\n## 待办\n\n- 写概览\n- 列清单\n",
          },
          callId: "call-write",
        },
        {
          type: "message",
          text: "已生成 summary.md，包含项目概览和待办清单。",
        },
      ];

      const client = new ProtocolClient([binaryPath], projectRoot, {
        ...process.env,
        PLEX_DB_PATH: join(root, "plex.sqlite"),
        OPENAI_API_KEY: "",
        PLEX_TEST_MODEL_SCRIPT: JSON.stringify(script),
      });

      try {
        await client.waitFor(
          (message) => message.type === "status" && message.status === "ready",
        );
        client.send({
          id: "start-1",
          type: "start_task",
          payload: {
            prompt:
              "阅读这个目录里的资料，整理一份项目概览和待办清单，写入 summary.md",
            workspace: workspacePath,
          },
        });
        const start = await client.waitFor(
          (message) => message.id === "start-1",
        );
        const taskId = String(start.payload?.taskId ?? "");

        const approval = await client.waitFor(
          (message) =>
            message.type === "event" &&
            message.event?.type === "approval.requested" &&
            message.event.taskId === taskId,
        );
        const preview = approval.event?.data.preview as
          | Record<string, unknown>
          | undefined;
        expect(String(preview?.diff)).toContain("+# 项目概览");

        client.send({
          id: "approve-1",
          type: "approve",
          payload: {
            taskId,
            callId: String(approval.event?.data.callId ?? ""),
          },
        });
        await client.waitFor(
          (message) =>
            message.type === "event" &&
            message.event?.type === "task.completed" &&
            message.event.taskId === taskId,
        );

        const summary = await Bun.file(
          join(workspacePath, "summary.md"),
        ).text();
        expect(summary).toContain("# 项目概览");
        expect(summary).toContain("- 列清单");

        client.send({
          id: "detail-1",
          type: "get_task",
          payload: { taskId },
        });
        const detail = await client.waitFor(
          (message) => message.id === "detail-1",
        );
        const task = detail.payload?.task as { status: string } | undefined;
        expect(task?.status).toBe("completed");
      } finally {
        await client.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
