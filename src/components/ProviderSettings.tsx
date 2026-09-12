import { useMemo, useState } from "react";
import type {
  CatalogProvider,
  CustomProviderConfig,
  CustomProviderModel,
} from "../catalog";
import type { Theme } from "../theme";
import type { SkillRecord } from "../types";

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

interface SkillDraft {
  skillId: string;
  content: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function skillFileKindLabel(kind: SkillRecord["files"][number]["kind"]): string {
  switch (kind) {
    case "entrypoint": return "入口";
    case "agent": return "Agent 配置";
    case "script": return "脚本";
    case "reference": return "参考资料";
    case "asset": return "素材";
    default: return "资源";
  }
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
  catalogLoading: boolean;
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
  skills: SkillRecord[];
  onImportSkill: () => Promise<void>;
  onToggleSkill: (skillId: string, enabled: boolean) => Promise<void>;
  onUpdateSkill: (input: SkillDraft) => Promise<void>;
  onDeleteSkill: (skillId: string) => Promise<void>;
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
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);

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

  const toggleSkill = async (skill: SkillRecord) => {
    setSkillBusy(skill.id);
    try {
      await props.onToggleSkill(skill.id, !skill.enabled);
    } finally {
      setSkillBusy(null);
    }
  };

  const openSkillEditor = (skill: SkillRecord) => {
    setSkillDraft({
      skillId: skill.id,
      content: skill.content,
    });
    setSkillError(null);
  };

  const saveSkill = async () => {
    if (!skillDraft) return;
    if (!skillDraft.content.trim()) {
      setSkillError("SKILL.md 不能为空");
      return;
    }
    setSkillBusy(skillDraft.skillId);
    setSkillError(null);
    try {
      await props.onUpdateSkill({
        ...skillDraft,
      });
      setSkillDraft(null);
    } catch (error) {
      setSkillError(error instanceof Error ? error.message : String(error));
    } finally {
      setSkillBusy(null);
    }
  };

  const deleteSkill = async (skill: SkillRecord) => {
    setSkillBusy(skill.id);
    try {
      await props.onDeleteSkill(skill.id);
    } finally {
      setSkillBusy(null);
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
            <h2>设置</h2>
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

        <section className="skill-settings">
          <div className="skill-settings-heading">
            <div>
              <strong>技能</strong>
              <p>导入完整 Skill 目录。根目录需要包含 SKILL.md，附属资源会保留并供 Agent 按需读取。</p>
            </div>
            <button className="ghost" onClick={() => void props.onImportSkill()}>
              ＋ 导入 Skill 目录
            </button>
          </div>
          {props.skills.length > 0 ? (
            <div className="skill-list">
              {props.skills.map((skill) => (
                <article className={`skill-row ${skill.enabled ? "is-enabled" : ""}`} key={skill.id}>
                  <div className="skill-row-main">
                    <div className="skill-title-line">
                      <strong>{skill.name}</strong>
                      <span className="skill-state">{skill.enabled ? "已启用" : "已停用"}</span>
                    </div>
                    <p>{skill.description || "未提供说明"}</p>
                    <div className="skill-resource-summary">
                      <span>{skill.entrypoint}</span>
                      <span>{Math.max(0, skill.files.length - 1)} 个附属文件</span>
                      <span>{formatBytes(skill.totalBytes)}</span>
                    </div>
                    {skill.files.length > 1 ? (
                      <details className="skill-resource-list">
                        <summary>查看目录文件</summary>
                        <ul>
                          {skill.files.map((file) => (
                            <li key={file.path}>
                              <span>{file.path}</span>
                              <small>{skillFileKindLabel(file.kind)} · {formatBytes(file.bytes)}</small>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                  <div className="skill-row-actions">
                    <button
                      className="ghost small"
                      disabled={skillBusy === skill.id}
                      onClick={() => openSkillEditor(skill)}
                    >
                      编辑
                    </button>
                    <button
                      className="ghost small"
                      disabled={skillBusy === skill.id}
                      onClick={() => void toggleSkill(skill)}
                    >
                      {skill.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      className="ghost small danger-text"
                      disabled={skillBusy === skill.id}
                      onClick={() => void deleteSkill(skill)}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="skill-empty">还没有 Skill。请选择一个根目录含 SKILL.md 的完整 Skill 文件夹。</p>
          )}
        </section>

        {skillDraft ? (
          <section className="skill-editor" aria-label="编辑 Skill">
            <header className="skill-editor-header">
              <div>
                <strong>编辑 Skill</strong>
                <p>名称和说明来自 YAML frontmatter。附属资源保持原目录结构。</p>
              </div>
              <button className="ghost small" onClick={() => setSkillDraft(null)}>
                取消
              </button>
            </header>
            <label className="skill-content-field">
              SKILL.md
              <textarea
                value={skillDraft.content}
                onChange={(event) => setSkillDraft({ ...skillDraft, content: event.target.value })}
                spellCheck={false}
                rows={12}
              />
            </label>
            {skillError ? <p className="skill-editor-error">{skillError}</p> : null}
            <div className="skill-editor-actions">
              <span>入口最大 256 KB；保存时会校验 name 和 description</span>
            <button className="primary" disabled={skillBusy === skillDraft.skillId} onClick={() => void saveSkill()}>
                {skillBusy === skillDraft.skillId ? "保存中…" : "保存 Skill"}
              </button>
            </div>
          </section>
        ) : null}

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
                {props.catalogLoading
                  ? "正在加载目录"
                  : props.catalogSource === "network"
                    ? "已更新"
                    : "本地缓存"}
                {props.fetchedAtUnix > 0
                  ? ` · ${new Date(props.fetchedAtUnix * 1000).toLocaleString("zh-CN")}`
                  : ""}
              </span>
              <button
                className="ghost"
                disabled={props.catalogLoading}
                onClick={() => void props.onRefresh()}
              >
                {props.catalogLoading ? "正在加载…" : "刷新目录"}
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
