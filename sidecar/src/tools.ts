import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tool } from "@openai/agents";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { PlexDatabase } from "./db.ts";
import type { SkillContext } from "./types.ts";
import {
  resolveReadPath,
  resolveWritePath,
  toWorkspaceRelative,
  WorkspaceViolationError,
} from "./paths.ts";

const MAX_TEXT_FILE_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 2_000_000;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_DEPTH = 12;

export interface WritePreview {
  targetPath: string;
  relativePath: string;
  existed: boolean;
  previousContent: string;
  nextContent: string;
  diff: string;
  hash: string;
  bytes: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  query: string;
  path: string;
  matches: SearchMatch[];
  truncated: boolean;
}

export interface TextFileResult {
  path: string;
  bytes: number;
  content: string;
}

export interface WriteResult {
  path: string;
  bytes: number;
  created: boolean;
  overwritten: boolean;
}

export interface TaskToolsRuntime {
  taskId: string;
  workspace: string;
  db: PlexDatabase;
  signal: AbortSignal;
  emit: (type: string, data: Record<string, unknown>) => void;
  pendingWrites: Map<string, WritePreview>;
  skills: SkillContext[];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function assertTextFile(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`目标不是文件：${path}`);
  }
  if (info.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(
      `文件超过 ${MAX_TEXT_FILE_BYTES} 字节的文本读取上限：${path}`,
    );
  }
  return info.size;
}

async function readUtf8TextFile(path: string): Promise<string> {
  await assertTextFile(path);
  const buffer = await readFile(path);
  if (buffer.includes(0)) {
    throw new Error(`文件看起来是二进制内容，暂不读取：${path}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`文件不是有效的 UTF-8 文本：${path}`);
  }
}

export async function listDirectory(
  workspace: string,
  requestedPath = ".",
): Promise<DirectoryListing> {
  const target = await resolveReadPath(workspace, requestedPath);
  const info = await stat(target);
  if (!info.isDirectory()) {
    throw new Error(`目标不是目录：${requestedPath}`);
  }

  const entries = await readdir(target, { withFileTypes: true });
  const mapped = entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map((entry): DirectoryEntry => {
      const absolute = join(target, entry.name);
      return {
        name: entry.name,
        path: toWorkspaceRelative(workspace, absolute),
        type: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
      };
    });

  return {
    path: toWorkspaceRelative(workspace, target),
    entries: mapped,
    truncated: entries.length > MAX_DIRECTORY_ENTRIES,
  };
}

async function* walkTextFiles(
  workspace: string,
  start: string,
  depth = 0,
): AsyncGenerator<string> {
  if (depth > MAX_SEARCH_DEPTH) {
    return;
  }
  const entries = await readdir(start, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const absolute = join(start, entry.name);
    if (entry.isDirectory()) {
      yield* walkTextFiles(workspace, absolute, depth + 1);
      continue;
    }
    if (entry.isFile()) {
      yield absolute;
    }
  }
}

export async function searchText(
  workspace: string,
  query: string,
  requestedPath = ".",
  maxResults = MAX_SEARCH_RESULTS,
): Promise<SearchResult> {
  if (query.length === 0) {
    throw new Error("搜索内容不能为空");
  }

  const start = await resolveReadPath(workspace, requestedPath);
  const info = await stat(start);
  if (!info.isDirectory()) {
    throw new Error(`搜索起点必须是目录：${requestedPath}`);
  }

  const limit = Math.min(Math.max(Math.trunc(maxResults), 1), 500);
  const needle = query.toLocaleLowerCase();
  const matches: Array<{
    path: string;
    line: number;
    text: string;
  }> = [];
  let truncated = false;

  for await (const file of walkTextFiles(workspace, start)) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = await readUtf8TextFile(file);
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.toLocaleLowerCase().includes(needle)) {
        matches.push({
          path: toWorkspaceRelative(workspace, file),
          line: index + 1,
          text: line.length > 300 ? `${line.slice(0, 300)}…` : line,
        });
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
    }
  }

  return { query, path: requestedPath, matches, truncated };
}

export async function readTextFile(
  workspace: string,
  requestedPath: string,
): Promise<TextFileResult> {
  const target = await resolveReadPath(workspace, requestedPath);
  const content = await readUtf8TextFile(target);
  return {
    path: toWorkspaceRelative(workspace, target),
    bytes: Buffer.byteLength(content, "utf8"),
    content,
  };
}

function normalizedSkillResourcePath(requestedPath: string): string {
  const normalized = requestedPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    isAbsolute(requestedPath) ||
    normalized.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Skill 资源路径必须是目录内的有效相对路径");
  }
  return normalized;
}

export async function readSkillResource(
  skills: SkillContext[],
  skillId: string,
  requestedPath: string,
): Promise<TextFileResult & { skillId: string }> {
  const skill = skills.find((item) => item.id === skillId);
  if (!skill || !skill.rootPath) {
    throw new Error("Skill 未启用或没有可读取的安装目录");
  }
  const resourcePath = normalizedSkillResourcePath(requestedPath);
  if (!skill.files.some((file) => file.path === resourcePath)) {
    throw new Error(`资源未登记在该 Skill 中：${resourcePath}`);
  }
  const root = await realpath(skill.rootPath);
  const target = await realpath(resolve(root, resourcePath));
  const relativePath = relative(root, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Skill 资源路径越出安装目录");
  }
  const content = await readUtf8TextFile(target);
  return {
    skillId,
    path: resourcePath,
    bytes: Buffer.byteLength(content, "utf8"),
    content,
  };
}

function hashWriteState(existed: boolean, content: string): string {
  return createHash("sha256")
    .update(existed ? "existing" : "missing")
    .update("\0")
    .update(content)
    .digest("hex");
}

async function readExistingContent(targetPath: string): Promise<{
  existed: boolean;
  content: string;
}> {
  try {
    const info = await stat(targetPath);
    if (!info.isFile()) {
      throw new Error(`写入目标不是文件：${targetPath}`);
    }
    return { existed: true, content: await readUtf8TextFile(targetPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { existed: false, content: "" };
    }
    throw error;
  }
}

export async function describeWrite(
  workspace: string,
  requestedPath: string,
  nextContent: string,
): Promise<WritePreview> {
  if (Buffer.byteLength(nextContent, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`写入内容超过 ${MAX_WRITE_BYTES} 字节上限`);
  }

  const targetPath = await resolveWritePath(workspace, requestedPath);
  const { existed, content: previousContent } =
    await readExistingContent(targetPath);
  const diff = createTwoFilesPatch(
    existed ? `a/${requestedPath}` : "/dev/null",
    `b/${requestedPath}`,
    previousContent,
    nextContent,
    existed ? "当前内容" : "新建文件",
    "批准后的内容",
    { context: 3 },
  );

  return {
    targetPath,
    relativePath: toWorkspaceRelative(workspace, targetPath),
    existed,
    previousContent,
    nextContent,
    diff,
    hash: hashWriteState(existed, previousContent),
    bytes: Buffer.byteLength(nextContent, "utf8"),
  };
}

export async function writeTextFileChecked(
  workspace: string,
  requestedPath: string,
  nextContent: string,
  expectedHash: string,
): Promise<WriteResult> {
  const preview = await describeWrite(workspace, requestedPath, nextContent);
  if (preview.hash !== expectedHash) {
    const error = new Error(
      "目标文件在审批期间发生了变化，本次写入已停止。请重新读取文件并再次申请审批。",
    );
    Object.assign(error, { code: "FILE_CHANGED_SINCE_APPROVAL" });
    throw error;
  }

  await Bun.write(preview.targetPath, nextContent);
  return {
    path: preview.relativePath,
    bytes: preview.bytes,
    created: !preview.existed,
    overwritten: preview.existed,
  };
}

async function withToolRecording(
  runtime: TaskToolsRuntime,
  name: string,
  callId: string,
  args: Record<string, unknown>,
  execute: () => Promise<unknown>,
): Promise<string> {
  if (runtime.signal.aborted) {
    throw new Error("任务已取消，未执行新的工具调用");
  }

  runtime.db.startToolCall(callId, runtime.taskId, name, args);
  runtime.emit("tool.started", { callId, name, args });

  try {
    const result = await execute();
    const output =
      typeof result === "string"
        ? result
        : JSON.stringify(result ?? null, null, 2);
    runtime.db.finishToolCall(callId, "completed", output, null);
    runtime.emit("tool.completed", { callId, name, output });
    return output;
  } catch (error) {
    const message = toErrorMessage(error);
    runtime.db.finishToolCall(callId, "failed", null, message);
    runtime.emit("tool.failed", { callId, name, error: message });
    throw error;
  }
}

export function createTaskTools(runtime: TaskToolsRuntime, includeWorkspaceTools = true) {
  const listDirectoryTool = tool({
    name: "list_directory",
    description:
      "列出授权工作目录内某个目录的直接子项。path 使用工作目录相对路径，省略时列出根目录。",
    parameters: z.object({
      path: z.string().optional().describe("工作目录内的相对路径"),
    }),
    async execute({ path }, _context, details) {
      const callId = details?.toolCall?.callId ?? crypto.randomUUID();
      const args = { path: path ?? "." };
      return withToolRecording(runtime, "list_directory", callId, args, () =>
        listDirectory(runtime.workspace, args.path),
      );
    },
  });

  const searchTextTool = tool({
    name: "search_text",
    description:
      "在授权工作目录内搜索文本。返回匹配的文件相对路径、行号和该行内容。",
    parameters: z.object({
      query: z.string().describe("要搜索的文本"),
      path: z.string().optional().describe("搜索起点，使用工作目录相对路径"),
      maxResults: z.number().int().positive().optional(),
    }),
    async execute({ query, path, maxResults }, _context, details) {
      const callId = details?.toolCall?.callId ?? crypto.randomUUID();
      const args = {
        query,
        path: path ?? ".",
        maxResults: maxResults ?? MAX_SEARCH_RESULTS,
      };
      return withToolRecording(runtime, "search_text", callId, args, () =>
        searchText(runtime.workspace, query, args.path, args.maxResults),
      );
    },
  });

  const readTextFileTool = tool({
    name: "read_text_file",
    description:
      "读取授权工作目录内的 UTF-8 文本文件。path 使用工作目录相对路径。",
    parameters: z.object({
      path: z.string().describe("文本文件的工作目录相对路径"),
    }),
    async execute({ path }, _context, details) {
      const callId = details?.toolCall?.callId ?? crypto.randomUUID();
      const args = { path };
      return withToolRecording(runtime, "read_text_file", callId, args, () =>
        readTextFile(runtime.workspace, path),
      );
    },
  });

  const writeTextFileTool = tool({
    name: "write_text_file",
    description:
      "在授权工作目录内创建或覆盖 UTF-8 文本文件。执行前必须经过用户审批；覆盖已有文件时先读取其当前内容。",
    parameters: z.object({
      path: z.string().describe("目标文件的工作目录相对路径"),
      content: z.string().describe("要写入的完整内容"),
    }),
    needsApproval: async (_context, input, callId) => {
      const key = callId ?? crypto.randomUUID();
      const preview = await describeWrite(
        runtime.workspace,
        input.path,
        input.content,
      );
      runtime.pendingWrites.set(key, preview);
      return true;
    },
    async execute({ path, content }, _context, details) {
      const callId = details?.toolCall?.callId ?? crypto.randomUUID();
      const preview = runtime.pendingWrites.get(callId);
      if (!preview) {
        throw new Error("缺少审批时的文件快照，已拒绝本次写入");
      }
      const args = { path, content, bytes: preview.bytes };
      return withToolRecording(runtime, "write_text_file", callId, args, () =>
        writeTextFileChecked(runtime.workspace, path, content, preview.hash),
      );
    },
  });

  const readSkillResourceTool = tool({
    name: "read_skill_resource",
    description:
      "按需读取已启用 Skill 目录中的 UTF-8 文本。先读取 Skill 索引给出的 entrypoint，再读取入口指令明确引用的相对资源；脚本资源仅作为文本读取。",
    parameters: z.object({
      skillId: z.string().describe("已启用 Skill 的 ID"),
      path: z.string().describe("Skill 目录内的资源相对路径"),
    }),
    async execute({ skillId, path }, _context, details) {
      const callId = details?.toolCall?.callId ?? crypto.randomUUID();
      const args = { skillId, path };
      return withToolRecording(runtime, "read_skill_resource", callId, args, () =>
        readSkillResource(runtime.skills, skillId, path),
      );
    },
  });

  const workspaceTools = [
    listDirectoryTool,
    searchTextTool,
    readTextFileTool,
    writeTextFileTool,
  ];
  return [
    ...(includeWorkspaceTools ? workspaceTools : []),
    ...(runtime.skills.some((skill) => skill.rootPath && skill.files.length > 0)
      ? [readSkillResourceTool]
      : []),
  ];
}

export { WorkspaceViolationError };
