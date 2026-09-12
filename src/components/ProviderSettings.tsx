import { useMemo, useState } from "react";
import type { CatalogProvider } from "../catalog";

export interface ProviderKeyState {
  configured: boolean;
  source: string | null;
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
  providers: CatalogProvider[];
  keyStates: Record<string, ProviderKeyState>;
  catalogSource: string;
  fetchedAtUnix: number;
  onSave: (providerId: string, key: string) => Promise<void>;
  onDelete: (providerId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

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
              Key 保存在 macOS 钥匙串。目录来自 models.dev，支持 OpenAI
              及 OpenAI-compatible 接口。
            </p>
          </div>
          <button className="ghost" onClick={props.onClose}>
            关闭
          </button>
        </header>

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
          <button
            className="ghost"
            onClick={() => void props.onRefresh()}
          >
            刷新目录
          </button>
        </div>

        <div className="provider-list">
          {providers.map((provider) => {
            const keyState = props.keyStates[provider.id];
            const configured = keyState?.configured ?? false;
            const isEditing = editing === provider.id;
            return (
              <article
                key={provider.id}
                className={`provider-row ${
                  provider.supported ? "" : "is-disabled"
                }`}
              >
                <div className="provider-row-main">
                  <div>
                    <strong>{provider.name}</strong>
                    <p>
                      {provider.supported
                        ? `${provider.models.length} 个可用模型 · ${
                            provider.apiStyle === "responses"
                              ? "Responses"
                              : "Chat Completions"
                          }`
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
                          {isEditing ? "取消" : configured ? "更新 Key" : "配置 Key"}
                        </button>
                        {configured && keyState?.source === "keychain" ? (
                          <button
                            className="ghost small danger-text"
                            disabled={busy === provider.id}
                            onClick={() => void remove(provider.id)}
                          >
                            删除
                          </button>
                        ) : null}
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
      </section>
    </div>
  );
}
