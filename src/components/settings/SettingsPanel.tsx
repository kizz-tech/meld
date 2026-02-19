"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "@/lib/store";
import ComboSelect, { type ComboOption } from "@/components/ui/ComboSelect";
import {
  getConfig,
  getProviderCatalog,
  setApiKey,
  setModel,
  setEmbeddingModel,
  setFallbackModel,
  setUserLanguage,
  reindex,
  type ProviderCatalogEntry,
} from "@/lib/tauri";

const KNOWN_MODELS: Record<string, ComboOption[]> = {
  openai: [
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-4.1", label: "GPT-4.1" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
    { value: "o3", label: "o3" },
    { value: "o4-mini", label: "o4 Mini" },
  ],
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  google: [
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
    { value: "gemini-2.5-pro-preview-05-06", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash" },
  ],
};

const KNOWN_EMBEDDING_MODELS: Record<string, ComboOption[]> = {
  openai: [
    { value: "text-embedding-3-small", label: "text-embedding-3-small" },
    { value: "text-embedding-3-large", label: "text-embedding-3-large" },
  ],
  google: [
    { value: "gemini-embedding-001", label: "gemini-embedding-001" },
  ],
};

const FALLBACK_OPTIONS: ComboOption[] = [
  { value: "", label: "None (disabled)" },
  { value: "openai:gpt-4.1-mini", label: "OpenAI GPT-4.1 Mini" },
  { value: "openai:gpt-4.1-nano", label: "OpenAI GPT-4.1 Nano" },
  { value: "anthropic:claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { value: "google:gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash" },
];

export default function SettingsPanel() {
  const store = useAppStore();
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>([]);
  const [apiKeys, setApiKeysState] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [fallbackModelId, setFallbackModelIdLocal] = useState("");
  const [embeddingProvider, setEmbeddingProviderLocal] = useState("");
  const [embeddingModelId, setEmbeddingModelIdLocal] = useState("");
  const [userLanguage, setUserLanguageLocal] = useState("");
  const [reindexError, setReindexError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "downloading" | "upToDate" | "error"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const handleCheckUpdate = useCallback(async () => {
    setUpdateStatus("checking");
    setUpdateError(null);
    try {
      const update = await check();
      if (update) {
        setUpdateInfo(update);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("upToDate");
      }
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdateStatus("error");
    }
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    if (!updateInfo) return;
    setUpdateStatus("downloading");
    setDownloadProgress(0);
    try {
      let totalBytes = 0;
      let downloadedBytes = 0;
      await updateInfo.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            setDownloadProgress(Math.round((downloadedBytes / totalBytes) * 100));
          }
        }
      });
      await relaunch();
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdateStatus("error");
    }
  }, [updateInfo]);

  useEffect(() => {
    getConfig().then((config) => {
      if (config.chat_provider) store.setChatProvider(config.chat_provider);
      if (config.chat_model) store.setChatModel(config.chat_model);
      if (config.embedding_provider) {
        store.setEmbeddingProvider(config.embedding_provider);
        setEmbeddingProviderLocal(config.embedding_provider);
      }
      if (config.embedding_model_id)
        setEmbeddingModelIdLocal(config.embedding_model_id);
      if (config.fallback_chat_model_id)
        setFallbackModelIdLocal(config.fallback_chat_model_id);
      if (config.user_language) setUserLanguageLocal(config.user_language);

      const keys: Record<string, string> = {};
      if (config.openai_api_key) keys.openai = config.openai_api_key;
      if (config.anthropic_api_key) keys.anthropic = config.anthropic_api_key;
      if (config.google_api_key) keys.google = config.google_api_key;
      if (config.tavily_api_key) keys.tavily = config.tavily_api_key;
      if (config.api_keys) Object.assign(keys, config.api_keys);
      setApiKeysState(keys);
    });

    getProviderCatalog()
      .then(setProviders)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveKey(provider: string, key: string) {
    await setApiKey(provider, key);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleReindex() {
    store.setIndexing(true);
    setReindexError(null);
    try {
      await reindex();
    } catch (e) {
      console.error("Reindex failed:", e);
      setReindexError(
        `Reindex failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    store.setIndexing(false);
  }

  const llmProviders = providers.filter((p) => p.supports_llm);
  const embeddingProviders = providers.filter((p) => p.supports_embeddings);

  const providerOptions: ComboOption[] = useMemo(() => {
    if (llmProviders.length > 0) {
      return llmProviders.map((p) => ({ value: p.id, label: p.display_name }));
    }
    return [
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
      { value: "google", label: "Google" },
    ];
  }, [llmProviders]);

  const embeddingProviderOptions: ComboOption[] = useMemo(() => {
    if (embeddingProviders.length > 0) {
      return embeddingProviders.map((p) => ({
        value: p.id,
        label: p.display_name,
      }));
    }
    return [
      { value: "openai", label: "OpenAI" },
      { value: "google", label: "Google" },
    ];
  }, [embeddingProviders]);

  const modelOptions = useMemo(
    () => KNOWN_MODELS[store.chatProvider] ?? [],
    [store.chatProvider],
  );

  const embeddingModelOptions = useMemo(
    () => KNOWN_EMBEDDING_MODELS[embeddingProvider] ?? [],
    [embeddingProvider],
  );

  return (
    <div className="p-6 space-y-8 h-full overflow-y-auto max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Settings</h2>
        <button
          onClick={() => store.toggleSettings()}
          className="text-text-muted hover:text-text transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>

      {/* Vault */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text-secondary">Vault</h3>
        <p className="text-xs text-text-muted truncate">{store.vaultPath}</p>
        <p className="text-xs text-text-muted">{store.fileCount} notes</p>
        <button
          onClick={handleReindex}
          disabled={store.isIndexing}
          className="text-xs px-3 py-1.5 bg-bg-tertiary/80 rounded-lg hover:bg-border transition-colors disabled:opacity-50"
        >
          {store.isIndexing ? "Indexing..." : "Reindex"}
        </button>    
        {reindexError && (
          <p className="text-error text-xs mt-2">
            {reindexError}
          </p>
        )}
      </section>

      {/* Chat Model */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text-secondary">Chat Model</h3>
        <label className="text-xs text-text-muted">Provider</label>
        <ComboSelect
          value={store.chatProvider}
          options={providerOptions}
          placeholder="Select provider..."
          onChange={(val) => {
            store.setChatProvider(val);
            setModel(val, store.chatModel);
          }}
        />
        <label className="text-xs text-text-muted">Model</label>
        <ComboSelect
          value={store.chatModel}
          options={modelOptions}
          placeholder="Select or type model name..."
          onChange={(val) => {
            store.setChatModel(val);
            setModel(store.chatProvider, val);
          }}
        />
      </section>

      {/* Fallback Model */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text-secondary">
          Fallback Model
        </h3>
        <ComboSelect
          value={fallbackModelId}
          options={FALLBACK_OPTIONS}
          placeholder="provider:model (optional)"
          onChange={(val) => {
            setFallbackModelIdLocal(val);
            setFallbackModel(val || undefined);
          }}
        />
      </section>

      {/* Embedding Model */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text-secondary">
          Embedding Model
        </h3>
        <label className="text-xs text-text-muted">Provider</label>
        <ComboSelect
          value={embeddingProvider}
          options={embeddingProviderOptions}
          placeholder="Select provider..."
          onChange={(val) => {
            setEmbeddingProviderLocal(val);
            store.setEmbeddingProvider(val);
            const defaultModel =
              KNOWN_EMBEDDING_MODELS[val]?.[0]?.value ?? "";
            if (defaultModel) {
              setEmbeddingModelIdLocal(defaultModel);
              setEmbeddingModel(val, defaultModel);
            }
          }}
        />
        <label className="text-xs text-text-muted">Model</label>
        <ComboSelect
          value={embeddingModelId}
          options={embeddingModelOptions}
          placeholder="Select or type model name..."
          onChange={(val) => {
            setEmbeddingModelIdLocal(val);
            setEmbeddingModel(embeddingProvider, val);
          }}
        />
      </section>

      {/* Language */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text-secondary">Language</h3>
        <input
          type="text"
          value={userLanguage}
          onChange={(e) => setUserLanguageLocal(e.target.value)}
          onBlur={() => {
            if (userLanguage.trim()) setUserLanguage(userLanguage.trim());
          }}
          placeholder="auto (follows system)"
          className="w-full p-2 text-sm bg-bg border border-transparent rounded-xl text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_1px_var(--color-border-focus)]"
        />
      </section>

      {/* API Keys */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">API Keys</h3>

        {["openai", "anthropic", "google", "tavily"].map((provider) => (
          <div key={provider} className="space-y-1">
            <label className="text-xs text-text-muted capitalize">
              {provider}
            </label>
            <div className="flex gap-1">
              <input
                type="password"
                value={apiKeys[provider] ?? ""}
                onChange={(e) =>
                  setApiKeysState((prev) => ({
                    ...prev,
                    [provider]: e.target.value,
                  }))
                }
                placeholder={
                  provider === "openai"
                    ? "sk-..."
                    : provider === "anthropic"
                      ? "sk-ant-..."
                      : provider === "google"
                        ? "AIza..."
                        : "tvly-..."
                }
                className="flex-1 p-2 text-sm bg-bg border border-transparent rounded-xl text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_1px_var(--color-border-focus)]"
              />
              <button
                onClick={() =>
                  handleSaveKey(provider, apiKeys[provider] ?? "")
                }
                className="px-2.5 text-xs bg-bg-tertiary/80 rounded-lg hover:bg-border transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        ))}

        {saved && <p className="text-xs text-success">Saved</p>}
      </section>

      {/* Updates */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text-secondary">Updates</h3>
        <div className="flex items-center gap-2">
          {updateStatus === "idle" && (
            <button
              onClick={handleCheckUpdate}
              className="text-xs px-3 py-1.5 bg-bg-tertiary/80 rounded-lg hover:bg-border transition-colors"
            >
              Check for updates
            </button>
          )}
          {updateStatus === "checking" && (
            <p className="text-xs text-text-muted">Checking for updates...</p>
          )}
          {updateStatus === "upToDate" && (
            <p className="text-xs text-text-muted">You&apos;re on the latest version.</p>
          )}
          {updateStatus === "available" && updateInfo && (
            <div className="space-y-1">
              <p className="text-xs text-text">
                Update available: <span className="font-medium">{updateInfo.version}</span>
              </p>
              <button
                onClick={handleInstallUpdate}
                className="text-xs px-3 py-1.5 bg-bg-tertiary/80 rounded-lg hover:bg-border transition-colors"
              >
                Download &amp; install
              </button>
            </div>
          )}
          {updateStatus === "downloading" && (
            <p className="text-xs text-text-muted">
              Downloading...{downloadProgress !== null ? ` ${downloadProgress}%` : ""}
            </p>
          )}
          {updateStatus === "error" && (
            <div className="space-y-1">
              <p className="text-xs text-error">{updateError}</p>
              <button
                onClick={handleCheckUpdate}
                className="text-xs px-3 py-1.5 bg-bg-tertiary/80 rounded-lg hover:bg-border transition-colors"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
