import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { marked } from "marked";
import { AnimatePresence, motion } from "motion/react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  useExternalStoreRuntime,
  useToolCallElapsed,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ThreadMessageLike,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { sidecar } from "./api";
import {
  customProvidersToCatalog,
  defaultEffort,
  findModel,
  findProvider,
  normalizeCatalog,
  sortProviders,
  type CatalogProvider,
  type CustomProviderConfig,
} from "./catalog";
import {
  ModelPicker,
  type ModelSelection,
} from "./components/ModelPicker";
import {
  ProviderSettings,
  type ProviderKeyState,
} from "./components/ProviderSettings";
import { resolveTheme, type Theme } from "./theme";
import type {
  SidecarStatus,
  TaskDetail,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
  ProjectRecord,
  SkillRecord,
} from "./types";
import "./App.css";

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "等待",
  running: "执行中",
  awaiting_approval: "待审批",
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  interrupted: "中断",
};

type TimelineItem =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "assistant"; text: string; streaming?: boolean }
  | { key: string; kind: "thinking" }
  | {
      key: string;
      kind: "tool";
      callId: string;
      name: string;
      args: Record<string, unknown>;
      status: "running" | "completed" | "failed";
      output: string | null;
      error: string | null;
      approval?: {
        preview: Record<string, unknown> | null;
        status: "pending" | "approved" | "rejected" | "cancelled";
        reason: string | null;
      };
    }
  | {
      key: string;
      kind: "approval";
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      preview: Record<string, unknown> | null;
      status: "pending" | "approved" | "rejected" | "cancelled";
      reason: string | null;
    }
  | { key: string; kind: "error"; text: string; code: string | null }
  | { key: string; kind: "notice"; text: string };

function buildTimeline(
  task: TaskRecord | undefined,
  events: TaskEventRecord[],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let streamingIndex = -1;
  let streamedText = false;
  let userPromptShown = false;

  const dismissThinking = () => {
    const last = items.at(-1);
    if (last?.kind === "thinking") {
      items.pop();
    }
  };

  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case "task.created": {
        const prompt =
          typeof task?.prompt === "string"
            ? task.prompt
            : String(data.prompt ?? "");
        if (!userPromptShown && prompt.length > 0) {
          items.push({ key: `user-${event.seq}`, kind: "user", text: prompt });
          userPromptShown = true;
        }
        break;
      }
      case "message.delta": {
        dismissThinking();
        const activeItem =
          streamingIndex >= 0 ? items[streamingIndex] : undefined;
        if (
          activeItem?.kind !== "assistant" ||
          !activeItem.streaming
        ) {
          streamingIndex = items.length;
          items.push({
            key: `assistant-streaming-${event.seq}`,
            kind: "assistant",
            text: "",
            streaming: true,
          });
        }
        const item = items[streamingIndex];
        if (item?.kind === "assistant") {
          item.text += String(data.text ?? "");
          streamedText = true;
        }
        break;
      }
      case "message.user":
        items.push({ key: `user-${event.seq}`, kind: "user", text: String(data.text ?? "") });
        break;
      case "task.started":
        items.push({ key: `thinking-${event.seq}`, kind: "thinking" });
        break;
      case "message.completed": {
        dismissThinking();
        const text = String(data.text ?? task?.finalOutput ?? "");
        const item = streamingIndex >= 0 ? items[streamingIndex] : undefined;
        if (item?.kind === "assistant" && item.streaming) {
          if (item.text.length === 0) {
            item.text = text;
          }
          delete item.streaming;
        } else if (!streamedText) {
          items.push({
            key: `assistant-${event.seq}`,
            kind: "assistant",
            text,
          });
        }
        streamingIndex = -1;
        streamedText = false;
        break;
      }
      case "tool.started": {
        dismissThinking();
        if (streamingIndex >= 0) {
          const item = items[streamingIndex];
          if (item?.kind === "assistant") {
            delete item.streaming;
          }
          streamingIndex = -1;
        }
        const callId = String(data.callId ?? event.seq);
        items.push({
          key: `tool-${callId}-${event.seq}`,
          kind: "tool",
          callId,
          name: String(data.name ?? "tool"),
          args:
            data.args && typeof data.args === "object"
              ? (data.args as Record<string, unknown>)
              : {},
          status: "running",
          output: null,
          error: null,
        });
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        const callId = String(data.callId ?? event.seq);
        const item = items.find(
          (candidate): candidate is Extract<TimelineItem, { kind: "tool" }> =>
            candidate.kind === "tool" && candidate.callId === callId,
        );
        if (item) {
          item.status = event.type === "tool.completed" ? "completed" : "failed";
          item.output = typeof data.output === "string" ? data.output : null;
          item.error = typeof data.error === "string" ? data.error : null;
        }
        break;
      }
      case "approval.requested": {
        dismissThinking();
        if (streamingIndex >= 0) {
          const item = items[streamingIndex];
          if (item?.kind === "assistant") {
            delete item.streaming;
          }
          streamingIndex = -1;
        }
        const callId = String(data.callId ?? event.seq);
        const existingTool = items.find(
          (candidate): candidate is Extract<TimelineItem, { kind: "tool" }> =>
            candidate.kind === "tool" && candidate.callId === callId,
        );
        if (existingTool) {
          existingTool.approval = {
            preview:
              data.preview && typeof data.preview === "object"
                ? (data.preview as Record<string, unknown>)
                : null,
            status: "pending",
            reason: null,
          };
          break;
        }
        items.push({
          key: `approval-${callId}`,
          kind: "approval",
          callId,
          toolName: String(data.toolName ?? "tool"),
          args:
            data.args && typeof data.args === "object"
              ? (data.args as Record<string, unknown>)
              : {},
          preview:
            data.preview && typeof data.preview === "object"
              ? (data.preview as Record<string, unknown>)
              : null,
          status: "pending",
          reason: null,
        });
        break;
      }
      case "approval.resolved": {
        const callId = String(data.callId ?? "");
        const item = items.find(
          (candidate): candidate is Extract<
            TimelineItem,
            { kind: "approval" }
          > => candidate.kind === "approval" && candidate.callId === callId,
        );
        const tool = items.find(
          (candidate): candidate is Extract<TimelineItem, { kind: "tool" }> =>
            candidate.kind === "tool" && candidate.callId === callId,
        );
        if (item) {
          item.status = data.approved === true ? "approved" : "rejected";
          item.reason = typeof data.reason === "string" ? data.reason : null;
        }
        if (tool?.approval) {
          tool.approval.status = data.approved === true ? "approved" : "rejected";
          tool.approval.reason = typeof data.reason === "string" ? data.reason : null;
        }
        break;
      }
      case "task.failed":
        dismissThinking();
        items.push({
          key: `failed-${event.seq}`,
          kind: "error",
          text: String(data.error ?? "任务执行失败"),
          code: typeof data.code === "string" ? data.code : null,
        });
        break;
      case "task.cancelled":
        dismissThinking();
        items.push({
          key: `cancelled-${event.seq}`,
          kind: "notice",
          text: "任务已取消，后续工具调用不会执行。",
        });
        break;
      default:
        break;
    }
  }

  return items;
}

function MarkdownContent(props: { text: string; streaming?: boolean }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(
        String(marked.parse(props.text, { gfm: true, breaks: true })),
      ),
    [props.text],
  );
  return (
    <div className="markdown-body">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {props.streaming ? <span className="cursor">▍</span> : null}
    </div>
  );
}

function AssistantMarkdownPart(props: TextMessagePartProps) {
  return (
    <div
      className={`assistant-answer ${
        props.status.type === "incomplete" ? "is-error" : ""
      }`}
    >
      <MarkdownContent
        text={props.text}
        streaming={props.status.type === "running"}
      />
    </div>
  );
}

function ThinkingPart(props: ReasoningMessagePartProps) {
  const running = props.status.type === "running";
  return (
    <motion.div
      className="assistant-thinking"
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      aria-live="polite"
    >
      <span className={running ? "thinking-indicator is-running" : "thinking-indicator"}>
        <i />
        <i />
        <i />
      </span>
      <span>{props.text}</span>
    </motion.div>
  );
}

function formatToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolCallSummary(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): string | null {
  const path = typeof args.path === "string" ? args.path : null;
  const query = typeof args.query === "string" ? args.query : null;
  const displayPath = path?.split("/").filter(Boolean).at(-1) ?? path;

  if (query) return query;
  if (displayPath) return displayPath;
  if (toolName === "list_directory") return "读取目录内容";
  if (toolName === "search_text") return "搜索文件内容";
  if (toolName === "read_text_file") return "读取文件";
  if (toolName === "write_text_file") return "写入文件";
  if (typeof result === "string" && result.trim()) {
    return result.trim().replace(/\s+/g, " ").slice(0, 72);
  }
  return null;
}

function ToolCallGroup(props: {
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <motion.div
      className="assistant-tool-group"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span>{props.count} 项工具调用</span>
          <span className="tool-group-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div className="assistant-tool-list">{props.children}</div>
      </details>
    </motion.div>
  );
}

function ToolCallPart(props: ToolCallMessagePartProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const elapsed = useToolCallElapsed();
  const pendingApproval =
    props.approval &&
    props.approval.approved === undefined &&
    props.approval.resolution === undefined;
  const running = props.status.type === "running";
  const failed = props.isError === true || props.status.type === "incomplete";
  const [open, setOpen] = useState(Boolean(pendingApproval));

  useEffect(() => {
    if (pendingApproval) setOpen(true);
  }, [pendingApproval]);

  const stateLabel = pendingApproval
    ? "等待批准"
    : running
      ? "执行中"
      : failed
        ? "失败"
        : props.approval?.approved === true
          ? "已批准"
          : props.approval?.approved === false
            ? "已拒绝"
            : "完成";
  const result = formatToolResult(props.result);
  const summary = toolCallSummary(props.toolName, props.args, props.result);
  const diff =
    props.approval &&
    props.args &&
    typeof props.args === "object" &&
    "preview" in props.args &&
    props.args.preview &&
    typeof props.args.preview === "object" &&
    "diff" in props.args.preview &&
    typeof props.args.preview.diff === "string"
      ? props.args.preview.diff
      : null;

  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      await props.respondToApproval({ approved, reason: reason.trim() || undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      className={`assistant-tool ${
        pendingApproval ? "is-approval" : ""
      } ${running ? "is-running" : ""} ${failed ? "is-failed" : ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="tool-summary-main">
            <span className={`tool-state-dot ${running ? "is-running" : ""}`} />
            <code>{props.toolName}</code>
            {summary ? <span className="tool-call-summary">{summary}</span> : null}
          </span>
          <span className="tool-summary-meta">
            {elapsed !== undefined ? `${Math.max(1, Math.round(elapsed / 100) / 10)} 秒` : null}
            <span className="tool-status">{stateLabel}</span>
          </span>
        </summary>
        <div className="assistant-tool-content">
        {pendingApproval ? (
          <div className="tool-approval">
            <p>{props.approval?.prompt ?? "此操作会修改本机文件。请查看内容后确认。"}</p>
            {diff ? <pre className="diff-view">{diff}</pre> : null}
            <div className="tool-section">
              <span className="label">参数</span>
              <pre>{JSON.stringify(props.args, null, 2)}</pre>
            </div>
            <footer className="approval-actions">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="拒绝原因（可选）"
              />
              <button
                className="ghost danger-text"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void decide(false);
                }}
              >
                拒绝
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void decide(true);
                }}
              >
                批准并执行
              </button>
            </footer>
          </div>
        ) : (
          <>
            {props.approval?.approved === false && props.approval.reason ? (
              <div className="tool-section">
                <span className="label">拒绝原因</span>
                <p className="tool-rejection-reason">{props.approval.reason}</p>
              </div>
            ) : null}
            <div className="tool-section">
              <span className="label">参数</span>
              <pre>{JSON.stringify(props.args, null, 2)}</pre>
            </div>
            {result ? (
              <div className="tool-section">
                <span className="label">{failed ? "错误" : "结果"}</span>
                <pre className={failed ? "error-text" : undefined}>{result}</pre>
              </div>
            ) : null}
          </>
        )}
        </div>
      </details>
    </motion.div>
  );
}

function UserTextPart(props: TextMessagePartProps) {
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [collapsible, setCollapsible] = useState(false);
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const bubble = element.closest<HTMLElement>(".user-message-bubble");
    const message = bubble?.closest<HTMLElement>(".aui-message-user");

    const measure = () => {
      const styles = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (context) {
        context.font = `${styles.fontStyle} ${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
        const letterSpacing = Number.parseFloat(styles.letterSpacing) || 0;
        const visibleLines = props.text.split(/\r?\n/).slice(0, 6);
        const longestLine = visibleLines.reduce((longest, line) => {
          const width = context.measureText(line || " ").width + Math.max(0, Array.from(line).length - 1) * letterSpacing;
          return Math.max(longest, width);
        }, 0);
        const padding = bubble
          ? Number.parseFloat(getComputedStyle(bubble).paddingLeft) + Number.parseFloat(getComputedStyle(bubble).paddingRight)
          : 24;
        const available = message ? message.clientWidth : element.clientWidth;
        const maxWidth = Math.min(980, Math.max(0, available * 0.88));
        const nextWidth = Math.max(64, Math.min(maxWidth || 980, Math.ceil(longestLine + padding)));
        setContentWidth((current) => current === nextWidth ? current : nextWidth);
      }
      setCollapsible(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (message) observer.observe(message);
    return () => observer.disconnect();
  }, [expanded, props.text]);

  useEffect(() => {
    if (expanded) {
      setContentWidth(null);
    }
  }, [expanded]);

  return (
    <div
      className={`user-message-bubble ${expanded ? "is-expanded" : "is-collapsed"}`}
      style={contentWidth ? { width: `${contentWidth}px` } : undefined}
    >
      <div ref={textRef} className="user-message-text">{props.text}</div>
      {collapsible ? (
        <button
          type="button"
          className="user-message-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          {expanded ? "收起" : "展开"}
        </button>
      ) : null}
    </div>
  );
}

const USER_PARTS = {
  Text: UserTextPart,
};

const ASSISTANT_PART_GROUPS = groupPartByType({
  "tool-call": ["group-tools"],
});

function UserMessage() {
  return (
    <MessagePrimitive.Root className="aui-message aui-message-user">
      <span className="message-role">你</span>
      <MessagePrimitive.Parts components={USER_PARTS} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="aui-message aui-message-assistant">
      <span className="message-role">Plex</span>
      <div className="assistant-message-content">
        <div className="assistant-parts">
          <MessagePrimitive.GroupedParts
            groupBy={ASSISTANT_PART_GROUPS}
            indicator="never"
          >
            {({ part, children }) => {
              switch (part.type) {
                case "group-tools":
                  return (
                    <ToolCallGroup count={part.indices.length}>
                      {children}
                    </ToolCallGroup>
                  );
                case "text":
                  return <AssistantMarkdownPart {...part} />;
                case "reasoning":
                  return <ThinkingPart {...part} />;
                case "tool-call":
                  return part.toolUI ?? <ToolCallPart {...part} />;
                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
        </div>
        <ActionBarPrimitive.Root
          className="plex-assistant-action-bar"
          hideWhenRunning
          autohide="always"
        >
          <ActionBarPrimitive.Copy
            className="assistant-copy-button"
            title="复制回答"
            aria-label="复制回答"
            copiedDuration={1800}
          >
            <MessagePrimitive.If copied>
              <Check aria-hidden="true" />
            </MessagePrimitive.If>
            <MessagePrimitive.If copied={false}>
              <Copy aria-hidden="true" />
            </MessagePrimitive.If>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

type ToolTimelineItem = Extract<
  TimelineItem,
  { kind: "tool" | "approval" }
>;

function isToolTimelineItem(item: TimelineItem): item is ToolTimelineItem {
  return item.kind === "tool" || item.kind === "approval";
}

function toToolCallPart(
  item: ToolTimelineItem,
): ToolCallMessagePart<any, string> {
  if (item.kind === "tool") {
    const completed = item.status === "completed";
    return {
      type: "tool-call",
      toolCallId: `${item.callId}-${item.key}`,
      toolName: item.name,
      args: item.approval?.preview
        ? { ...item.args, preview: item.approval.preview }
        : item.args,
      argsText: JSON.stringify(item.args),
      ...(item.approval
        ? {
            approval: {
              id: item.callId,
              prompt: "此工具需要你的批准后才会执行。",
              allowFreeform: true,
              ...(item.approval.status === "approved" ? { approved: true } : {}),
              ...(item.approval.status === "rejected"
                ? { approved: false, reason: item.approval.reason ?? undefined }
                : {}),
              ...(item.approval.status === "cancelled"
                ? { resolution: "cancelled" as const }
                : {}),
            },
          }
        : {}),
      ...(item.status === "running"
        ? {}
        : {
            result: completed
              ? item.output ?? ""
              : item.error ?? "工具执行失败",
            isError: !completed,
          }),
    };
  }

  return {
    type: "tool-call",
    toolCallId: `${item.callId}-${item.key}`,
    toolName: item.toolName,
    args: { ...item.args, preview: item.preview },
    argsText: JSON.stringify(item.args),
    approval: {
      id: item.callId,
      prompt: "此工具需要你的批准后才会执行。",
      allowFreeform: true,
      ...(item.status === "approved" ? { approved: true } : {}),
      ...(item.status === "rejected"
        ? { approved: false, reason: item.reason ?? undefined }
        : {}),
      ...(item.status === "cancelled" ? { resolution: "cancelled" as const } : {}),
    },
  };
}

function toolBatchStatus(items: ToolTimelineItem[]) {
  if (
    items.some(
      (item) =>
        (item.kind === "approval" && item.status === "pending") ||
        (item.kind === "tool" && item.approval?.status === "pending"),
    )
  ) {
    return { type: "requires-action" as const, reason: "tool-calls" as const };
  }
  if (items.some((item) => item.kind === "tool" && item.status === "running")) {
    return { type: "running" as const };
  }
  return { type: "complete" as const, reason: "stop" as const };
}

type AssistantMessagePart = Exclude<ThreadMessageLike["content"], string>[number];

function assistantTurnStatus(items: TimelineItem[]): ThreadMessageLike["status"] {
  const toolItems = items.filter(isToolTimelineItem);
  const toolStatus = toolItems.length > 0 ? toolBatchStatus(toolItems) : null;

  if (toolStatus?.type === "requires-action" || toolStatus?.type === "running") {
    return toolStatus;
  }
  if (items.some((item) => item.kind === "error")) {
    return { type: "incomplete", reason: "error" };
  }
  if (
    items.some(
      (item) =>
        item.kind === "thinking" ||
        (item.kind === "assistant" && item.streaming),
    )
  ) {
    return { type: "running" };
  }
  return { type: "complete", reason: "stop" };
}

function toAssistantMessages(items: TimelineItem[]): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (!item) break;
    const createdAt = new Date(index);
    if (item.kind === "user") {
      messages.push({ id: item.key, role: "user", content: item.text, createdAt });
      index += 1;
      continue;
    }

    const turnItems: TimelineItem[] = [];
    const content: AssistantMessagePart[] = [];

    while (index < items.length) {
      const candidate = items[index];
      if (!candidate || candidate.kind === "user") break;

      turnItems.push(candidate);
      if (candidate.kind === "assistant") {
        content.push({ type: "text", text: candidate.text });
      } else if (candidate.kind === "thinking") {
        content.push({ type: "reasoning", text: "正在处理任务步骤" });
      } else if (isToolTimelineItem(candidate)) {
        content.push(toToolCallPart(candidate));
      } else {
        content.push({ type: "text", text: candidate.text });
      }
      index += 1;
    }

    messages.push({
      id: `assistant-turn-${item.key}`,
      role: "assistant",
      content,
      createdAt,
      status: assistantTurnStatus(turnItems),
    });
  }

  return messages;
}

function AssistantTimeline(props: {
  items: TimelineItem[];
  running: boolean;
  onApprove: (callId: string) => Promise<void>;
  onReject: (callId: string, reason: string) => Promise<void>;
}) {
  const messages = useMemo(() => toAssistantMessages(props.items), [props.items]);
  const respondToToolApproval = useCallback(
    async (input: { approvalId: string; approved: boolean; reason?: string }) => {
      if (input.approved) {
        await props.onApprove(input.approvalId);
      } else {
        await props.onReject(input.approvalId, input.reason ?? "");
      }
    },
    [props.onApprove, props.onReject],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: props.running,
    convertMessage: (message) => message,
    onNew: async () => {},
    onRespondToToolApproval: respondToToolApproval,
  });

  if (messages.length === 0) {
    return <div className="empty-state"><p>任务已创建，正在准备执行。</p></div>;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="assistant-thread">
        <ThreadPrimitive.Viewport className="assistant-viewport" autoScroll>
          <motion.div className="timeline" layout>
            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
              }}
            />
          </motion.div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function statusClass(status: TaskStatus): string {
  return `status status-${status}`;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    resolveTheme(localStorage.getItem("plex.theme")),
  );
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [liveEvents, setLiveEvents] = useState<TaskEventRecord[]>([]);
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [customProviders, setCustomProviders] = useState<
    CustomProviderConfig[]
  >([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [keyStates, setKeyStates] = useState<
    Record<string, ProviderKeyState>
  >({});
  const [catalogSource, setCatalogSource] = useState("cache");
  const [fetchedAtUnix, setFetchedAtUnix] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectWorkspace, setProjectWorkspace] = useState("");
  const [projectDialogError, setProjectDialogError] = useState<string | null>(
    null,
  );
  const [projectSubmitting, setProjectSubmitting] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [workspace, setWorkspace] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const selectedRef = useRef<string | null>(null);
  const awaitingTaskRef = useRef(false);
  const projectNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!projectDialogOpen) {
      return;
    }

    const focusInput = window.requestAnimationFrame(() => {
      projectNameInputRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !projectSubmitting) {
        setProjectDialogOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusInput);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectDialogOpen, projectSubmitting]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("plex.theme", theme);
  }, [theme]);

  const refreshTasks = useCallback(async () => {
    const next = await sidecar.listTasks();
    setTasks(next);
    return next;
  }, []);

  const refreshProjects = useCallback(async () => {
    const next = await sidecar.listProjects();
    setProjects(next);
    return next;
  }, []);

  const refreshSkills = useCallback(async () => {
    const next = await sidecar.listSkills();
    setSkills(next);
    return next;
  }, []);

  const loadDetail = useCallback(async (taskId: string) => {
    if (selectedRef.current === taskId) {
      setDetailLoading(true);
    }
    try {
      const next = await sidecar.getTask(taskId);
      if (selectedRef.current === taskId) {
        setDetail(next);
      }
      return next;
    } finally {
      if (selectedRef.current === taskId) {
        setDetailLoading(false);
      }
    }
  }, []);

  const refreshKeyStates = useCallback(
    async (catalog: CatalogProvider[], providerId?: string) => {
      const targets = providerId
        ? catalog.filter((provider) => provider.id === providerId)
        : catalog
            .filter(
              (provider) =>
                provider.source === "custom" || provider.supported,
            );
      if (targets.length === 0) {
        return;
      }
      const statuses = await sidecar.providerKeyStatus(
        targets.map((provider) => ({
          id: provider.id,
          envNames: provider.env,
          baseUrl: provider.api,
          local: provider.local,
        })),
      );
      setKeyStates((current) => {
        const next = { ...current };
        for (const item of statuses) {
          next[item.providerId] = {
            configured: item.configured,
            source: item.source,
          };
        }
        return next;
      });
    },
    [],
  );

  const loadCatalog = useCallback(
    async (forceRefresh = false) => {
      setCatalogLoading(true);
      try {
        const [response, customs] = await Promise.all([
          sidecar.modelsCatalog(forceRefresh),
          sidecar.listCustomProviders(),
        ]);
        setCustomProviders(customs);
        const catalog = sortProviders([
          ...customProvidersToCatalog(customs),
          ...normalizeCatalog(response.catalog),
        ]);
        setProviders(catalog);
        setCatalogSource(response.source);
        setFetchedAtUnix(response.fetchedAtUnix);
        void refreshKeyStates(catalog);

        setSelection((current) => {
          if (current) {
            const provider = findProvider(catalog, current.providerId);
            const model = findModel(provider, current.modelId);
            if (provider?.supported && model) {
              return current;
            }
          }
          const preferred =
            findProvider(catalog, "openai") ??
            catalog.find((provider) => provider.supported);
          if (!preferred) {
            return null;
          }
          const preferredModel =
            preferred.id === "openai"
              ? (findModel(preferred, "gpt-6-astra") ?? preferred.models[0])
              : preferred.models[0];
          if (!preferredModel) {
            return null;
          }
          return {
            providerId: preferred.id,
            modelId: preferredModel.id,
            effort: defaultEffort(preferredModel.efforts),
          };
        });
      } finally {
        setCatalogLoading(false);
      }
    },
    [refreshKeyStates],
  );

  const loadSavedCustomProviders = useCallback(async () => {
    const customs = await sidecar.listCustomProviders();
    const catalog = sortProviders(customProvidersToCatalog(customs));
    setCustomProviders(customs);
    setProviders(catalog);
    void refreshKeyStates(catalog);

    setSelection((current) => {
      if (current) {
        const provider = findProvider(catalog, current.providerId);
        if (provider && findModel(provider, current.modelId)) {
          return current;
        }
      }
      const provider = catalog[0];
      const model = provider?.models[0];
      return provider && model
        ? {
            providerId: provider.id,
            modelId: model.id,
            effort: defaultEffort(model.efforts),
          }
        : null;
    });
  }, [refreshKeyStates]);

  const openSettings = useCallback(
    (expandProviders = false) => {
      setSettingsOpen(true);
      setProvidersOpen(expandProviders);
      if (expandProviders) {
        void loadCatalog(false).catch((catalogError) => {
          setError(
            catalogError instanceof Error
              ? `模型目录加载失败：${catalogError.message}`
              : `模型目录加载失败：${String(catalogError)}`,
          );
        });
      }
    },
    [loadCatalog],
  );

  const setProviderSettingsOpen = useCallback(
    (open: boolean) => {
      setProvidersOpen(open);
      if (!open) {
        return;
      }
      void loadCatalog(false).catch((catalogError) => {
        setError(
          catalogError instanceof Error
            ? `模型目录加载失败：${catalogError.message}`
            : `模型目录加载失败：${String(catalogError)}`,
        );
      });
    },
    [loadCatalog],
  );

  useEffect(() => {
    const unsubscribe = sidecar.onMessage((message) => {
      if (message.type === "log") {
        setLogs((current) => [...current.slice(-49), message.message]);
        return;
      }
      if (message.type !== "event") {
        return;
      }

      const event = message.event;
      setLiveEvents((current) =>
        current.some(
          (candidate) =>
            candidate.taskId === event.taskId && candidate.seq === event.seq,
        )
          ? current
          : [...current, event],
      );

      if (event.type === "task.created") {
        void refreshTasks();
        if (awaitingTaskRef.current) {
          awaitingTaskRef.current = false;
          setSelectedId(event.taskId);
        }
        return;
      }
      if (
        event.type === "task.started" ||
        event.type === "task.completed" ||
        event.type === "task.failed" ||
        event.type === "task.cancelled"
      ) {
        void refreshTasks();
        if (selectedRef.current === event.taskId) {
          void loadDetail(event.taskId);
        }
        if (event.type === "task.started" && selectedRef.current === event.taskId) {
          setSubmitting(false);
        }
      }
    });

    void (async () => {
      try {
        await sidecar.connect();
        setConnected(true);
        void sidecar.status().then(setStatus).catch((statusError) => {
          setError(
            statusError instanceof Error ? statusError.message : String(statusError),
          );
        });

        // 会话摘要只读取本地 SQLite，优先完成首屏渲染。
        const [projectsResult, tasksResult] = await Promise.allSettled([
          refreshProjects(),
          refreshTasks(),
        ]);
        if (projectsResult.status === "rejected") {
          throw projectsResult.reason;
        }
        if (tasksResult.status === "rejected") {
          throw tasksResult.reason;
        }
        const next = tasksResult.value;
        void refreshSkills().catch((skillError) => {
          setError(
            skillError instanceof Error
              ? `Skill 列表加载失败：${skillError.message}`
              : `Skill 列表加载失败：${String(skillError)}`,
          );
        });
        if (next[0]) {
          setSelectedId(next[0].id);
        }
        setSessionsLoading(false);

        // 自定义供应商和已选模型都保存在本地，不需要请求 models.dev。
        void loadSavedCustomProviders().catch((customError) => {
          setError(
            customError instanceof Error
              ? `自定义供应商加载失败：${customError.message}`
              : `自定义供应商加载失败：${String(customError)}`,
          );
        });

      } catch (connectError) {
        setSessionsLoading(false);
        const rawMessage =
          connectError instanceof Error
            ? connectError.message
            : String(connectError);
        setError(
          rawMessage.includes("transformCallback")
            ? "请在 Plex 桌面应用中运行，浏览器预览无法连接本地 Agent 服务。"
            : rawMessage,
        );
      }
    })();

    return () => {
      unsubscribe();
    };
  }, [loadDetail, loadSavedCustomProviders, refreshProjects, refreshSkills, refreshTasks]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    void loadDetail(selectedId).catch((loadError) => {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    });
  }, [loadDetail, selectedId]);

  const taskEvents = useMemo(() => {
    const map = new Map<number, TaskEventRecord>();
    if (detail && detail.task.id === selectedId) {
      for (const event of detail.events) {
        map.set(event.seq, event);
      }
    }
    for (const event of liveEvents) {
      if (event.taskId === selectedId) {
        map.set(event.seq, event);
      }
    }
    return [...map.values()].sort((left, right) => left.seq - right.seq);
  }, [detail, liveEvents, selectedId]);

  const currentTask = useMemo(() => {
    if (detail && detail.task.id === selectedId) {
      return detail.task;
    }
    return tasks.find((task) => task.id === selectedId);
  }, [detail, selectedId, tasks]);

  useEffect(() => {
    if (!currentTask) return;
    setDraftProjectId(currentTask.projectId);
    setWorkspace(currentTask.workspace);
  }, [currentTask]);

  const timeline = useMemo(
    () => buildTimeline(currentTask, taskEvents),
    [currentTask, taskEvents],
  );

  const active =
    currentTask?.status === "running" ||
    currentTask?.status === "awaiting_approval" ||
    currentTask?.status === "pending";

  const pickWorkspace = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择任务可访问的工作目录",
    });
    if (typeof selected === "string") {
      setWorkspace(selected);
    }
  };

  const submitTask = async () => {
    setError(null);
    const provider = findProvider(providers, selection?.providerId ?? "");
    const model = findModel(provider, selection?.modelId ?? "");
    const project = draftProjectId
      ? projects.find((candidate) => candidate.id === draftProjectId)
      : undefined;
    if (draftProjectId && !project) {
      setError("项目不存在，请重新选择");
      return;
    }
    if (draftProjectId && project?.workspace.trim().length === 0) {
      setError("请选择工作目录");
      return;
    }
    if (prompt.trim().length === 0) {
      setError("请描述任务目标");
      return;
    }
    if (!provider?.supported || !model) {
      setError("请选择支持工具调用的模型");
      return;
    }
    if (!provider.local && keyStates[provider.id]?.configured !== true) {
      setError(`请先在设置中为 ${provider.name} 配置 API Key`);
      openSettings(true);
      return;
    }

    setSubmitting(true);
    awaitingTaskRef.current = true;
    window.setTimeout(() => {
      awaitingTaskRef.current = false;
    }, 10_000);
    try {
      await sidecar.startTask({
        prompt: prompt.trim(),
        workspace: project ? project.workspace : "",
        projectId: draftProjectId,
        provider: {
          id: provider.id,
          name: provider.name,
          baseUrl:
            provider.baseUrl,
          apiStyle: provider.apiStyle,
          modelId: model.id,
          reasoningEffort: selection?.effort ?? null,
          envNames: provider.env,
          local: provider.local,
        },
      });
      setPrompt("");
    } catch (submitError) {
      awaitingTaskRef.current = false;
      const message =
        submitError instanceof Error
          ? submitError.message
          : String(submitError);
      setError(message);
      if (message.includes("MISSING_API_KEY")) {
        openSettings(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const continueTask = async () => {
    if (!currentTask || prompt.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await sidecar.continueTask(currentTask.id, prompt.trim());
      setPrompt("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
    }
  };

  const approve = async (callId: string) => {
    if (!currentTask) {
      return;
    }
    await sidecar.approve(currentTask.id, callId);
  };

  const reject = async (callId: string, reason: string) => {
    if (!currentTask) {
      return;
    }
    await sidecar.reject(currentTask.id, callId, reason);
  };

  const cancel = async () => {
    if (!currentTask) {
      return;
    }
    await sidecar.cancel(currentTask.id);
    await refreshTasks();
  };

  const saveProviderKey = async (providerId: string, key: string) => {
    await sidecar.saveProviderKey(providerId, key);
    await refreshKeyStates(providers, providerId);
  };

  const deleteProviderKey = async (providerId: string) => {
    await sidecar.deleteProviderKey(providerId);
    await refreshKeyStates(providers, providerId);
  };

  const saveCustomProvider = async (provider: CustomProviderConfig) => {
    const saved = await sidecar.saveCustomProvider(provider);
    await loadCatalog(false);
    return saved;
  };

  const deleteCustomProvider = async (providerId: string) => {
    await sidecar.deleteCustomProvider(providerId);
    await loadCatalog(false);
  };

  const openProjectDialog = () => {
    setProjectName("");
    setProjectWorkspace("");
    setProjectDialogError(null);
    setProjectDialogOpen(true);
  };

  const closeProjectDialog = () => {
    if (!projectSubmitting) {
      setProjectDialogOpen(false);
    }
  };

  const pickProjectWorkspace = async () => {
    setProjectDialogError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择项目工作目录",
      });
      if (typeof selected === "string") {
        setProjectWorkspace(selected);
      }
    } catch (selectionError) {
      setProjectDialogError(
        selectionError instanceof Error
          ? selectionError.message
          : String(selectionError),
      );
    }
  };

  const createProject = async () => {
    const name = projectName.trim();
    const selectedWorkspace = projectWorkspace.trim();
    if (name.length === 0) {
      setProjectDialogError("请填写项目名称");
      projectNameInputRef.current?.focus();
      return;
    }
    if (selectedWorkspace.length === 0) {
      setProjectDialogError("请先选择项目工作目录");
      return;
    }

    setProjectSubmitting(true);
    setProjectDialogError(null);
    try {
      const project = await sidecar.createProject(name, selectedWorkspace);
      await refreshProjects();
      setDraftProjectId(project.id);
      setSelectedId(null);
      setDetail(null);
      setWorkspace(project.workspace);
      setPrompt("");
      setProjectDialogOpen(false);
    } catch (createError) {
      setProjectDialogError(
        createError instanceof Error ? createError.message : String(createError),
      );
    } finally {
      setProjectSubmitting(false);
    }
  };

  const startDraft = (projectId: string | null) => {
    setSelectedId(null);
    setDetail(null);
    setDraftProjectId(projectId);
    setWorkspace(projectId ? projects.find((project) => project.id === projectId)?.workspace ?? "" : "");
    setPrompt("");
  };

  const fetchProviderModels = async (input: {
    baseUrl: string;
    providerId?: string;
    apiKey?: string;
  }) => sidecar.fetchProviderModels(input);

  const importSkill = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择包含 SKILL.md 的 Skill 目录",
      });
      if (typeof selected !== "string") {
        return;
      }
      await sidecar.importSkill(selected);
      await refreshSkills();
    } catch (importError) {
      setError(
        importError instanceof Error
          ? `导入 Skill 失败：${importError.message}`
          : `导入 Skill 失败：${String(importError)}`,
      );
    }
  };

  const toggleSkill = async (skillId: string, enabled: boolean) => {
    try {
      await sidecar.setSkillEnabled(skillId, enabled);
      await refreshSkills();
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? `更新 Skill 状态失败：${toggleError.message}`
          : `更新 Skill 状态失败：${String(toggleError)}`,
      );
    }
  };

  const updateSkill = async (input: {
    skillId: string;
    content: string;
  }) => {
    try {
      await sidecar.updateSkill(input);
      await refreshSkills();
    } catch (updateError) {
      throw new Error(
        updateError instanceof Error
          ? `保存 Skill 失败：${updateError.message}`
          : `保存 Skill 失败：${String(updateError)}`,
      );
    }
  };

  const deleteSkill = async (skillId: string) => {
    const skill = skills.find((item) => item.id === skillId);
    if (!skill || !window.confirm(`确定删除 Skill“${skill.name}”吗？`)) {
      return;
    }
    try {
      await sidecar.deleteSkill(skillId);
      await refreshSkills();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? `删除 Skill 失败：${deleteError.message}`
          : `删除 Skill 失败：${String(deleteError)}`,
      );
    }
  };

  const selectedProvider = findProvider(
    providers,
    selection?.providerId ?? "",
  );
  const selectedModel = findModel(selectedProvider, selection?.modelId ?? "");

  return (
    <div className="codex-shell">
      <aside className="codex-sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <strong>Plex</strong>
          </div>
          <button
            className="icon-button sidebar-settings-button"
            title="设置"
            aria-label="打开设置"
            onClick={() => openSettings()}
          >
            ⚙
          </button>
        </div>

        <button
          className="new-thread"
          onClick={() => startDraft(null)}
        >
          <span>＋</span> 新建会话
        </button>

        <div className="thread-list">
          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <span>项目</span>
              <button
                className="sidebar-action"
                title="新建项目"
                aria-label="新建项目"
                onClick={openProjectDialog}
              >
                ＋
              </button>
            </div>
            {projects.map((project) => {
              const projectTasks = tasks.filter((task) => task.projectId === project.id);
              const collapsed = collapsedProjects.has(project.id);
              return (
                <motion.div layout className="project-block" key={project.id}>
                  <div className="project-row">
                    <button
                      className="project-toggle"
                      title={collapsed ? "展开项目会话" : "折叠项目会话"}
                      aria-expanded={!collapsed}
                      onClick={() => setCollapsedProjects((current) => {
                        const next = new Set(current);
                        if (next.has(project.id)) {
                          next.delete(project.id);
                        } else {
                          next.add(project.id);
                        }
                        return next;
                      })}
                    >
                      <span className={`project-chevron ${collapsed ? "is-collapsed" : ""}`} aria-hidden="true">⌄</span>
                      <span className="project-folder-icon" aria-hidden="true" />
                      <span className="project-name">{project.name}</span>
                    </button>
                    <button
                      className="project-new-session"
                      title="在此项目中新建会话"
                      aria-label={`在项目 ${project.name} 中新建会话`}
                      onClick={() => startDraft(project.id)}
                    >
                      ＋
                    </button>
                  </div>
                  <AnimatePresence initial={false}>
                    {!collapsed ? (
                      <motion.div
                        className="project-sessions"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.16 }}
                      >
                        {projectTasks.length > 0 ? projectTasks.map((task) => (
                          <div className="project-session-node" key={task.id}>
                            <button
                              className={`thread-item project-session ${task.id === selectedId ? "is-active" : ""}`}
                              onClick={() => {
                                setSelectedId(task.id);
                                setDraftProjectId(task.projectId);
                                setWorkspace(task.workspace);
                              }}
                            >
                              <span className="thread-title">{task.title}</span>
                            </button>
                          </div>
                        )) : (
                          <p className="project-empty">此项目还没有会话</p>
                        )}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
          <div className="sidebar-section recent-section">
            <div className="sidebar-section-header"><span>最近会话</span></div>
            {tasks.filter((task) => task.projectId === null).map((task) => (
              <button
                key={task.id}
                className={`thread-item ${task.id === selectedId ? "is-active" : ""}`}
                onClick={() => {
                  setSelectedId(task.id);
                  setDraftProjectId(null);
                  setWorkspace(task.workspace);
                }}
              >
                <span className="thread-title">{task.title}</span>
              </button>
            ))}
            {sessionsLoading ? <p className="sidebar-empty">正在加载会话…</p> : null}
            {!sessionsLoading && tasks.filter((task) => task.projectId === null).length === 0 ? <p className="sidebar-empty">暂无独立会话</p> : null}
          </div>
        </div>

        <div
          className="sidebar-footer"
          title={status?.databasePath ?? undefined}
        >
          <span className={`dot ${connected ? "dot-online" : ""}`} />
          <span>{connected ? "已连接" : "未连接"}</span>
          <span className="sidebar-model">
            {selectedProvider && selectedModel
              ? `${selectedProvider.name} · ${selectedModel.name}`
              : currentTask?.providerName
                ? `${currentTask.providerName} · ${currentTask.model}`
                : "在设置中配置模型"}
          </span>
        </div>
      </aside>

      <main className="codex-main">
        <header className="codex-topbar">
          <div className="topbar-title">
            <h1>{currentTask ? currentTask.title : "新建任务"}</h1>
            <p>
              {currentTask
                ? currentTask.workspace
                : draftProjectId
                  ? projects.find((project) => project.id === draftProjectId)?.name ?? "项目会话"
                  : "独立会话 · 简单对话，不使用系统工具"}
            </p>
          </div>
          <div className="topbar-actions">
            {currentTask ? (
              <>
                <span className={statusClass(currentTask.status)}>
                  {STATUS_LABELS[currentTask.status]}
                </span>
                {currentTask.providerName ? (
                  <span className="topbar-model">
                    {currentTask.providerName}
                    {currentTask.reasoningEffort
                      ? ` · ${currentTask.reasoningEffort}`
                      : ""}
                  </span>
                ) : null}
                {active ? (
                  <button
                    className="ghost danger-text"
                    onClick={() => void cancel()}
                  >
                    取消
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </header>

        <AnimatePresence>
        {error ? (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="codex-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>关闭</button>
          </motion.div>
        ) : null}
        </AnimatePresence>

        <section className="codex-content">
          {currentTask ? (
            detailLoading && (!detail || detail.task.id !== selectedId) ? (
              <div className="detail-loading" role="status">
                <span className="loading-spinner" />
                <span>正在加载会话内容…</span>
              </div>
            ) : (
              <AssistantTimeline
                items={timeline}
                running={currentTask.status === "running"}
                onApprove={approve}
                onReject={reject}
              />
            )
          ) : (
            <motion.div key={draftProjectId ?? "standalone"} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }} className="codex-welcome">
              <h2>{draftProjectId ? "开始项目会话" : "开始独立会话"}</h2>
              <p>
                {draftProjectId ? "Plex 可以访问项目目录，按步骤调用工具，并在写入文件前请求审批。" : "独立会话用于普通对话，不会访问本机文件或调用系统工具。"}
              </p>
              {draftProjectId ? <div className="welcome-hints">
                <span>文本文件读写</span>
                <span>多步工具调用</span>
                <span>写入前 diff 审批</span>
              </div> : null}
            </motion.div>
          )}
        </section>

        <footer className="codex-composer">
            <motion.div layout className="composer-box" transition={{ layout: { duration: 0.2 } }}>
              {draftProjectId ? <div className="composer-workspace">
                <span className="workspace-label">目录</span>
                <input
                  value={workspace}
                  onChange={(event) => setWorkspace(event.target.value)}
                  placeholder="/Users/you/project"
                />
                <button
                  className="ghost small"
                  onClick={() => void pickWorkspace()}
                >
                  选择
                </button>
              </div> : null}
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (!submitting && !active && (currentTask === undefined || currentTask.status === "completed")) {
                      void (currentTask ? continueTask() : submitTask());
                    }
                  }
                }}
                placeholder="描述你希望 Plex 完成的任务，例如：阅读这个目录里的资料，整理项目概览和待办清单，写入 summary.md"
                rows={4}
              />
              <div className="composer-toolbar">
                <ModelPicker
                  providers={providers}
                  keyStates={keyStates}
                  value={selection}
                  onChange={setSelection}
                />
                <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.94 }}
                  className="send-button"
                  disabled={
                    submitting ||
                    active ||
                    (currentTask !== undefined &&
                      currentTask.status !== "completed")
                  }
                  onClick={() => void (currentTask ? continueTask() : submitTask())}
                  title="开始任务"
                >
                  {submitting ? "…" : "↑"}
                </motion.button>
              </div>
            </motion.div>
            <p className="composer-note">
              {draftProjectId ? "读取在项目授权目录内完成；写入必须审批。模型请求会发送到所选供应商。" : "独立会话不会调用系统工具。模型请求会发送到所选供应商。"}
            </p>
        </footer>
      </main>

      {settingsOpen ? (
        <ProviderSettings
          theme={theme}
          onThemeChange={setTheme}
          providersOpen={providersOpen}
          onProvidersOpenChange={setProviderSettingsOpen}
          providers={providers}
          customProviders={customProviders}
          keyStates={keyStates}
          catalogSource={catalogSource}
          fetchedAtUnix={fetchedAtUnix}
          catalogLoading={catalogLoading}
          onSave={saveProviderKey}
          onDelete={deleteProviderKey}
          onSaveCustom={saveCustomProvider}
          onDeleteCustom={deleteCustomProvider}
          onFetchModels={fetchProviderModels}
          onRefresh={() => loadCatalog(true)}
          skills={skills}
          onImportSkill={importSkill}
          onToggleSkill={toggleSkill}
          onUpdateSkill={updateSkill}
          onDeleteSkill={deleteSkill}
          onClose={() => {
            setSettingsOpen(false);
            setProvidersOpen(false);
          }}
        />
      ) : null}

      {projectDialogOpen ? (
        <div className="modal-backdrop" onClick={closeProjectDialog}>
          <motion.form
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-dialog-title"
            initial={{ opacity: 0, scale: 0.98, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 12 }}
            transition={{ duration: 0.18 }}
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <header className="project-modal-header">
              <h2 id="project-dialog-title">新建项目</h2>
              <button
                className="project-modal-close"
                type="button"
                title="关闭"
                aria-label="关闭新建项目弹窗"
                disabled={projectSubmitting}
                onClick={closeProjectDialog}
              >
                ×
              </button>
            </header>

            <label className="project-name-field">
              <span className="project-field-icon" aria-hidden="true" />
              <input
                ref={projectNameInputRef}
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="项目名称"
                disabled={projectSubmitting}
              />
            </label>

            <section className="project-directory-section" aria-labelledby="project-directory-label">
              <h3 id="project-directory-label">项目工作目录</h3>
              <div className="project-directory-picker">
                {projectWorkspace ? (
                  <p className="project-directory-path" title={projectWorkspace}>{projectWorkspace}</p>
                ) : (
                  <p className="project-directory-hint">选择此项目中 Agent 可以访问的本机目录</p>
                )}
                <button
                  className="project-directory-button"
                  type="button"
                  disabled={projectSubmitting}
                  onClick={() => void pickProjectWorkspace()}
                >
                  <span className="directory-button-icon" aria-hidden="true" />
                  {projectWorkspace ? "重新选择目录" : "选择本机目录"}
                </button>
              </div>
            </section>

            {projectDialogError ? <p className="project-dialog-error" role="alert">{projectDialogError}</p> : null}

            <footer className="project-modal-actions">
              <button className="project-cancel" type="button" disabled={projectSubmitting} onClick={closeProjectDialog}>取消</button>
              <button className="project-create" type="submit" disabled={projectSubmitting}>
                {projectSubmitting ? "创建中…" : "创建项目"}
              </button>
            </footer>
          </motion.form>
        </div>
      ) : null}

      {logs.length > 0 && !connected ? (
        <div className="log-drawer">
          <pre>{logs.slice(-6).join("\n")}</pre>
        </div>
      ) : null}
    </div>
  );
}
