import { useMemo, useState } from "react";
import {
  defaultEffort,
  findModel,
  findProvider,
  type CatalogProvider,
} from "../catalog";
import type { ProviderKeyState } from "./ProviderSettings";

export interface ModelSelection {
  providerId: string;
  modelId: string;
  effort: string | null;
}

function formatContext(tokens: number | null): string {
  if (!tokens) {
    return "";
  }
  if (tokens >= 1_000_000) {
    return `${Math.round(tokens / 100_000) / 10}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

export function ModelPicker(props: {
  providers: CatalogProvider[];
  keyStates: Record<string, ProviderKeyState>;
  value: ModelSelection | null;
  onChange: (value: ModelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [providerQuery, setProviderQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");

  const selectableProviders = useMemo(
    () =>
      props.providers.filter(
        (provider) =>
          provider.supported &&
          (provider.source === "custom" ||
            props.keyStates[provider.id]?.configured === true),
      ),
    [props.providers, props.keyStates],
  );

  const selectedProviderCandidate = findProvider(
    props.providers,
    props.value?.providerId ?? "",
  );
  const selectedProvider = selectedProviderCandidate && selectableProviders.some(
    (provider) => provider.id === selectedProviderCandidate.id,
  )
    ? selectedProviderCandidate
    : undefined;
  const selectedModel = findModel(
    selectedProvider,
    props.value?.modelId ?? "",
  );

  const activeProviderId =
    selectedProvider?.id ?? selectableProviders[0]?.id ?? "";
  const activeProvider = findProvider(props.providers, activeProviderId);

  const filteredProviders = useMemo(() => {
    const query = providerQuery.trim().toLocaleLowerCase();
    if (query.length === 0) {
      return selectableProviders.slice(0, 120);
    }
    return selectableProviders
      .filter(
        (provider) =>
          provider.name.toLocaleLowerCase().includes(query) ||
          provider.id.toLocaleLowerCase().includes(query),
      )
      .slice(0, 120);
  }, [selectableProviders, providerQuery]);

  const filteredModels = useMemo(() => {
    if (!activeProvider) {
      return [];
    }
    const query = modelQuery.trim().toLocaleLowerCase();
    const models =
      query.length === 0
        ? activeProvider.models
        : activeProvider.models.filter(
            (model) =>
              model.name.toLocaleLowerCase().includes(query) ||
              model.id.toLocaleLowerCase().includes(query),
          );
    return models.slice(0, 300);
  }, [activeProvider, modelQuery]);

  const chooseProvider = (provider: CatalogProvider) => {
    if (!provider.supported) {
      return;
    }
    const model = provider.models[0];
    if (!model) {
      return;
    }
    props.onChange({
      providerId: provider.id,
      modelId: model.id,
      effort: defaultEffort(model.efforts),
    });
    setModelQuery("");
  };

  const chooseModel = (modelId: string) => {
    if (!activeProvider) {
      return;
    }
    const model = findModel(activeProvider, modelId);
    props.onChange({
      providerId: activeProvider.id,
      modelId,
      effort: defaultEffort(model?.efforts ?? []),
    });
    setOpen(false);
  };

  return (
    <div className="model-picker">
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        {selectedProvider && selectedModel ? (
          <>
            <span className="picker-provider">{selectedProvider.name}</span>
            <span className="picker-model">{selectedModel.name}</span>
            {props.value?.effort ? (
              <span className="picker-effort">{props.value.effort}</span>
            ) : null}
          </>
        ) : (
          <span className="picker-placeholder">
            {selectableProviders.length > 0 ? "选择模型" : "请先配置供应商"}
          </span>
        )}
        <span className="picker-chevron">⌄</span>
      </button>

      {open ? (
        <>
          <div className="picker-backdrop" onClick={() => setOpen(false)} />
          <div className="picker-popover">
            <div className="picker-column picker-column-providers">
              <input
                className="picker-search"
                value={providerQuery}
                onChange={(event) => setProviderQuery(event.target.value)}
                placeholder="搜索供应商"
                autoFocus
              />
              <div className="picker-list">
                {filteredProviders.map((provider) => (
                  <button
                    type="button"
                    key={provider.id}
                    className={`picker-provider-item ${
                      provider.id === activeProviderId ? "is-active" : ""
                    } ${provider.supported ? "" : "is-disabled"}`}
                    onClick={() => chooseProvider(provider)}
                    title={provider.reason ?? provider.id}
                  >
                    <span>{provider.name}</span>
                    <span className="picker-count">
                      {provider.supported
                        ? provider.models.length
                        : "不可用"}
                    </span>
                  </button>
                ))}
                {filteredProviders.length === 0 ? (
                  <p className="picker-empty">
                    {selectableProviders.length === 0
                      ? "请先在设置中配置 API Key"
                      : "没有匹配的供应商"}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="picker-column picker-column-models">
              <input
                className="picker-search"
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={
                  activeProvider
                    ? `搜索 ${activeProvider.name} 模型`
                    : "搜索模型"
                }
              />
              <div className="picker-list">
                {filteredModels.map((model) => (
                  <button
                    type="button"
                    key={model.id}
                    className={`picker-model-item ${
                      model.id === props.value?.modelId &&
                      activeProvider?.id === props.value?.providerId
                        ? "is-active"
                        : ""
                    }`}
                    onClick={() => chooseModel(model.id)}
                  >
                    <span className="picker-model-name">{model.name}</span>
                    <span className="picker-model-meta">
                      {formatContext(model.context)
                        ? `${formatContext(model.context)} ctx`
                        : model.id}
                    </span>
                  </button>
                ))}
                {filteredModels.length === 0 ? (
                  <p className="picker-empty">
                    {activeProvider?.supported
                      ? "没有匹配的模型"
                      : activeProvider?.reason ?? "该供应商暂不支持"}
                  </p>
                ) : null}
              </div>

              {selectedModel && selectedModel.efforts.length > 0 ? (
                <div className="effort-row">
                  <span className="effort-label">思考强度</span>
                  <div className="effort-options">
                    {selectedModel.efforts.map((effort) => (
                      <button
                        type="button"
                        key={effort}
                        className={
                          props.value?.effort === effort ? "is-active" : ""
                        }
                        onClick={() =>
                          props.onChange({
                            providerId: selectedProvider?.id ?? "",
                            modelId: selectedModel.id,
                            effort,
                          })
                        }
                      >
                        {effort}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
