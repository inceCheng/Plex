import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { sidecar } from "./api";
import type {
  SidecarStatus,
  TaskDetail,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
} from "./types";
import "./App.css";

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "等待中",
  running: "执行中",
  awaiting_approval: "待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

type TimelineItem =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "assistant"; text: string; streaming?: boolean }
  | {
      key: string;
      kind: "tool";
      callId: string;
      name: string;
      args: Record<string, unknown>;
      status: "running" | "completed" | "failed";
      output: string | null;
      error: string | null;
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
  let streamText = "";
  let userPromptShown = false;

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
        streamText += String(data.text ?? "");
        break;
      }
      case "message.completed": {
        streamText = "";
        items.push({
          key: `assistant-${event.seq}`,
          kind: "assistant",
          text: String(data.text ?? task?.finalOutput ?? ""),
        });
        break;
      }
      case "tool.started": {
        const callId = String(data.callId ?? event.seq);
        items.push({
          key: `tool-${callId}`,
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
        const callId = String(data.callId ?? event.seq);
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
        if (item) {
          item.status = data.approved === true ? "approved" : "rejected";
          item.reason = typeof data.reason === "string" ? data.reason : null;
        }
        break;
      }
      case "task.failed": {
        items.push({
          key: `failed-${event.seq}`,
          kind: "error",
          text: String(data.error ?? "任务执行失败"),
          code: typeof data.code === "string" ? data.code : null,
        });
        break;
      }
      case "task.cancelled": {
        items.push({
          key: `cancelled-${event.seq}`,
          kind: "notice",
          text: "任务已取消，后续工具调用不会执行。",
        });
        break;
      }
      default:
        break;
    }
  }

  if (streamText.length > 0) {
    items.push({
      key: "assistant-streaming",
      kind: "assistant",
      text: streamText,
      streaming: true,
    });
  }
  return items;
}

function statusClass(status: TaskStatus): string {
  return `status status-${status}`;
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function workspaceName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function ApprovalCard(props: {
  item: Extract<TimelineItem, { kind: "approval" }>;
  onApprove: () => Promise<void>;
  onReject: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = props.item.status === "pending";
  const diff =
    props.item.preview && typeof props.item.preview.diff === "string"
      ? props.item.preview.diff
      : null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`approval-card ${pending ? "is-pending" : ""}`}>
      <header>
        <span className="approval-icon">⚠</span>
        <div>
          <strong>需要审批：{props.item.toolName}</strong>
          <p>
            批准后才会执行这次写入。审批内容绑定当前路径与完整内容。
          </p>
        </div>
        <span className={`decision decision-${props.item.status}`}>
          {props.item.status === "pending"
            ? "待处理"
            : props.item.status === "approved"
              ? "已批准"
              : props.item.status === "rejected"
                ? "已拒绝"
                : "已取消"}
        </span>
      </header>

      {diff ? (
        <pre className="diff-view">{diff}</pre>
      ) : (
        <pre className="args-view">
          {JSON.stringify(props.item.args, null, 2)}
        </pre>
      )}

      {pending ? (
        <footer className="approval-actions">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="拒绝原因（可选）"
          />
          <button
            className="danger"
            disabled={busy}
            onClick={() => void run(() => props.onReject(reason))}
          >
            拒绝
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void run(() => props.onApprove())}
          >
            批准并执行
          </button>
        </footer>
      ) : props.item.reason ? (
        <p className="approval-reason">原因：{props.item.reason}</p>
      ) : null}
    </article>
  );
}

function Timeline(props: {
  items: TimelineItem[];
  taskId: string;
  onApprove: (callId: string) => Promise<void>;
  onReject: (callId: string, reason: string) => Promise<void>;
}) {
  if (props.items.length === 0) {
    return (
      <div className="empty-state">
        <p>这个任务还没有执行记录。</p>
      </div>
    );
  }

  return (
    <div className="timeline">
      {props.items.map((item) => {
        if (item.kind === "user") {
          return (
            <article className="bubble bubble-user" key={item.key}>
              {item.text}
            </article>
          );
        }
        if (item.kind === "assistant") {
          return (
            <article className="bubble bubble-assistant" key={item.key}>
              {item.text}
              {item.streaming ? <span className="cursor">▍</span> : null}
            </article>
          );
        }
        if (item.kind === "tool") {
          return (
            <details className={`tool-card tool-${item.status}`} key={item.key}>
              <summary>
                <span className="tool-name">{item.name}</span>
                <span className="tool-status">
                  {item.status === "running"
                    ? "执行中"
                    : item.status === "completed"
                      ? "已完成"
                      : "失败"}
                </span>
              </summary>
              <div className="tool-body">
                <div>
                  <span className="label">参数</span>
                  <pre>{JSON.stringify(item.args, null, 2)}</pre>
                </div>
                {item.output ? (
                  <div>
                    <span className="label">结果</span>
                    <pre>{item.output}</pre>
                  </div>
                ) : null}
                {item.error ? (
                  <div>
                    <span className="label">错误</span>
                    <pre className="error-text">{item.error}</pre>
                  </div>
                ) : null}
              </div>
            </details>
          );
        }
        if (item.kind === "approval") {
          return (
            <ApprovalCard
              item={item}
              key={item.key}
              onApprove={() => props.onApprove(item.callId)}
              onReject={(reason) => props.onReject(item.callId, reason)}
            />
          );
        }
        if (item.kind === "error") {
          return (
            <article className="error-card" key={item.key}>
              <strong>任务失败</strong>
              <p>{item.text}</p>
              {item.code === "MISSING_API_KEY" ? (
                <p>请打开右上角设置，保存 API Key 后重试。</p>
              ) : null}
            </article>
          );
        }
        return (
          <article className="notice-card" key={item.key}>
            {item.text}
          </article>
        );
      })}
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [liveEvents, setLiveEvents] = useState<TaskEventRecord[]>([]);
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(
    () => localStorage.getItem("plex.model") ?? "gpt-6-astra",
  );
  const [submitting, setSubmitting] = useState(false);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const refreshTasks = useCallback(async () => {
    const next = await sidecar.listTasks();
    setTasks(next);
    return next;
  }, []);

  const loadDetail = useCallback(async (taskId: string) => {
    const next = await sidecar.getTask(taskId);
    if (selectedRef.current === taskId) {
      setDetail(next);
    }
    return next;
  }, []);

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
        return;
      }
      if (
        event.type === "task.completed" ||
        event.type === "task.failed" ||
        event.type === "task.cancelled"
      ) {
        void refreshTasks();
        if (selectedRef.current === event.taskId) {
          void loadDetail(event.taskId);
        }
      }
    });

    void (async () => {
      try {
        await sidecar.connect();
        setConnected(true);
        setStatus(await sidecar.status());
        const next = await refreshTasks();
        if (next[0]) {
          setSelectedId(next[0].id);
        }
      } catch (connectError) {
        setError(
          connectError instanceof Error
            ? connectError.message
            : String(connectError),
        );
      }
    })();

    return () => {
      unsubscribe();
    };
  }, [loadDetail, refreshTasks]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
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
    if (workspace.trim().length === 0) {
      setError("请选择工作目录");
      return;
    }
    if (prompt.trim().length === 0) {
      setError("请描述任务目标");
      return;
    }
    setSubmitting(true);
    try {
      localStorage.setItem("plex.model", model.trim());
      const taskId = await sidecar.startTask({
        workspace: workspace.trim(),
        prompt: prompt.trim(),
        model: model.trim() || undefined,
      });
      setSelectedId(taskId);
      setPrompt("");
      await refreshTasks();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    } finally {
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

  const saveApiKey = async () => {
    setSavingKey(true);
    setError(null);
    try {
      await sidecar.saveApiKey(apiKeyInput);
      setApiKeyInput("");
      setStatus(await sidecar.status());
      setSettingsOpen(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSavingKey(false);
    }
  };

  const deleteApiKey = async () => {
    setSavingKey(true);
    try {
      await sidecar.deleteApiKey();
      setStatus(await sidecar.status());
    } finally {
      setSavingKey(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <strong>Plex</strong>
            <span>本地桌面 Agent</span>
          </div>
        </div>

        <button
          className="new-task-button"
          onClick={() => {
            setSelectedId(null);
            setDetail(null);
          }}
        >
          ＋ 新建任务
        </button>

        <div className="task-list">
          {tasks.length === 0 ? (
            <p className="sidebar-empty">还没有任务记录</p>
          ) : (
            tasks.map((task) => (
              <button
                key={task.id}
                className={`task-item ${task.id === selectedId ? "is-active" : ""}`}
                onClick={() => setSelectedId(task.id)}
              >
                <span className="task-title">{task.title}</span>
                <span className="task-meta">
                  <span className={statusClass(task.status)}>
                    {STATUS_LABELS[task.status]}
                  </span>
                  <span>{formatTime(task.updatedAt)}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <span className={`dot ${connected ? "dot-online" : ""}`} />
          <span>{connected ? "Sidecar 已连接" : "Sidecar 未连接"}</span>
          <button className="text-button" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <h1>{currentTask ? currentTask.title : "新建任务"}</h1>
            <p>
              {currentTask
                ? currentTask.workspace
                : "选择工作目录并描述目标，Plex 会连续执行并交付结果"}
            </p>
          </div>
          <div className="topbar-actions">
            {currentTask ? (
              <span className={statusClass(currentTask.status)}>
                {STATUS_LABELS[currentTask.status]}
              </span>
            ) : null}
            {active ? (
              <button className="ghost danger-text" onClick={() => void cancel()}>
                取消任务
              </button>
            ) : null}
            <button className="ghost" onClick={() => setSettingsOpen(true)}>
              设置
            </button>
          </div>
        </header>

        {error ? (
          <div className="global-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>关闭</button>
          </div>
        ) : null}

        {!currentTask ? (
          <section className="composer">
            <label>
              工作目录
              <div className="workspace-row">
                <input
                  value={workspace}
                  onChange={(event) => setWorkspace(event.target.value)}
                  placeholder="/Users/you/project"
                />
                <button className="ghost" onClick={() => void pickWorkspace()}>
                  选择目录
                </button>
              </div>
            </label>
            <label>
              任务目标
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="例如：阅读这个目录里的资料，整理一份项目概览和待办清单，写入 summary.md"
                rows={6}
              />
            </label>
            <label>
              模型
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="gpt-6-astra"
              />
            </label>
            <div className="composer-footer">
              <p>
                首版提供文本文件读取、搜索与审批后写入。工具执行记录会保存在本机
                SQLite 中。
              </p>
              <button
                className="primary large"
                disabled={submitting}
                onClick={() => void submitTask()}
              >
                {submitting ? "正在创建…" : "开始任务"}
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="task-summary">
              <span>目录：{workspaceName(currentTask.workspace)}</span>
              <span>模型：{currentTask.model}</span>
              <span>创建：{formatTime(currentTask.createdAt)}</span>
            </section>
            <section className="conversation">
              <Timeline
                items={timeline}
                taskId={currentTask.id}
                onApprove={approve}
                onReject={reject}
              />
            </section>
          </>
        )}
      </main>

      {settingsOpen ? (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section
            className="settings-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2>设置</h2>
                <p>API Key 保存到 macOS 钥匙串，不写入会话记录。</p>
              </div>
              <button className="ghost" onClick={() => setSettingsOpen(false)}>
                关闭
              </button>
            </header>

            <label>
              OpenAI API Key
              <div className="workspace-row">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(event) => setApiKeyInput(event.target.value)}
                  placeholder={
                    status?.apiKeyConfigured ? "已配置，输入可覆盖" : "sk-…"
                  }
                />
                <button
                  className="primary"
                  disabled={savingKey || apiKeyInput.trim().length === 0}
                  onClick={() => void saveApiKey()}
                >
                  保存
                </button>
              </div>
            </label>

            <div className="settings-state">
              <span>
                API Key：{status?.apiKeyConfigured ? "已配置" : "未配置"}
              </span>
              <span>Sidecar：{status?.running ? "运行中" : "未运行"}</span>
            </div>

            <details className="settings-details">
              <summary>诊断信息</summary>
              <p>数据库：{status?.databasePath}</p>
              <p>Sidecar 命令：{status?.sidecarCommand}</p>
              {logs.length > 0 ? (
                <pre>{logs.slice(-12).join("\n")}</pre>
              ) : null}
            </details>

            <footer>
              <button
                className="ghost danger-text"
                disabled={savingKey || !status?.apiKeyConfigured}
                onClick={() => void deleteApiKey()}
              >
                删除钥匙串中的 Key
              </button>
              <button
                className="ghost"
                onClick={() => {
                  void sidecar.restartSidecar().then(() =>
                    sidecar.status().then(setStatus),
                  );
                }}
              >
                重启 Sidecar
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
