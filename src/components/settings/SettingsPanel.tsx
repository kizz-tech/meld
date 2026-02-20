"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { X } from "lucide-react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-dialog";
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
  setSearchProvider,
  setSearxngBaseUrl,
  reindex,
  selectVault,
  openDevtools,
  type ProviderCatalogEntry,
} from "@/lib/tauri";

const KNOWN_MODELS: Record<string, ComboOption[]> = {
  openai: [
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-5.1", label: "GPT-5.1" },
    { value: "gpt-5", label: "GPT-5" },
    { value: "gpt-5-nano", label: "GPT-5 Nano" },
  ],
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  google: [
    { value: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
  ],
  openrouter: [
    { value: "deepseek/deepseek-r1-0528:free", label: "DeepSeek R1", badge: "Free" },
    { value: "qwen/qwen3-coder:free", label: "Qwen3 Coder", badge: "Free" },
    { value: "qwen/qwen3-235b-a22b-thinking-2507", label: "Qwen3 235B Thinking", badge: "Free" },
    { value: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B", badge: "Free" },
    { value: "nousresearch/hermes-3-llama-3.1-405b:free", label: "Hermes 3 405B", badge: "Free" },
    { value: "google/gemma-3-27b-it:free", label: "Gemma 3 27B", badge: "Free" },
    { value: "mistralai/mistral-small-3.1-24b-instruct:free", label: "Mistral Small 3.1", badge: "Free" },
    { value: "nvidia/nemotron-3-nano-30b-a3b:free", label: "Nemotron 3 Nano 30B", badge: "Free" },
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
  { value: "openai:gpt-5-nano", label: "OpenAI GPT-5 Nano" },
  { value: "anthropic:claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { value: "google:gemini-3-flash-preview", label: "Gemini 3 Flash" },
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
  const [searchProviderLocal, setSearchProviderLocal] = useState("tavily");
  const [searxngUrlLocal, setSearxngUrlLocal] = useState("http://localhost:8080");
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
      const msg = e instanceof Error ? e.message : String(e);
      // Network errors or missing release JSON are not real errors
      if (/fetch|network|remote|json|404|not found/i.test(msg)) {
        setUpdateStatus("upToDate");
      } else {
        setUpdateError(msg);
        setUpdateStatus("error");
      }
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
      if (config.search_provider) setSearchProviderLocal(config.search_provider);
      if (config.searxng_base_url) setSearxngUrlLocal(config.searxng_base_url);

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
      { value: "google", label: "Google Gemini" },
      { value: "openrouter", label: "OpenRouter" },
      { value: "ollama", label: "Ollama" },
      { value: "lm_studio", label: "LM Studio" },
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
    <div className="p-6 space-y-8 h-full overflow-y-auto scrollbar-visible max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Settings</h2>
        <button
          onClick={() => store.toggleSettings()}
          className="text-text-muted hover:text-text transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Vault */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text-secondary">Vault</h3>
        <p className="text-xs text-text-muted truncate">{store.vaultPath}</p>
        <p className="text-xs text-text-muted">{store.fileCount} notes</p>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              const selected = await open({ directory: true, multiple: false });
              if (selected) {
                try {
                  const info = await selectVault(selected);
                  store.setVaultPath(info.path, info.file_count);
                } catch (e) {
                  setReindexError(String(e));
                }
              }
            }}
            className="text-xs px-3.5 py-2 border border-white/[0.06] bg-bg-tertiary/60 rounded-xl hover:bg-bg-tertiary hover:border-white/10 transition-colors"
          >
            Change vault
          </button>
          <button
            onClick={handleReindex}
            disabled={store.isIndexing}
            className="text-xs px-3 py-1.5 bg-bg-tertiary/80 rounded-lg hover:bg-border transition-colors disabled:opacity-50"
          >
            {store.isIndexing ? "Indexing..." : "Reindex"}
          </button>
        </div>    
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
          className="w-full p-2 text-sm bg-white/[0.03] border border-border/50 rounded-xl text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:bg-bg focus:shadow-[0_0_0_1px_var(--color-border-focus)]"
        />
      </section>

      {/* Web Search */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Web Search</h3>
        <ComboSelect
          value={searchProviderLocal}
          options={[
            { value: "tavily", label: "Tavily", badge: "1k free/mo" },
            { value: "searxng", label: "SearXNG", badge: "self-hosted" },
            { value: "brave", label: "Brave Search", badge: "cloud" },
          ]}
          placeholder="Select search provider..."
          onChange={(v) => {
            setSearchProviderLocal(v);
            setSearchProvider(v);
          }}
          allowCustom={false}
        />
        {searchProviderLocal === "searxng" && (
          <div className="space-y-1">
            <label className="text-xs text-text-muted">SearXNG URL</label>
            <input
              type="text"
              value={searxngUrlLocal}
              onChange={(e) => setSearxngUrlLocal(e.target.value)}
              onBlur={() => setSearxngBaseUrl(searxngUrlLocal.trim())}
              placeholder="http://localhost:8080"
              className="w-full p-2 text-sm bg-white/[0.03] border border-border/50 rounded-xl text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:bg-bg focus:shadow-[0_0_0_1px_var(--color-border-focus)]"
            />
            <p className="text-[11px] text-text-muted/70">
              Run locally: docker run -p 8080:8080 searxng/searxng
            </p>
          </div>
        )}
        {searchProviderLocal === "tavily" && (
          <p className="text-[11px] text-text-muted/70">
            Requires Tavily API key below. Free tier: 1,000 searches/month.
          </p>
        )}
        {searchProviderLocal === "brave" && (
          <p className="text-[11px] text-text-muted/70">
            Requires Brave API key below. Sign up at brave.com/search/api
          </p>
        )}
      </section>

      {/* API Keys */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">API Keys</h3>

        {["openai", "anthropic", "google", "openrouter", "tavily", "brave"].map((provider) => (
          <div key={provider} className="space-y-1">
            <label className="text-xs text-text-muted capitalize">
              {provider === "openrouter" ? "OpenRouter" : provider === "brave" ? "Brave Search" : provider}
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
                        : provider === "openrouter"
                          ? "sk-or-..."
                          : provider === "brave"
                            ? "BSA..."
                            : "tvly-..."
                }
                className="flex-1 p-2 text-sm bg-white/[0.03] border border-border/50 rounded-xl text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:bg-bg focus:shadow-[0_0_0_1px_var(--color-border-focus)]"
              />
              <button
                onClick={() =>
                  handleSaveKey(provider, apiKeys[provider] ?? "")
                }
                className="px-3 text-xs border border-white/[0.06] bg-bg-tertiary/60 rounded-xl hover:bg-bg-tertiary hover:border-white/10 transition-colors"
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
              className="text-xs px-3.5 py-2 border border-white/[0.06] bg-bg-tertiary/60 rounded-xl hover:bg-bg-tertiary hover:border-white/10 transition-colors"
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
                className="text-xs px-3.5 py-2 border border-white/[0.06] bg-bg-tertiary/60 rounded-xl hover:bg-bg-tertiary hover:border-white/10 transition-colors"
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
                className="text-xs px-3.5 py-2 border border-white/[0.06] bg-bg-tertiary/60 rounded-xl hover:bg-bg-tertiary hover:border-white/10 transition-colors"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Developer */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text-secondary">Developer</h3>
        <button
          onClick={() => void openDevtools()}
          className="text-xs px-3 py-1.5 bg-bg-tertiary/80 rounded-lg hover:bg-border transition-colors"
        >
          Open DevTools
        </button>
      </section>
    </div>
  );
}
