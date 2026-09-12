import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  SidecarMessage,
  SidecarStatus,
  TaskDetail,
  TaskRecord,
} from "./types";
import type {
  CustomProviderConfig,
  CustomProviderModel,
} from "./catalog";

type MessageHandler = (message: SidecarMessage) => void;

function requestId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class SidecarClient {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();

  private readonly handlers = new Set<MessageHandler>();
  private unlisten: UnlistenFn | null = null;
  private connecting: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.unlisten) {
      return;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        this.unlisten = await listen<SidecarMessage>(
          "sidecar-event",
          (event) => {
            this.handleMessage(event.payload);
          },
        );
        await invoke("sidecar_start");
      })().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  async disconnect(): Promise<void> {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    await invoke("sidecar_stop");
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<T>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): Promise<T> {
    const id = requestId();
    const result = new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sidecar 请求超时：${type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    await invoke("sidecar_send", { request: { id, type, payload } });
    return result;
  }

  async status(): Promise<SidecarStatus> {
    return invoke<SidecarStatus>("sidecar_status");
  }

  async listTasks(): Promise<TaskRecord[]> {
    const payload = await this.request<{ tasks: TaskRecord[] }>("list_tasks");
    return payload.tasks;
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    return this.request<TaskDetail>("get_task", { taskId });
  }

  async startTask(input: {
    prompt: string;
    workspace: string;
    provider: {
      id: string;
      name: string;
      baseUrl: string;
      apiStyle: "responses" | "chat_completions";
      modelId: string;
      reasoningEffort: string | null;
      envNames: string[];
      local: boolean;
    };
  }): Promise<void> {
    await invoke("start_task", { payload: input });
  }

  async modelsCatalog(forceRefresh = false): Promise<{
    source: "network" | "cache";
    fetchedAtUnix: number;
    catalog: unknown;
  }> {
    return invoke("models_catalog", { forceRefresh });
  }

  async providerKeyStatus(
    providers: Array<{
      id: string;
      envNames: string[];
      baseUrl: string | null;
      local: boolean;
    }>,
  ): Promise<
    Array<{ providerId: string; configured: boolean; source: string | null }>
  > {
    return invoke("provider_key_status", { providers });
  }

  async saveProviderKey(providerId: string, key: string): Promise<void> {
    await invoke("save_provider_key", { providerId, key });
  }

  async deleteProviderKey(providerId: string): Promise<void> {
    await invoke("delete_provider_key", { providerId });
  }

  async listCustomProviders(): Promise<CustomProviderConfig[]> {
    return invoke("list_custom_providers");
  }

  async saveCustomProvider(
    provider: CustomProviderConfig,
  ): Promise<CustomProviderConfig> {
    return invoke("save_custom_provider", { provider });
  }

  async deleteCustomProvider(providerId: string): Promise<void> {
    await invoke("delete_custom_provider", { providerId });
  }

  async fetchProviderModels(input: {
    baseUrl: string;
    providerId?: string;
    apiKey?: string;
  }): Promise<CustomProviderModel[]> {
    return invoke("fetch_provider_models", {
      baseUrl: input.baseUrl,
      providerId: input.providerId,
      apiKey: input.apiKey,
    });
  }

  async approve(taskId: string, callId: string): Promise<void> {
    await this.request("approve", { taskId, callId });
  }

  async reject(
    taskId: string,
    callId: string,
    reason: string,
  ): Promise<void> {
    await this.request("reject", { taskId, callId, reason });
  }

  async cancel(taskId: string): Promise<void> {
    await this.request("cancel", { taskId });
  }

  async saveApiKey(key: string): Promise<void> {
    await invoke("save_api_key", { key });
  }

  async deleteApiKey(): Promise<void> {
    await invoke("delete_api_key");
  }

  async restartSidecar(): Promise<void> {
    await invoke("restart_sidecar");
  }

  private handleMessage(message: SidecarMessage): void {
    if (message.type === "response" && message.id) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        window.clearTimeout(pending.timer);
        if (message.ok) {
          pending.resolve(message.payload);
        } else {
          pending.reject(
            new Error(
              message.error?.message ?? "Sidecar 请求执行失败",
            ),
          );
        }
      }
    }
    for (const handler of this.handlers) {
      handler(message);
    }
  }
}

export const sidecar = new SidecarClient();
