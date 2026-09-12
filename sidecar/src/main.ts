import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import {
  TaskRunner,
  TaskFailureError,
  type ProviderRuntimeConfig,
} from "./agent.ts";
import { PlexDatabase } from "./db.ts";
import type {
  ProtocolResponse,
  SidecarOutboundMessage,
  SkillContext,
} from "./types.ts";
import { resolveWorkspace } from "./paths.ts";

const VERSION = "0.1.0";
const MAX_SKILL_COUNT = 32;
const MAX_SKILL_TOTAL_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILL_DIRECTORY_BYTES = 50 * 1024 * 1024;
const MAX_SKILL_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_FILE_COUNT = 512;

function parseSkillResourcePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) return null;
  return normalized;
}

function writeLine(message: SidecarOutboundMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(level: "info" | "warn" | "error", message: string): void {
  writeLine({ type: "log", level, message });
}

function response(
  id: string | undefined,
  payload?: unknown,
): ProtocolResponse {
  return { type: "response", id, ok: true, payload };
}

function errorResponse(
  id: string | undefined,
  code: string,
  message: string,
): ProtocolResponse {
  return { type: "response", id, ok: false, error: { code, message } };
}

function requireString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TaskFailureError(
      "INVALID_ARGUMENT",
      `缺少有效参数：${key}`,
    );
  }
  return value.trim();
}

function optionalString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TaskFailureError(
      "INVALID_ARGUMENT",
      `参数类型错误：${key}`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSkills(value: unknown): SkillContext[] {
  if (!Array.isArray(value)) return [];
  const skills = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const skill = item as Record<string, unknown>;
    if (
      typeof skill.id !== "string" ||
      typeof skill.name !== "string" ||
      typeof skill.content !== "string" ||
      skill.id.trim().length === 0 ||
      skill.name.trim().length === 0 ||
      skill.content.trim().length === 0 ||
      new TextEncoder().encode(skill.content).byteLength > MAX_SKILL_BYTES
    ) return [];
    const entrypoint = parseSkillResourcePath(skill.entrypoint) ?? "SKILL.md";
    const rootPath = typeof skill.rootPath === "string" && isAbsolute(skill.rootPath)
      ? skill.rootPath
      : null;
    const files = Array.isArray(skill.files)
      ? skill.files.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const file = value as Record<string, unknown>;
          const path = parseSkillResourcePath(file.path);
          const bytes = typeof file.bytes === "number" && Number.isSafeInteger(file.bytes) && file.bytes >= 0
            ? file.bytes
            : -1;
          const kind = typeof file.kind === "string" && ["entrypoint", "agent", "script", "reference", "asset", "resource"].includes(file.kind)
            ? file.kind as SkillContext["files"][number]["kind"]
            : "resource";
          return path && bytes >= 0 && bytes <= MAX_SKILL_RESOURCE_BYTES
            ? [{ path, bytes, kind }]
            : [];
        })
      : [];
    const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    if (files.length > MAX_SKILL_FILE_COUNT || totalBytes > MAX_SKILL_DIRECTORY_BYTES) return [];
    return [{
      id: skill.id,
      name: skill.name,
      description: typeof skill.description === "string" ? skill.description : "",
      content: skill.content,
      entrypoint,
      rootPath,
      files,
      totalBytes,
    }];
  });
  const totalBytes = skills.reduce((total, skill) => total + new TextEncoder().encode(skill.content).byteLength, 0);
  return skills.length <= MAX_SKILL_COUNT && totalBytes <= MAX_SKILL_TOTAL_BYTES ? skills : [];
}

function parseProvider(
  payload: Record<string, unknown>,
): ProviderRuntimeConfig | undefined {
  const value = payload.provider;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TaskFailureError(
      "INVALID_ARGUMENT",
      "provider 参数必须是对象",
    );
  }
  const provider = value as Record<string, unknown>;
  const apiStyle =
    provider.apiStyle === "responses" ? "responses" : "chat_completions";
  return {
    id: requireString(provider, "id"),
    name: requireString(provider, "name"),
    baseUrl: requireString(provider, "baseUrl"),
    apiStyle,
    modelId: requireString(provider, "modelId"),
    reasoningEffort: optionalString(provider, "reasoningEffort") ?? null,
    apiKey: optionalString(provider, "apiKey") ?? "",
  };
}

const dbPath =
  process.env.PLEX_DB_PATH ?? join(process.cwd(), "data", "plex.sqlite");
const db = new PlexDatabase(dbPath);
const interruptedCount = db.markUnfinishedTasksInterrupted();
if (interruptedCount > 0) {
  log(
    "warn",
    `Sidecar 启动时将 ${interruptedCount} 个未完成任务标记为 interrupted`,
  );
}

const runner = new TaskRunner({
  db,
  emitLine: writeLine,
});

async function handleRequest(
  request: Record<string, unknown>,
): Promise<ProtocolResponse> {
  const id = typeof request.id === "string" ? request.id : undefined;
  const type = typeof request.type === "string" ? request.type : "";
  const payload =
    request.payload &&
    typeof request.payload === "object" &&
    !Array.isArray(request.payload)
      ? (request.payload as Record<string, unknown>)
      : {};

  switch (type) {
    case "ping":
      return response(id, {
        version: VERSION,
        database: db.path,
        taskCount: db.countTasks(),
      });
    case "start_task": {
      const prompt = requireString(payload, "prompt");
      const workspaceInput = optionalString(payload, "workspace");
      const projectId = payload.projectId === null ? null : optionalString(payload, "projectId");
      const model = optionalString(payload, "model");
      const provider = parseProvider(payload);
      const skills = parseSkills(payload.skills);
      const started = await runner.startTask({
        prompt,
        workspace: workspaceInput,
        projectId,
        model,
        provider,
        skills,
      });
      void started.done.catch((error: unknown) => {
        log(
          "error",
          `任务 ${started.taskId} 执行失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return response(id, { taskId: started.taskId });
    }
    case "create_project": {
      const name = requireString(payload, "name");
      const workspace = await resolveWorkspace(requireString(payload, "workspace"));
      const project = db.createProject({ id: crypto.randomUUID(), name, workspace });
      return response(id, project);
    }
    case "list_projects":
      return response(id, { projects: db.listProjects() });
    case "get_project": {
      const projectId = requireString(payload, "projectId");
      return response(id, db.getProject(projectId));
    }
    case "delete_project": {
      const projectId = requireString(payload, "projectId");
      db.deleteProject(projectId);
      return response(id, { projectId });
    }
    case "continue_task": {
      const taskId = requireString(payload, "taskId");
      const prompt = requireString(payload, "prompt");
      runner.continueTask(taskId, prompt, parseSkills(payload.skills));
      return response(id, { taskId });
    }
    case "approve": {
      const taskId = requireString(payload, "taskId");
      const callId = requireString(payload, "callId");
      const reason = optionalString(payload, "reason");
      void runner.approve(taskId, callId, reason).catch((error: unknown) => {
        log(
          "error",
          `审批恢复失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return response(id, { taskId, callId });
    }
    case "reject": {
      const taskId = requireString(payload, "taskId");
      const callId = requireString(payload, "callId");
      const reason = optionalString(payload, "reason");
      void runner.reject(taskId, callId, reason).catch((error: unknown) => {
        log(
          "error",
          `拒绝处理失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return response(id, { taskId, callId });
    }
    case "cancel": {
      const taskId = requireString(payload, "taskId");
      const cancelled = runner.cancel(taskId);
      return response(id, { taskId, cancelled });
    }
    case "list_tasks": {
      const limitValue = payload.limit;
      const limit =
        typeof limitValue === "number" && Number.isFinite(limitValue)
          ? limitValue
          : undefined;
      return response(id, { tasks: runner.listTasks(limit) });
    }
    case "get_task": {
      const taskId = requireString(payload, "taskId");
      return response(id, runner.getTaskDetail(taskId));
    }
    case "shutdown":
      setTimeout(() => process.exit(0), 10);
      return response(id, { shuttingDown: true });
    default:
      return errorResponse(
        id,
        "UNKNOWN_COMMAND",
        `未知的 Sidecar 命令：${type || "(empty)"}`,
      );
  }
}

const readline = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

readline.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    writeLine(errorResponse(undefined, "INVALID_JSON", "请求不是合法 JSON"));
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    writeLine(errorResponse(undefined, "INVALID_REQUEST", "请求必须是对象"));
    return;
  }

  void handleRequest(parsed as Record<string, unknown>)
    .then((result) => writeLine(result))
    .catch((error: unknown) => {
      const code =
        error instanceof TaskFailureError ? error.code : "REQUEST_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      writeLine(errorResponse((parsed as { id?: string }).id, code, message));
    });
});

readline.on("close", () => {
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

writeLine({ type: "status", status: "ready", version: VERSION });
log("info", `Plex Sidecar 已启动，数据库：${db.path}`);
