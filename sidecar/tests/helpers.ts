import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlexDatabase } from "../src/db.ts";
import { TaskRunner } from "../src/agent.ts";
import type {
  ProtocolEvent,
  SidecarOutboundMessage,
  TaskRecord,
} from "../src/types.ts";
import type { Model } from "@openai/agents";

export interface TestHarness {
  root: string;
  workspace: string;
  db: PlexDatabase;
  runner: TaskRunner;
  messages: SidecarOutboundMessage[];
  waitForEvent: (
    predicate: (event: ProtocolEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<ProtocolEvent>;
  cleanup: () => Promise<void>;
}

export async function createHarness(
  model?: Model | ((task: TaskRecord) => string | Model),
): Promise<TestHarness> {
  const root = await mkdtemp(join(tmpdir(), "plex-test-"));
  const workspace = join(root, "workspace");
  await Bun.write(join(workspace, ".keep"), "");

  const db = new PlexDatabase(join(root, "plex.sqlite"));
  const messages: SidecarOutboundMessage[] = [];
  const waiters = new Set<{
    predicate: (event: ProtocolEvent) => boolean;
    resolve: (event: ProtocolEvent) => void;
  }>();

  const waitForEvent = (
    predicate: (event: ProtocolEvent) => boolean,
    timeoutMs = 5_000,
  ): Promise<ProtocolEvent> =>
    new Promise((resolve, reject) => {
      const existing = messages.find(
        (message): message is ProtocolEvent =>
          message.type === "event" && predicate(message),
      );
      if (existing) {
        resolve(existing);
        return;
      }
      const waiter = {
        predicate,
        resolve: (event: ProtocolEvent) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(event);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("等待 Sidecar 事件超时"));
      }, timeoutMs);
      waiters.add(waiter);
    });

  const runner = new TaskRunner({
    db,
    emitLine: (message) => {
      messages.push(message);
      if (message.type !== "event") {
        return;
      }
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiter.resolve(message);
        }
      }
    },
    createModel: model
      ? typeof model === "function"
        ? model
        : () => model
      : undefined,
  });

  return {
    root,
    workspace,
    db,
    runner,
    messages,
    waitForEvent,
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function waitForTaskDone(done: Promise<void>): Promise<void> {
  return done;
}
