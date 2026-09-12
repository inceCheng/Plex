import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolClient } from "./protocol-client.ts";

describe("sidecar protocol", () => {
  test("启动、执行失败回执、历史查询与关闭", async () => {
    const root = await mkdtemp(join(tmpdir(), "plex-protocol-"));
    const projectRoot = join(import.meta.dir, "..", "..");
    const client = new ProtocolClient(
      ["bun", "run", join(projectRoot, "sidecar", "src", "main.ts")],
      projectRoot,
      {
        ...process.env,
        PLEX_DB_PATH: join(root, "plex.sqlite"),
        OPENAI_API_KEY: "",
      },
    );
    try {
      await client.waitFor(
        (message) => message.type === "status" && message.status === "ready",
      );

      client.send({ id: "ping-1", type: "ping" });
      const ping = await client.waitFor((message) => message.id === "ping-1");
      expect(ping.ok).toBe(true);

      const workspacePath = join(root, "workspace");
      await Bun.write(join(workspacePath, "a.md"), "# Alpha");
      client.send({
        id: "start-1",
        type: "start_task",
        payload: {
          prompt: "整理项目概览",
          workspace: workspacePath,
        },
      });
      const start = await client.waitFor((message) => message.id === "start-1");
      expect(start.ok).toBe(true);
      const taskId = String(start.payload?.taskId ?? "");
      expect(taskId.length).toBeGreaterThan(0);

      const failed = await client.waitFor(
        (message) =>
          message.type === "event" &&
          message.event?.type === "task.failed" &&
          message.event.taskId === taskId,
      );
      expect(failed.event?.data.code).toBe("MISSING_API_KEY");

      client.send({ id: "list-1", type: "list_tasks" });
      const list = await client.waitFor((message) => message.id === "list-1");
      const tasks = list.payload?.tasks as Array<{ id: string }>;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe(taskId);

      client.send({
        id: "detail-1",
        type: "get_task",
        payload: { taskId },
      });
      const detail = await client.waitFor(
        (message) => message.id === "detail-1",
      );
      const messages = detail.payload?.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages[0]).toMatchObject({
        role: "user",
        content: "整理项目概览",
      });
    } finally {
      await client.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
