import { useMemo, useState } from "react";
import type {
  CatalogProvider,
  CustomProviderConfig,
  CustomProviderModel,
} from "../catalog";
import type { Theme } from "../theme";

export interface ProviderKeyState {
  configured: boolean;
  source: string | null;
}

interface CustomDraft {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: CustomProviderModel[];
  selected: string[];
}

function emptyDraft(): CustomDraft {
  return {
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    models: [],
    selected: [],
  };
}

function sourceLabel(source: string | null): string {
  switch (source) {
    case "environment":
      return "环境变量";
    case "keychain":
      return "钥匙串";
    case "local":
      return "本地服务";
    default:
      return "未配置";
  }
}

export function ProviderSettings(props: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  providersOpen: boolean;
  onProvidersOpenChange: (open: boolean) => void;
  providers: CatalogProvider[];
  customProviders: CustomProviderConfig[];
  keyStates: Record<string, ProviderKeyState>;
  catalogSource: string;
  fetchedAtUnix: number;
  onSave: (providerId: string, key: string) => Promise<void>;
  onDelete: (providerId: string) => Promise<void>;
  onSaveCustom: (
    provider: CustomProviderConfig,
  ) => Promise<CustomProviderConfig>;
  onDeleteCustom: (providerId: string) => Promise<void>;
  onFetchModels: (input: {
    baseUrl: string;
    providerId?: string;
    apiKey?: string;
  }) => Promise<CustomProviderModel[]>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomDraft | null>(null);
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState("");

  const configuredCount = props.providers.filter(
    (provider) => props.keyStates[provider.id]?.configured,
  ).length;
  const supportedCount = props.providers.filter(
    (provider) => provider.supported,
  ).length;

  const providers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered =
      needle.length === 0
        ? props.providers
        : props.providers.filter(
            (provider) =>
              provider.name.toLocaleLowerCase().includes(needle) ||
              provider.id.toLocaleLowerCase().includes(needle),
          );
    return filtered.slice(0, 160);
  }, [props.providers, query]);

  const save = async (providerId: string) => {
    if (draft.trim().length === 0) {
      return;
    }
    setBusy(providerId);
    try {
      await props.onSave(providerId, draft);
      setDraft("");
      setEditing(null);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (providerId: string) => {
    setBusy(providerId);
    try {
      await props.onDelete(providerId);
    } finally {
      setBusy(null);
    }
  };

  const openNewCustom = () => {
    setCustomDraft(emptyDraft());
    setCustomError(null);
    setManualModel("");
  };

  const openEditCustom = (provider: CustomProviderConfig) => {
    setCustomDraft({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: "",
      models: provider.models,
      selected: provider.models.map((model) => model.id),
    });
    setCustomError(null);
    setManualModel("");
  };

  const fetchModels = async () => {
    if (!customDraft) {
      return;
    }
    if (customDraft.baseUrl.trim().length === 0) {
      setCustomError("请先填写 Base URL");
      return;
    }
    setCustomBusy(true);
    setCustomError(null);
    try {
      const models = await props.onFetchModels({
        baseUrl: customDraft.baseUrl.trim(),
        providerId: customDraft.id || undefined,
        apiKey: customDraft.apiKey.trim() || undefined,
      });
      setCustomDraft((current) =>
        current
          ? {
              ...current,
              models,
              selected: models.map((model) => model.id),
            }
          : current,
      );
    } catch (fetchError) {
      setCustomError(
        fetchError instanceof Error
          ? fetchError.message
          : String(fetchError),
      );
    } finally {
      setCustomBusy(false);
    }
  };

  const toggleModel = (modelId: string) => {
    setCustomDraft((current) => {
      if (!current) {
        return current;
      }
      const selected = current.selected.includes(modelId)
        ? current.selected.filter((id) => id !== modelId)
        : [...current.selected, modelId];
      return { ...current, selected };
    });
  };

  const addManualModel = () => {
    const id = manualModel.trim();
    if (!id || !customDraft) {
      return;
    }
    setCustomDraft((current) => {
      if (!current) {
        return current;
      }
      const models = current.models.some((model) => model.id === id)
        ? current.models
        : [...current.models, { id, name: id }];
      const selected = current.selected.includes(id)
        ? current.selected
        : [...current.selected, id];
      return { ...current, models, selected };
    });
    setManualModel("");
  };

  const saveCustom = async () => {
    if (!customDraft) {
      return;
    }
    const models = customDraft.models.filter((model) =>
      customDraft.selected.includes(model.id),
    );
    if (customDraft.name.trim().length === 0) {
      setCustomError("请填写供应商名称");
      return;
    }
    if (customDraft.baseUrl.trim().length === 0) {
      setCustomError("请填写 Base URL");
      return;
    }
    if (models.length === 0) {
      setCustomError("请至少选择一个模型");
      return;
    }

    setCustomBusy(true);
    setCustomError(null);
    try {
      const saved = await props.onSaveCustom({
        id: customDraft.id,
        name: customDraft.name.trim(),
        baseUrl: customDraft.baseUrl.trim().replace(/\/+$/, ""),
        apiStyle: "chat_completions",
        models,
      });
      if (customDraft.apiKey.trim().length > 0) {
        await props.onSave(saved.id, customDraft.apiKey.trim());
      }
      setCustomDraft(null);
    } catch (saveError) {
      setCustomError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setCustomBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <section
        className="settings-modal codex-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>模型供应商</h2>
            <p>
              models.dev 目录与自定义 OpenAI-compatible 服务。Key
              保存在 macOS 钥匙串。
            </p>
          </div>
          <button className="ghost" onClick={props.onClose}>
            关闭
          </button>
        </header>

        <section className="theme-settings">
          <div>
            <strong>外观</strong>
            <p>默认使用白色主题，可以随时切换为黑色。</p>
          </div>
          <div className="theme-options">
            <button
              className={props.theme === "light" ? "is-active" : ""}
              onClick={() => props.onThemeChange("light")}
            >
              白色
            </button>
            <button
              className={props.theme === "dark" ? "is-active" : ""}
              onClick={() => props.onThemeChange("dark")}
            >
              黑色
            </button>
          </div>
        </section>

        <section
          className="provider-settings-row is-clickable"
          role="button"
          tabIndex={0}
          onClick={() =>
            props.onProvidersOpenChange(!props.providersOpen)
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onProvidersOpenChange(!props.providersOpen);
            }
          }}
        >
          <div>
            <strong>供应商</strong>
            <p>
              {configuredCount} 个已配置 · {supportedCount} 个可用
              {props.customProviders.length > 0
                ? ` · ${props.customProviders.length} 个自定义`
                : ""}
            </p>
          </div>
          <span className="ghost small">
            {props.providersOpen ? "收起" : "管理"}
          </span>
        </section>

        {props.providersOpen ? (
          <>
            <div className="settings-toolbar">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索供应商"
              />
              <span className="catalog-meta">
                {props.catalogSource === "network" ? "已更新" : "本地缓存"}
                {props.fetchedAtUnix > 0
                  ? ` · ${new Date(props.fetchedAtUnix * 1000).toLocaleString("zh-CN")}`
                  : ""}
              </span>
              <button className="ghost" onClick={() => void props.onRefresh()}>
                刷新目录
              </button>
              <button className="primary" onClick={openNewCustom}>
                ＋ 自定义供应商
              </button>
            </div>

            {customDraft ? (
              <section className="custom-provider-form">
            <header>
              <strong>
                {customDraft.id ? "编辑自定义供应商" : "添加自定义供应商"}
              </strong>
              <button
                className="ghost small"
                onClick={() => setCustomDraft(null)}
              >
                收起
              </button>
            </header>

            <div className="custom-form-grid">
              <label>
                名称
                <input
                  value={customDraft.name}
                  onChange={(event) =>
                    setCustomDraft((current) =>
                      current
                        ? { ...current, name: event.target.value }
                        : current,
                    )
                  }
                  placeholder="例如：公司网关"
                />
              </label>
              <label>
                Base URL
                <input
                  value={customDraft.baseUrl}
                  onChange={(event) =>
                    setCustomDraft((current) =>
                      current
                        ? { ...current, baseUrl: event.target.value }
                        : current,
                    )
                  }
                  placeholder="https://gateway.example.com/v1"
                />
              </label>
              <label className="custom-key-field">
                API Key
                <input
                  type="password"
                  value={customDraft.apiKey}
                  onChange={(event) =>
                    setCustomDraft((current) =>
                      current
                        ? { ...current, apiKey: event.target.value }
                        : current,
                    )
                  }
                  placeholder={
                    customDraft.id ? "留空则保持现有 Key" : "sk-..."
                  }
                />
              </label>
            </div>

            <div className="custom-form-actions">
              <button
                className="ghost"
                disabled={customBusy}
                onClick={() => void fetchModels()}
              >
                {customBusy ? "正在拉取…" : "拉取模型列表"}
              </button>
              <span className="custom-hint">
                调用 {"{Base URL}"}/models，使用 Bearer Key
              </span>
            </div>

            {customError ? (
              <p className="custom-error">{customError}</p>
            ) : null}

            {customDraft.models.length > 0 ? (
              <div className="custom-models">
                <div className="custom-models-header">
                  <span>模型列表</span>
                  <span>
                    已选 {customDraft.selected.length} /{" "}
                    {customDraft.models.length}
                  </span>
                </div>
                <div className="custom-model-list">
                  {customDraft.models.map((model) => (
                    <label key={model.id} className="custom-model-item">
                      <input
                        type="checkbox"
                        checked={customDraft.selected.includes(model.id)}
                        onChange={() => toggleModel(model.id)}
                      />
                      <span className="custom-model-name">
                        {model.name ?? model.id}
                      </span>
                      <span className="custom-model-id">{model.id}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <p className="custom-hint">
                拉取模型列表后可以选择需要开放的模型。部分服务不提供 /models
                接口，可以手动添加模型 ID。
              </p>
            )}

            <div className="custom-manual-row">
              <input
                value={manualModel}
                onChange={(event) => setManualModel(event.target.value)}
                placeholder="手动添加模型 ID"
              />
              <button className="ghost small" onClick={addManualModel}>
                添加
              </button>
              <button
                className="primary"
                disabled={customBusy}
                onClick={() => void saveCustom()}
              >
                保存供应商
              </button>
            </div>
              </section>
            ) : null}

            <div className="provider-list">
              {providers.map((provider) => {
            const keyState = props.keyStates[provider.id];
            const configured = keyState?.configured ?? false;
            const isEditing = editing === provider.id;
            const customConfig = props.customProviders.find(
              (item) => item.id === provider.id,
            );
            return (
              <article
                key={provider.id}
                className={`provider-row ${
                  provider.supported ? "" : "is-disabled"
                }`}
              >
                <div className="provider-row-main">
                  <div>
                    <strong>
                      {provider.name}
                      {provider.source === "custom" ? (
                        <span className="provider-badge">自定义</span>
                      ) : null}
                    </strong>
                    <p>
                      {provider.supported
                        ? `${provider.models.length} 个可用模型 · ${
                            provider.apiStyle === "responses"
                              ? "Responses"
                              : "Chat Completions"
                          }${provider.baseUrl ? ` · ${provider.baseUrl}` : ""}`
                        : provider.reason}
                    </p>
                  </div>
                  <div className="provider-row-actions">
                    <span
                      className={`key-state ${
                        configured ? "is-configured" : ""
                      }`}
                    >
                      {keyState ? sourceLabel(keyState.source) : "未检查"}
                    </span>
                    {provider.supported ? (
                      <>
                        <button
                          className="ghost small"
                          onClick={() => {
                            setEditing(isEditing ? null : provider.id);
                            setDraft("");
                          }}
                        >
                          {isEditing
                            ? "取消"
                            : configured
                              ? "更新 Key"
                              : "配置 Key"}
                        </button>
                        {configured && keyState?.source === "keychain" ? (
                          <button
                            className="ghost small danger-text"
                            disabled={busy === provider.id}
                            onClick={() => void remove(provider.id)}
                          >
                            删除 Key
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    {customConfig ? (
                      <>
                        <button
                          className="ghost small"
                          onClick={() => openEditCustom(customConfig)}
                        >
                          编辑
                        </button>
                        <button
                          className="ghost small danger-text"
                          disabled={busy === provider.id}
                          onClick={() => {
                            setBusy(provider.id);
                            void props
                              .onDeleteCustom(provider.id)
                              .finally(() => setBusy(null));
                          }}
                        >
                          删除
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>

                {isEditing ? (
                  <div className="provider-key-editor">
                    <input
                      type="password"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder={
                        provider.env[0]
                          ? `API Key（也可设置 ${provider.env[0]}）`
                          : "API Key"
                      }
                      autoFocus
                    />
                    <button
                      className="primary"
                      disabled={busy === provider.id || draft.trim().length === 0}
                      onClick={() => void save(provider.id)}
                    >
                      保存
                    </button>
                  </div>
                ) : null}
              </article>
            );
              })}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
