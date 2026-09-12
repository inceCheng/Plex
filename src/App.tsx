import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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
      case "message.delta":
        streamText += String(data.text ?? "");
        break;
      case "message.completed":
        streamText = "";
        items.push({
          key: `assistant-${event.seq}`,
          kind: "assistant",
          text: String(data.text ?? task?.finalOutput ?? ""),
        });
        break;
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
      case "task.failed":
        items.push({
          key: `failed-${event.seq}`,
          kind: "error",
          text: String(data.error ?? "任务执行失败"),
          code: typeof data.code === "string" ? data.code : null,
        });
        break;
      case "task.cancelled":
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
        <span className="approval-icon">!</span>
        <div>
          <strong>审批写入 · {props.item.toolName}</strong>
          <p>批准后才会写入。审批绑定当前路径和完整内容。</p>
        </div>
        <span className={`decision decision-${props.item.status}`}>
          {pending
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
            className="ghost danger-text"
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
  onApprove: (callId: string) => Promise<void>;
  onReject: (callId: string, reason: string) => Promise<void>;
}) {
  if (props.items.length === 0) {
    return (
      <div className="empty-state">
        <p>任务已创建，等待执行事件。</p>
      </div>
    );
  }

  return (
    <div className="timeline">
      {props.items.map((item) => {
        if (item.kind === "user") {
          return (
            <article className="codex-message codex-message-user" key={item.key}>
              <span className="message-role">你</span>
              <div>{item.text}</div>
            </article>
          );
        }
        if (item.kind === "assistant") {
          return (
            <article
              className="codex-message codex-message-assistant"
              key={item.key}
            >
              <span className="message-role">Plex</span>
              <div>
                {item.text}
                {item.streaming ? <span className="cursor">▍</span> : null}
              </div>
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
                      ? "完成"
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
                <p>请在模型供应商设置中配置对应 Key。</p>
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
  const [theme, setTheme] = useState<Theme>(() =>
    resolveTheme(localStorage.getItem("plex.theme")),
  );
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [liveEvents, setLiveEvents] = useState<TaskEventRecord[]>([]);
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [customProviders, setCustomProviders] = useState<
    CustomProviderConfig[]
  >([]);
  const [keyStates, setKeyStates] = useState<
    Record<string, ProviderKeyState>
  >({});
  const [catalogSource, setCatalogSource] = useState("cache");
  const [fetchedAtUnix, setFetchedAtUnix] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const awaitingTaskRef = useRef(false);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("plex.theme", theme);
  }, [theme]);

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

  const refreshKeyStates = useCallback(
    async (catalog: CatalogProvider[], providerId?: string) => {
      const targets = providerId
        ? catalog.filter((provider) => provider.id === providerId)
        : catalog
            .filter(
              (provider) =>
                provider.source === "custom" || provider.supported,
            )
            .slice(0, 40);
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
    },
    [refreshKeyStates],
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
        await loadCatalog(false);
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
  }, [loadCatalog, loadDetail, refreshTasks]);

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
    const provider = findProvider(providers, selection?.providerId ?? "");
    const model = findModel(provider, selection?.modelId ?? "");
    if (workspace.trim().length === 0) {
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

    setSubmitting(true);
    awaitingTaskRef.current = true;
    window.setTimeout(() => {
      awaitingTaskRef.current = false;
    }, 10_000);
    try {
      await sidecar.startTask({
        prompt: prompt.trim(),
        workspace: workspace.trim(),
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
        setSettingsOpen(true);
      }
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

  const fetchProviderModels = async (input: {
    baseUrl: string;
    providerId?: string;
    apiKey?: string;
  }) => sidecar.fetchProviderModels(input);

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
            <span className="brand-dot" />
            <strong>Plex</strong>
          </div>
          <button
            className="icon-button"
            title="模型供应商设置"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </div>

        <button
          className="new-thread"
          onClick={() => {
            setSelectedId(null);
            setDetail(null);
          }}
        >
          <span>＋</span> 新建任务
        </button>

        <div className="thread-list">
          {tasks.length === 0 ? (
            <p className="sidebar-empty">暂无任务</p>
          ) : (
            tasks.map((task) => (
              <button
                key={task.id}
                className={`thread-item ${
                  task.id === selectedId ? "is-active" : ""
                }`}
                onClick={() => setSelectedId(task.id)}
              >
                <span className="thread-title">{task.title}</span>
                <span className="thread-meta">
                  <span className={statusClass(task.status)}>
                    {STATUS_LABELS[task.status]}
                  </span>
                  <span>{formatTime(task.updatedAt)}</span>
                </span>
              </button>
            ))
          )}
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
              : "未选择模型"}
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
                : "选择目录和模型，描述目标后开始执行"}
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

        {error ? (
          <div className="codex-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>关闭</button>
          </div>
        ) : null}

        <section className="codex-content">
          {currentTask ? (
            <Timeline
              items={timeline}
              onApprove={approve}
              onReject={reject}
            />
          ) : (
            <div className="codex-welcome">
              <h2>开始一个本地任务</h2>
              <p>
                Plex 会列出和读取你选择的目录，按步骤调用工具，并在写入文件前请求审批。
              </p>
              <div className="welcome-hints">
                <span>文本文件读写</span>
                <span>多步工具调用</span>
                <span>写入前 diff 审批</span>
              </div>
            </div>
          )}
        </section>

        {!currentTask ? (
          <footer className="codex-composer">
            <div className="composer-box">
              <div className="composer-workspace">
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
              </div>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="描述你希望 Plex 完成的任务，例如：阅读这个目录里的资料，整理项目概览和待办清单，写入 summary.md"
                rows={4}
              />
              <div className="composer-toolbar">
                <ModelPicker
                  providers={providers}
                  value={selection}
                  onChange={setSelection}
                />
                <button
                  className="send-button"
                  disabled={submitting}
                  onClick={() => void submitTask()}
                  title="开始任务"
                >
                  {submitting ? "…" : "↑"}
                </button>
              </div>
            </div>
            <p className="composer-note">
              读取在授权目录内完成；写入必须审批。模型请求会发送到所选供应商。
            </p>
          </footer>
        ) : null}
      </main>

      {settingsOpen ? (
        <ProviderSettings
          theme={theme}
          onThemeChange={setTheme}
          providers={providers}
          customProviders={customProviders}
          keyStates={keyStates}
          catalogSource={catalogSource}
          fetchedAtUnix={fetchedAtUnix}
          onSave={saveProviderKey}
          onDelete={deleteProviderKey}
          onSaveCustom={saveCustomProvider}
          onDeleteCustom={deleteCustomProvider}
          onFetchModels={fetchProviderModels}
          onRefresh={() => loadCatalog(true)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {logs.length > 0 && !connected ? (
        <div className="log-drawer">
          <pre>{logs.slice(-6).join("\n")}</pre>
        </div>
      ) : null}
    </div>
  );
}
