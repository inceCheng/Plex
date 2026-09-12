import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
  ApprovalRecord,
  TaskDetail,
  TaskEventRecord,
  TaskMessage,
  TaskRecord,
  TaskStatus,
  ToolCallRecord,
} from "./types.ts";

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  workspace: string;
  model: string;
  provider_id: string | null;
  provider_name: string | null;
  reasoning_effort: string | null;
  status: TaskStatus;
  final_output: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  task_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

interface EventRow {
  task_id: string;
  seq: number;
  type: string;
  data_json: string;
  created_at: string;
}

interface ToolCallRow {
  id: string;
  task_id: string;
  name: string;
  args_json: string;
  status: "running" | "completed" | "failed";
  output: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface ApprovalRow {
  id: string;
  task_id: string;
  call_id: string;
  tool_name: string;
  args_json: string;
  preview_json: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface CountRow {
  count: number;
}

function now(): string {
  return new Date().toISOString();
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: value };
  }
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    workspace: row.workspace,
    model: row.model,
    providerId: row.provider_id,
    providerName: row.provider_name,
    reasoningEffort: row.reasoning_effort,
    status: row.status,
    finalOutput: row.final_output,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function mapEvent(row: EventRow): TaskEventRecord {
  return {
    taskId: row.task_id,
    seq: row.seq,
    type: row.type,
    data: parseJsonObject(row.data_json),
    createdAt: row.created_at,
  };
}

function mapToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    args: parseJsonObject(row.args_json),
    status: row.status,
    output: row.output,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    callId: row.call_id,
    toolName: row.tool_name,
    args: parseJsonObject(row.args_json),
    preview: row.preview_json ? parseJsonObject(row.preview_json) : null,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class PlexDatabase {
  readonly path: string;
  private readonly db: Database;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workspace TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_id TEXT,
        provider_name TEXT,
        reasoning_effort TEXT,
        status TEXT NOT NULL,
        final_output TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        preview_json TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (task_id, call_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_task_id ON messages(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id, created_at);
    `);

    this.ensureColumn("tasks", "provider_id", "TEXT");
    this.ensureColumn("tasks", "provider_name", "TEXT");
    this.ensureColumn("tasks", "reasoning_effort", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all();
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createTask(input: {
    id: string;
    title: string;
    prompt: string;
    workspace: string;
    model: string;
    providerId?: string | null;
    providerName?: string | null;
    reasoningEffort?: string | null;
  }): TaskRecord {
    const timestamp = now();
    this.db
      .query(
        `INSERT INTO tasks
          (id, title, prompt, workspace, model, provider_id, provider_name,
           reasoning_effort, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.prompt,
        input.workspace,
        input.model,
        input.providerId ?? null,
        input.providerName ?? null,
        input.reasoningEffort ?? null,
        timestamp,
        timestamp,
      );
    return this.getTask(input.id);
  }

  getTask(taskId: string): TaskRecord {
    const row = this.db
      .query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?")
      .get(taskId);
    if (!row) {
      throw new Error(`任务不存在：${taskId}`);
    }
    return mapTask(row);
  }

  listTasks(limit = 100): TaskRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    return this.db
      .query<TaskRow, [number]>(
        "SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?",
      )
      .all(safeLimit)
      .map(mapTask);
  }

  updateTask(
    taskId: string,
    patch: {
      status?: TaskStatus;
      finalOutput?: string | null;
      error?: string | null;
    },
  ): TaskRecord {
    const current = this.getTask(taskId);
    const status = patch.status ?? current.status;
    const finalOutput =
      patch.finalOutput === undefined ? current.finalOutput : patch.finalOutput;
    const error = patch.error === undefined ? current.error : patch.error;
    this.db
      .query(
        `UPDATE tasks
         SET status = ?, final_output = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, finalOutput, error, now(), taskId);
    return this.getTask(taskId);
  }

  addMessage(
    taskId: string,
    role: TaskMessage["role"],
    content: string,
  ): TaskMessage {
    const result = this.db
      .query(
        `INSERT INTO messages (task_id, role, content, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(taskId, role, content, now());
    const row = this.db
      .query<MessageRow, [number]>("SELECT * FROM messages WHERE id = ?")
      .get(Number(result.lastInsertRowid));
    if (!row) {
      throw new Error("消息写入失败");
    }
    return mapMessage(row);
  }

  appendEvent(
    taskId: string,
    type: string,
    data: Record<string, unknown>,
  ): TaskEventRecord {
    const row = this.db
      .query<{ seq: number | null }, [string]>(
        "SELECT MAX(seq) AS seq FROM events WHERE task_id = ?",
      )
      .get(taskId);
    const seq = (row?.seq ?? 0) + 1;
    const createdAt = now();
    this.db
      .query(
        `INSERT INTO events (task_id, seq, type, data_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId, seq, type, JSON.stringify(data), createdAt);
    return { taskId, seq, type, data, createdAt };
  }

  startToolCall(
    id: string,
    taskId: string,
    name: string,
    args: Record<string, unknown>,
  ): void {
    this.db
      .query(
        `INSERT INTO tool_calls
          (id, task_id, name, args_json, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'running',
           args_json = excluded.args_json,
           started_at = excluded.started_at,
           finished_at = NULL,
           output = NULL,
           error = NULL`,
      )
      .run(id, taskId, name, JSON.stringify(args), now());
  }

  finishToolCall(
    id: string,
    status: "completed" | "failed",
    output: string | null,
    error: string | null,
  ): void {
    this.db
      .query(
        `UPDATE tool_calls
         SET status = ?, output = ?, error = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(status, output, error, now(), id);
  }

  createApproval(input: {
    id: string;
    taskId: string;
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
    preview: Record<string, unknown> | null;
  }): ApprovalRecord {
    this.db
      .query(
        `INSERT INTO approvals
          (id, task_id, call_id, tool_name, args_json, preview_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(task_id, call_id) DO UPDATE SET
           tool_name = excluded.tool_name,
           args_json = excluded.args_json,
           preview_json = excluded.preview_json,
           status = 'pending',
           reason = NULL,
           resolved_at = NULL`,
      )
      .run(
        input.id,
        input.taskId,
        input.callId,
        input.toolName,
        JSON.stringify(input.args),
        input.preview ? JSON.stringify(input.preview) : null,
        now(),
      );
    return this.getApproval(input.taskId, input.callId);
  }

  getApproval(taskId: string, callId: string): ApprovalRecord {
    const row = this.db
      .query<ApprovalRow, [string, string]>(
        "SELECT * FROM approvals WHERE task_id = ? AND call_id = ?",
      )
      .get(taskId, callId);
    if (!row) {
      throw new Error(`审批记录不存在：${taskId}/${callId}`);
    }
    return mapApproval(row);
  }

  resolveApproval(
    taskId: string,
    callId: string,
    status: ApprovalRecord["status"],
    reason: string | null,
  ): void {
    this.db
      .query(
        `UPDATE approvals
         SET status = ?, reason = ?, resolved_at = ?
         WHERE task_id = ? AND call_id = ?`,
      )
      .run(status, reason, now(), taskId, callId);
  }

  markOpenApprovalsCancelled(taskId: string): void {
    this.db
      .query(
        `UPDATE approvals
         SET status = 'cancelled', reason = '任务已取消', resolved_at = ?
         WHERE task_id = ? AND status = 'pending'`,
      )
      .run(now(), taskId);
  }

  markUnfinishedTasksInterrupted(): number {
    const result = this.db
      .query(
        `UPDATE tasks
         SET status = 'interrupted', updated_at = ?
         WHERE status IN ('running', 'awaiting_approval', 'pending')`,
      )
      .run(now());
    return Number(result.changes);
  }

  countTasks(): number {
    const row = this.db
      .query<CountRow, []>("SELECT COUNT(*) AS count FROM tasks")
      .get();
    return row?.count ?? 0;
  }

  getTaskDetail(taskId: string): TaskDetail {
    const task = this.getTask(taskId);
    const messages = this.db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE task_id = ? ORDER BY id ASC",
      )
      .all(taskId)
      .map(mapMessage);
    const events = this.db
      .query<EventRow, [string]>(
        "SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC",
      )
      .all(taskId)
      .map(mapEvent);
    const toolCalls = this.db
      .query<ToolCallRow, [string]>(
        "SELECT * FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC",
      )
      .all(taskId)
      .map(mapToolCall);
    const approvals = this.db
      .query<ApprovalRow, [string]>(
        "SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC",
      )
      .all(taskId)
      .map(mapApproval);

    return { task, messages, events, toolCalls, approvals };
  }
}
