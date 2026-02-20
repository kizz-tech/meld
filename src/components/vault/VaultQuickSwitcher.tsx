"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FolderOpen, Loader2 } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { getConfig, reindex, selectVault, setEmbeddingModel } from "@/lib/tauri";
import { setupEventListeners } from "@/lib/events";
import {
  DEFAULT_EMBEDDING_MODELS,
  resolveEmbeddingProviderForIndexing,
} from "@/lib/providerCredentials";
import { buildIndexingDisabledToast, buildReindexErrorToast } from "@/lib/chatErrors";

interface VaultQuickSwitcherProps {
  vaultName: string;
  onManageVaults: () => void;
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function vaultBaseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() ?? path;
}

function pickTopVaults(paths: string[]): string[] {
  const unique: string[] = [];
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    if (!normalized) continue;
    if (unique.some((item) => normalizeVaultPath(item) === normalized)) continue;
    unique.push(path);
    if (unique.length >= 4) break;
  }
  return unique;
}

export default function VaultQuickSwitcher({
  vaultName,
  onManageVaults,
}: VaultQuickSwitcherProps) {
  const vaultPath = useAppStore((state) => state.vaultPath);
  const setVaultPath = useAppStore((state) => state.setVaultPath);
  const setOnboarded = useAppStore((state) => state.setOnboarded);
  const setEmbeddingProvider = useAppStore((state) => state.setEmbeddingProvider);
  const setIndexing = useAppStore((state) => state.setIndexing);
  const showToast = useAppStore((state) => state.showToast);

  const [open, setOpen] = useState(false);
  const [loadingVaults, setLoadingVaults] = useState(false);
  const [switchingPath, setSwitchingPath] = useState<string | null>(null);
  const [recentVaults, setRecentVaults] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const visibleVaults = useMemo(() => pickTopVaults(recentVaults), [recentVaults]);
  const isSwitching = switchingPath !== null;
  const normalizedCurrentVault = useMemo(
    () => (vaultPath ? normalizeVaultPath(vaultPath) : ""),
    [vaultPath],
  );

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setMenuPosition({
      left: rect.left,
      top: rect.bottom + 6,
    });
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  const refreshVaults = useCallback(async () => {
    setLoadingVaults(true);
    try {
      const config = await getConfig();
      setRecentVaults(config.recent_vaults ?? []);
    } catch {
      setRecentVaults([]);
    } finally {
      setLoadingVaults(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshVaults();
    updateMenuPosition();
  }, [open, refreshVaults, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      const insideTrigger = rootRef.current?.contains(event.target);
      const insideMenu = menuRef.current?.contains(event.target);
      if (!insideTrigger && !insideMenu) {
        setOpen(false);
        setError(null);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setError(null);
      }
    };

    const onResizeOrScroll = () => {
      updateMenuPosition();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResizeOrScroll);
    window.addEventListener("scroll", onResizeOrScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, true);
    };
  }, [open, updateMenuPosition]);

  const switchVault = async (path: string) => {
    const target = path.trim();
    if (!target) return;
    if (normalizeVaultPath(target) === normalizedCurrentVault) {
      setOpen(false);
      return;
    }

    setError(null);
    setSwitchingPath(target);
    try {
      const info = await selectVault(target);
      setVaultPath(info.path, info.file_count);
      setOnboarded(true);
      await setupEventListeners();

      const config = await getConfig();
      const resolvedEmbeddingProvider = resolveEmbeddingProviderForIndexing(config);
      const currentEmbeddingProvider =
        config.embedding_provider?.trim().toLowerCase() || "openai";
      if (!resolvedEmbeddingProvider) {
        setOpen(false);
        void refreshVaults();
        const toast = buildIndexingDisabledToast();
        showToast(toast.message, toast.options);
        return;
      }
      if (resolvedEmbeddingProvider !== currentEmbeddingProvider) {
        await setEmbeddingModel(
          resolvedEmbeddingProvider,
          DEFAULT_EMBEDDING_MODELS[resolvedEmbeddingProvider],
        );
        setEmbeddingProvider(resolvedEmbeddingProvider);
      }

      setOpen(false);
      void refreshVaults();
      showToast(`Vault switched to ${vaultBaseName(info.path)}`);

      // Reindex in background so vault switch stays responsive.
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
    } catch (switchError) {
      const message = `Failed to switch vault: ${
        switchError instanceof Error ? switchError.message : String(switchError)
      }`;
      setError(message);
      showToast(message);
    } finally {
      setSwitchingPath(null);
    }
  };

  return (
    <div ref={rootRef} className="no-drag relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={isSwitching}
        onClick={() => {
          setOpen((prev) => {
            const next = !prev;
            if (next) {
              updateMenuPosition();
            }
            return next;
          });
          setError(null);
        }}
        className="ml-1 inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-overlay-6 bg-overlay-3/70 px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-all hover:border-overlay-10 hover:bg-overlay-8 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
        title="Quick vault switcher"
      >
        <span className="truncate">{vaultName || "No Vault"}</span>
        {isSwitching ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted" />
        ) : (
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-200 ${
              open ? "rotate-180" : ""
            }`}
          />
        )}
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            ref={menuRef}
            className="no-drag animate-fade-in fixed z-[260] w-[286px] rounded-[20px] border border-overlay-8 bg-bg-secondary/95 p-2 shadow-xl shadow-black/35 backdrop-blur-md"
            style={{
              left: `${menuPosition.left}px`,
              top: `${menuPosition.top}px`,
            }}
          >
            {loadingVaults ? (
              <p className="px-2 py-2 text-xs text-text-muted">Loading vaults...</p>
            ) : visibleVaults.length === 0 ? (
              <p className="px-2 py-2 text-xs text-text-muted">No recent vaults.</p>
            ) : (
              <div className="space-y-1">
                {visibleVaults.map((vault) => {
                  const normalizedVault = normalizeVaultPath(vault);
                  const isCurrent = normalizedVault === normalizedCurrentVault;
                  const isSwitching = switchingPath
                    ? normalizeVaultPath(switchingPath) === normalizedVault
                    : false;
                  return (
                    <button
                      key={vault}
                      type="button"
                      disabled={Boolean(switchingPath) || isCurrent}
                      onClick={() => void switchVault(vault)}
                      className="group flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-left transition-colors hover:bg-overlay-6 disabled:cursor-not-allowed disabled:opacity-60"
                      title={vault}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-text-muted group-hover:text-accent/70" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] text-text">{vaultBaseName(vault)}</p>
                        <p className="truncate text-[10px] text-text-muted">{vault}</p>
                      </div>
                      {isCurrent ? (
                        <span className="rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-success">
                          current
                        </span>
                      ) : isSwitching ? (
                        <span className="text-[9px] uppercase tracking-wide text-text-muted">
                          opening
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}

            {error && <p className="px-2 pt-2 text-xs text-error">{error}</p>}

            <div className="mt-1.5 border-t border-overlay-6 pt-1.5">
                <button
                  type="button"
                  disabled={isSwitching}
                  onClick={() => {
                    setOpen(false);
                    onManageVaults();
                  }}
                  className="w-full rounded-full border border-overlay-6 bg-bg px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:border-overlay-10 hover:bg-overlay-5 hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Manage vaults...
                </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
