"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getConfig,
  reindex,
  selectVault,
  setApiKey,
  setEmbeddingModel,
  setModel,
  type Config,
} from "@/lib/tauri";
import { Check, FolderOpen } from "lucide-react";
import Select from "@/components/ui/Select";
import MeldLogo from "@/components/ui/MeldLogo";
import WindowControls from "@/components/ui/WindowControls";
import { setupEventListeners } from "@/lib/events";

type Step = "welcome" | "folder" | "apikey" | "indexing" | "ready";

const DEFAULT_CHAT_MODELS: Record<string, string> = {
  openai: "gpt-5.2",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-3.1-pro-preview",
  openrouter: "qwen/qwen3-235b-a22b-thinking-2507",
};

const DEFAULT_EMBEDDING_MODELS: Record<string, string> = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
};

const LLM_PROVIDER_PRIORITY = ["google", "openai", "anthropic", "openrouter"];
const EMBEDDING_PROVIDER_PRIORITY = ["google", "openai"];

const LEGACY_PROVIDER_KEY_FIELDS: Partial<Record<string, keyof Config>> = {
  openai: "openai_api_key",
  anthropic: "anthropic_api_key",
  google: "google_api_key",
};

const EMBEDDING_KEY_REQUIRED_MESSAGE =
  "Add an OpenAI or Google API key for embeddings before indexing.";

function uniqueNonEmpty(values: string[]): string[] {
  const unique: string[] = [];
  for (const raw of values) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized || unique.includes(normalized)) continue;
    unique.push(normalized);
  }
  return unique;
}

function providerHasCredential(config: Config, provider: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) return false;

  if (config.auth_modes?.[normalizedProvider] === "oauth") {
    const oauthTokens = config.oauth_tokens as Record<string, unknown> | undefined;
    return Boolean(oauthTokens?.[normalizedProvider]);
  }

  const keyFromMap = config.api_keys?.[normalizedProvider];
  const legacyField = LEGACY_PROVIDER_KEY_FIELDS[normalizedProvider];
  const legacyValue =
    legacyField && typeof config[legacyField] === "string"
      ? config[legacyField]
      : null;
  const resolved = keyFromMap ?? legacyValue;
  return typeof resolved === "string" && resolved.trim().length > 0;
}

function hasAnyLlmCredential(config: Config): boolean {
  return LLM_PROVIDER_PRIORITY.some((provider) =>
    providerHasCredential(config, provider),
  );
}

function hasAnyEmbeddingCredential(config: Config): boolean {
  return EMBEDDING_PROVIDER_PRIORITY.some((provider) =>
    providerHasCredential(config, provider),
  );
}

async function alignModelProviders(
  config: Config,
  preferredProvider?: string,
): Promise<void> {
  const preferred = preferredProvider?.trim().toLowerCase() ?? "";
  const currentChatProvider = (
    config.chat_provider?.trim().toLowerCase() || "openai"
  );
  const chatCandidates = uniqueNonEmpty([
    preferred,
    currentChatProvider,
    ...LLM_PROVIDER_PRIORITY,
  ]);
  const resolvedChatProvider = chatCandidates.find((provider) =>
    providerHasCredential(config, provider),
  );
  if (
    resolvedChatProvider &&
    resolvedChatProvider !== currentChatProvider &&
    DEFAULT_CHAT_MODELS[resolvedChatProvider]
  ) {
    await setModel(resolvedChatProvider, DEFAULT_CHAT_MODELS[resolvedChatProvider]);
  }

  const currentEmbeddingProvider = (
    config.embedding_provider?.trim().toLowerCase() || "openai"
  );
  const embeddingCandidates = uniqueNonEmpty([
    preferred,
    currentEmbeddingProvider,
    ...EMBEDDING_PROVIDER_PRIORITY,
  ]);
  const resolvedEmbeddingProvider = embeddingCandidates.find(
    (provider) =>
      Boolean(DEFAULT_EMBEDDING_MODELS[provider]) &&
      providerHasCredential(config, provider),
  );
  if (
    resolvedEmbeddingProvider &&
    resolvedEmbeddingProvider !== currentEmbeddingProvider
  ) {
    await setEmbeddingModel(
      resolvedEmbeddingProvider,
      DEFAULT_EMBEDDING_MODELS[resolvedEmbeddingProvider],
    );
  }
}

export default function OnboardingFlow() {
  const [step, setStep] = useState<Step>("welcome");
  const [folderPath, setFolderPath] = useState("");
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKeyValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recentVaults, setRecentVaults] = useState<string[]>([]);

  const store = useAppStore();

  useEffect(() => {
    void getConfig().then((config) => {
      const vaults = config.recent_vaults ?? [];
      setRecentVaults(vaults);
    });
  }, []);

  async function runInitialIndexing() {
    setStep("indexing");
    await setupEventListeners();
    store.setIndexing(true);
    try {
      await reindex();
      setStep("ready");
    } finally {
      store.setIndexing(false);
    }
  }

  async function connectVault(path: string) {
    setError(null);
    try {
      const info = await selectVault(path.trim());
      store.setVaultPath(info.path, info.file_count);
      const config = await getConfig();
      if (hasAnyLlmCredential(config)) {
        if (!hasAnyEmbeddingCredential(config)) {
          setStep("apikey");
          setError(EMBEDDING_KEY_REQUIRED_MESSAGE);
          return;
        }
        await alignModelProviders(config);
        try {
          await runInitialIndexing();
        } catch (error) {
          setStep("folder");
          throw error;
        }
      } else {
        setStep("apikey");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSelectFolder() {
    if (!folderPath.trim()) return;
    await connectVault(folderPath);
  }

  async function handleSetApiKey() {
    if (!apiKey.trim()) return;
    setError(null);

    try {
      await setApiKey(provider, apiKey.trim());
      const config = await getConfig();
      await alignModelProviders(config, provider);
      if (!hasAnyEmbeddingCredential(config)) {
        setError(EMBEDDING_KEY_REQUIRED_MESSAGE);
        setStep("apikey");
        return;
      }
      await runInitialIndexing();
    } catch (e) {
      setError(String(e));
      setStep("apikey");
    }
  }

  function handleFinish() {
    store.setOnboarded(true);
  }

  const vaultBaseName = (path: string): string => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized.split("/").pop() ?? path;
  };

  return (
    <div className="relative flex h-full w-full rounded-[28px] bg-bg border border-overlay-6 overflow-hidden">
      {/* Window controls */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between min-h-[44px]">
        <div data-tauri-drag-region className="absolute inset-0" />
        <div className="relative z-10">
          <WindowControls placement="left" />
        </div>
        <div className="relative z-10 mr-2">
          <WindowControls placement="right" />
        </div>
      </div>
      <div className="relative flex flex-1 items-center justify-center">
        {/* Drag surface — behind interactive content */}
        <div data-tauri-drag-region className="absolute inset-0" />
        <div className="relative z-10 w-full max-w-md p-8 space-y-8">
        {step === "welcome" && (
          <div className="space-y-6 text-center">
            <MeldLogo size={64} className="mx-auto rounded-2xl" />
            <h1 className="font-display text-3xl italic text-accent">meld</h1>
            <p className="text-text-secondary">
              Your personal AI agent with a shared knowledge base.
              Point it at your notes and start a conversation.
            </p>
            <button
              onClick={() => setStep("folder")}
              className="w-full py-3 px-6 bg-accent text-bg font-medium rounded-2xl hover:opacity-90 transition-opacity"
            >
              Get Started
            </button>
          </div>
        )}

        {step === "folder" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Select Your Vault</h2>
            <p className="text-text-secondary text-sm">
              Choose the folder containing your markdown notes.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="/path/to/your/notes"
                className="flex-1 p-3 bg-bg-secondary border border-border/50 rounded-xl text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_1px_var(--color-border-focus)]"
              />
              <button
                type="button"
                onClick={async () => {
                  const selected = await open({ directory: true, multiple: false });
                  if (selected) setFolderPath(selected);
                }}
                className="px-4 py-3 bg-bg-secondary border border-overlay-6 rounded-xl text-text-muted hover:text-text hover:border-overlay-10 transition-colors whitespace-nowrap"
              >
                Browse
              </button>
            </div>
            {error && <p className="text-error text-sm">{error}</p>}
            <button
              onClick={handleSelectFolder}
              disabled={!folderPath.trim()}
              className="w-full py-3 px-6 bg-accent text-bg font-medium rounded-2xl hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              Continue
            </button>

            {recentVaults.length > 0 && (
              <div className="pt-2 space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted/70">
                  Recent vaults
                </p>
                <div className="space-y-1">
                  {recentVaults.map((vault) => (
                    <button
                      key={vault}
                      type="button"
                      onClick={() => void connectVault(vault)}
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg-secondary group"
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-text-muted group-hover:text-accent/70" strokeWidth={1.5} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-text truncate">{vaultBaseName(vault)}</p>
                        <p className="text-[11px] text-text-muted truncate">{vault}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === "apikey" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">API Key</h2>
            <p className="text-text-secondary text-sm">
              meld uses your own API key. Choose a provider and enter your key.
            </p>
            <Select
              value={provider}
              onChange={setProvider}
              options={[
                { value: "openai", label: "OpenAI" },
                { value: "anthropic", label: "Anthropic" },
                { value: "google", label: "Google" },
              ]}
            />
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKeyValue(e.target.value)}
              placeholder="sk-..."
              className="w-full p-3 bg-bg-secondary border border-border/50 rounded-xl text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_1px_var(--color-border-focus)]"
            />
            {error && <p className="text-error text-sm">{error}</p>}
            <button
              onClick={handleSetApiKey}
              disabled={!apiKey.trim()}
              className="w-full py-3 px-6 bg-accent text-bg font-medium rounded-2xl hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              Start Indexing
            </button>
          </div>
        )}

        {step === "indexing" && (
          <div className="space-y-4 text-center">
            <h2 className="text-xl font-semibold">Indexing Your Notes</h2>
            {store.indexProgress ? (
              <>
                <div className="w-full bg-bg-tertiary rounded-full h-2">
                  <div
                    className="bg-accent h-2 rounded-full transition-all duration-300"
                    style={{
                      width: `${(store.indexProgress.current / store.indexProgress.total) * 100}%`,
                    }}
                  />
                </div>
                <p className="text-text-secondary text-sm">
                  {store.indexProgress.current} / {store.indexProgress.total}
                </p>
                <p className="text-text-muted text-xs truncate">
                  {store.indexProgress.file}
                </p>
              </>
            ) : (
              <div className="flex justify-center">
                <div className="w-8 h-8 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
        )}

        {step === "ready" && (
          <div className="space-y-6 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[20px] bg-success/10 border border-success/20">
              <Check className="h-6 w-6 text-success" strokeWidth={2.5} />
            </div>
            <h2 className="text-xl font-semibold">Ready</h2>
            <p className="text-text-secondary">
              {store.fileCount} notes indexed. Start chatting with your knowledge base.
            </p>
            <button
              onClick={handleFinish}
              className="w-full py-3 px-6 bg-accent text-bg font-medium rounded-2xl hover:opacity-90 transition-opacity"
            >
              Open meld
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
