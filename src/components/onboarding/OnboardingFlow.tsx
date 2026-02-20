"use client";

import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { open } from "@tauri-apps/plugin-dialog";
import { selectVault, setApiKey, reindex } from "@/lib/tauri";
import { Check } from "lucide-react";
import Select from "@/components/ui/Select";
import MeldLogo from "@/components/ui/MeldLogo";
import { setupEventListeners } from "@/lib/events";

type Step = "welcome" | "folder" | "apikey" | "indexing" | "ready";

export default function OnboardingFlow() {
  const [step, setStep] = useState<Step>("welcome");
  const [folderPath, setFolderPath] = useState("");
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKeyValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const store = useAppStore();

  async function handleSelectFolder() {
    if (!folderPath.trim()) return;
    setError(null);

    try {
      const info = await selectVault(folderPath.trim());
      store.setVaultPath(info.path, info.file_count);
      setStep("apikey");
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSetApiKey() {
    if (!apiKey.trim()) return;
    setError(null);

    try {
      await setApiKey(provider, apiKey.trim());
      setStep("indexing");
      await setupEventListeners();
      store.setIndexing(true);
      await reindex();
      setStep("ready");
    } catch (e) {
      setError(String(e));
      setStep("apikey");
    }
  }

  function handleFinish() {
    store.setOnboarded(true);
  }

  return (
    <div className="relative flex items-center justify-center h-full w-full bg-transparent">
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
  );
}
