"use client";

import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertCircle, ArrowLeft, FolderOpen } from "lucide-react";
import { getConfig, reindex, selectVault, setEmbeddingModel } from "@/lib/tauri";
import { useAppStore } from "@/lib/store";
import { setupEventListeners } from "@/lib/events";
import WindowControls from "@/components/ui/WindowControls";
import MeldLogo from "@/components/ui/MeldLogo";
import {
  DEFAULT_EMBEDDING_MODELS,
  resolveEmbeddingProviderForIndexing,
} from "@/lib/providerCredentials";
import { buildIndexingDisabledToast, buildReindexErrorToast } from "@/lib/chatErrors";

interface VaultSwitcherScreenProps {
  onClose: () => void;
  canClose?: boolean;
}

function vaultBaseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() ?? path;
}

export default function VaultSwitcherScreen({
  onClose,
  canClose = true,
}: VaultSwitcherScreenProps) {
  const currentVaultPath = useAppStore((state) => state.vaultPath);
  const setVaultPath = useAppStore((state) => state.setVaultPath);
  const setOnboarded = useAppStore((state) => state.setOnboarded);
  const setEmbeddingProvider = useAppStore((state) => state.setEmbeddingProvider);
  const setIndexing = useAppStore((state) => state.setIndexing);
  const showToast = useAppStore((state) => state.showToast);

  const [folderPath, setFolderPath] = useState("");
  const [recentVaults, setRecentVaults] = useState<string[]>([]);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getConfig()
      .then((config) => {
        if (cancelled) return;
        setRecentVaults(config.recent_vaults ?? []);
        if (config.vault_path) {
          setFolderPath(config.vault_path);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const normalizedCurrentVault = useMemo(
    () =>
      currentVaultPath
        ?.replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase() ?? "",
    [currentVaultPath],
  );

  const connectVault = async (path: string) => {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      setError("Vault path is required");
      return;
    }

    setError(null);
    setIsSwitching(true);
    let shouldClose = false;
    try {
      const info = await selectVault(normalizedPath);
      setVaultPath(info.path, info.file_count);
      setFolderPath(info.path);

      await setupEventListeners();
      const config = await getConfig();
      const resolvedEmbeddingProvider = resolveEmbeddingProviderForIndexing(config);
      const currentEmbeddingProvider =
        config.embedding_provider?.trim().toLowerCase() || "openai";
      if (!resolvedEmbeddingProvider) {
        setRecentVaults(config.recent_vaults ?? []);
        setOnboarded(true);
        const toast = buildIndexingDisabledToast();
        showToast(toast.message, toast.options);
        shouldClose = true;
        return;
      }
      if (resolvedEmbeddingProvider !== currentEmbeddingProvider) {
        await setEmbeddingModel(
          resolvedEmbeddingProvider,
          DEFAULT_EMBEDDING_MODELS[resolvedEmbeddingProvider],
        );
        setEmbeddingProvider(resolvedEmbeddingProvider);
      }

      setRecentVaults(config.recent_vaults ?? []);
      setOnboarded(true);
      showToast(`Vault switched to ${vaultBaseName(info.path)}`);

      // Reindex in background to keep switching flow snappy.
      setIndexing(true);
      void (async () => {
        try {
          await reindex();
        } catch (indexError) {
          console.error("Background reindex failed after vault switch:", indexError);
          const toast = buildReindexErrorToast(indexError);
          showToast(toast.message, toast.options);
        } finally {
          setIndexing(false);
        }
      })();

      shouldClose = true;
    } catch (switchError) {
      setError(String(switchError));
    } finally {
      setIsSwitching(false);
    }
    if (shouldClose && canClose) {
      onClose();
    }
  };

  return (
    <div className="relative flex h-full w-full rounded-[28px] border border-overlay-6 bg-bg overflow-hidden">
      <div className="absolute top-0 left-0 right-0 z-20 flex min-h-[44px] items-center justify-between">
        <div data-tauri-drag-region className="absolute inset-0" />
        <div className="relative z-10">
          <WindowControls placement="left" />
        </div>
        <div className="relative z-10 mr-2">
          <WindowControls placement="right" />
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center p-8">
        <div data-tauri-drag-region className="absolute inset-0" />
        <div className="relative z-10 w-full max-w-3xl space-y-6">
          <div className="flex items-center justify-between">
            {canClose ? (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-2 rounded-xl border border-overlay-6 bg-bg-secondary px-3 py-2 text-sm text-text-secondary transition-colors hover:border-overlay-10 hover:text-text"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
            ) : (
              <span className="text-xs uppercase tracking-[0.18em] text-text-muted">
                Vault Manager
              </span>
            )}
            <MeldLogo size={32} className="rounded-lg" />
          </div>

          <section className="rounded-2xl border border-overlay-6 bg-bg-secondary/50 p-6">
            <h2 className="text-2xl font-semibold text-text">Vaults</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Switch vaults in the same window. No modal popups.
            </p>

            <div className="mt-4 rounded-xl border border-overlay-6 bg-overlay-2 p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-text-muted">
                Current vault
              </p>
              <p className="mt-1 truncate text-sm text-text">
                {currentVaultPath ?? "No vault selected"}
              </p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <input
                type="text"
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                placeholder="/path/to/your/notes"
                className="min-w-[280px] flex-1 rounded-xl border border-border/50 bg-bg p-3 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_1px_var(--color-border-focus)]"
              />
              <button
                type="button"
                onClick={async () => {
                  const selected = await open({
                    directory: true,
                    multiple: false,
                  });
                  if (selected) {
                    setFolderPath(selected);
                  }
                }}
                disabled={isSwitching}
                className="rounded-xl border border-overlay-6 bg-bg px-4 py-3 text-sm text-text-secondary transition-colors hover:border-overlay-10 hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
              >
                Browse
              </button>
              <button
                type="button"
                onClick={() => void connectVault(folderPath)}
                disabled={!folderPath.trim() || isSwitching}
                className="rounded-xl bg-accent px-4 py-3 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSwitching ? "Opening..." : "Open Vault"}
              </button>
            </div>

            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-overlay-6 bg-bg-secondary/50 p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-text-secondary">Recent vaults</h3>
              <span className="text-xs text-text-muted">{recentVaults.length}</span>
            </div>
            {recentVaults.length === 0 ? (
              <p className="mt-3 text-sm text-text-muted">
                No recent vaults yet. Open one by path or browse.
              </p>
            ) : (
              <div className="mt-3 space-y-1">
                {recentVaults.map((vault) => {
                  const normalizedVault = vault
                    .replace(/\\/g, "/")
                    .replace(/\/+$/, "")
                    .toLowerCase();
                  const isCurrent = normalizedVault === normalizedCurrentVault;
                  return (
                    <button
                      key={vault}
                      type="button"
                      onClick={() => void connectVault(vault)}
                      disabled={isSwitching}
                      className="group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-text-muted group-hover:text-accent/70" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-text">
                          {vaultBaseName(vault)}
                        </p>
                        <p className="truncate text-[11px] text-text-muted">{vault}</p>
                      </div>
                      {isCurrent && (
                        <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-success">
                          current
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
