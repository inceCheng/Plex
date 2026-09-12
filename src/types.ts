export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  workspace: string;
  model: string;
  status: TaskStatus;
  finalOutput: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMessage {
  id: number;
  taskId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface TaskEventRecord {
  taskId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ToolCallRecord {
  id: string;
  taskId: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: Record<string, unknown> | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TaskDetail {
  task: TaskRecord;
  messages: TaskMessage[];
  events: TaskEventRecord[];
  toolCalls: ToolCallRecord[];
  approvals: ApprovalRecord[];
}

export interface SidecarStatus {
  running: boolean;
  apiKeyConfigured: boolean;
  databasePath: string;
  sidecarCommand: string;
}

export interface ProtocolEvent {
  type: "event";
  event: TaskEventRecord;
}

export interface ProtocolResponse {
  type: "response";
  id?: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface ProtocolLog {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
}

export interface ProtocolStatus {
  type: "status";
  status: "ready";
  version: string;
}

export type SidecarMessage =
  | ProtocolEvent
  | ProtocolResponse
  | ProtocolLog
  | ProtocolStatus;
