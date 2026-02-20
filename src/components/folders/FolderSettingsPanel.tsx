"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { X } from "lucide-react";
import ComboSelect, { type ComboOption } from "@/components/ui/ComboSelect";
import {
  FOLDER_ICON_PRESETS,
  FolderIconGlyph,
  normalizeFolderIconId,
  toStoredFolderIcon,
  type FolderIconId,
} from "@/components/folders/folderIcons";
import {
  getChatFolder,
  getProviderCatalog,
  renameChatFolder,
  updateChatFolder,
  archiveChatFolder,
  getFolderInstructionChain,
  type FolderPayload,
  type ProviderCatalogEntry,
} from "@/lib/tauri";
import {
  KNOWN_CHAT_MODELS,
  buildChatProviderOptions,
  formatModelId,
  parseModelId,
} from "@/lib/chatModelOptions";

interface FolderSettingsPanelProps {
  folderId: string;
  onClose: () => void;
  onFolderArchived: (folderId: string) => void;
  onFolderUpdated?: () => Promise<void> | void;
}

const INSTRUCTION_CHAIN_TIMEOUT_MS = 5000;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return String(error);
}

export default function FolderSettingsPanel({
  folderId,
  onClose,
  onFolderArchived,
  onFolderUpdated,
}: FolderSettingsPanelProps) {
  const [folder, setFolder] = useState<FolderPayload | null>(null);
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>([]);
  const [name, setName] = useState("");
  const [iconId, setIconId] = useState<FolderIconId | null>(null);
  const [instruction, setInstruction] = useState("");
  const [defaultModelProvider, setDefaultModelProvider] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [instructionChain, setInstructionChain] = useState<string[]>([]);
  const [loadingFolder, setLoadingFolder] = useState(true);
  const [loadingInstructionChain, setLoadingInstructionChain] = useState(false);
  const [instructionChainError, setInstructionChainError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isMountedRef = useRef(true);
  const chainRequestIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    void getProviderCatalog()
      .then((entries) => {
        if (!isMountedRef.current) return;
        setProviders(entries);
      })
      .catch(() => {});
  }, []);

  const llmProviders = providers.filter((provider) => provider.supports_llm);
  const providerOptions: ComboOption[] = [
    { value: "", label: "Use global default" },
    ...buildChatProviderOptions(llmProviders),
  ];
  const modelOptions = KNOWN_CHAT_MODELS[defaultModelProvider] ?? [];

  const saveDefaultModelId = useCallback(
    async (provider: string, model: string) => {
      const modelId = formatModelId(provider, model);
      await updateChatFolder(
        folderId,
        folder?.icon ?? null,
        folder?.custom_instruction ?? null,
        modelId,
      );
      if (!isMountedRef.current) return;
      setFolder((prev) => (prev ? { ...prev, default_model_id: modelId } : prev));
      if (onFolderUpdated) {
        try {
          await onFolderUpdated();
        } catch (error) {
          console.error("Failed to refresh folders after default model update:", error);
        }
      }
    },
    [folder?.custom_instruction, folder?.icon, folderId, onFolderUpdated],
  );

  const loadFolder = useCallback(async () => {
    setLoadingFolder(true);
    setLoadError(null);
    try {
      const data = await getChatFolder(folderId);
      if (!isMountedRef.current) return;
      setFolder(data);
      setName(data.name);
      setIconId(normalizeFolderIconId(data.icon));
      setInstruction(data.custom_instruction ?? "");
      const parsedDefaultModel = parseModelId(data.default_model_id);
      setDefaultModelProvider(parsedDefaultModel.provider);
      setDefaultModel(parsedDefaultModel.model);
    } catch (error) {
      console.error("Failed to load folder:", error);
      if (isMountedRef.current) {
        setFolder(null);
        setLoadError(toErrorMessage(error));
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingFolder(false);
      }
    }
  }, [folderId]);

  const loadInstructionChain = useCallback(async () => {
    const requestId = chainRequestIdRef.current + 1;
    chainRequestIdRef.current = requestId;
    setLoadingInstructionChain(true);
    setInstructionChainError(null);

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const chain = await Promise.race([
        getFolderInstructionChain(folderId),
        new Promise<string[]>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error("Timed out while loading instruction chain"));
          }, INSTRUCTION_CHAIN_TIMEOUT_MS);
        }),
      ]);
      if (!isMountedRef.current || chainRequestIdRef.current !== requestId) return;
      setInstructionChain(chain);
    } catch (error) {
      console.warn("Failed to load folder instruction chain:", error);
      if (!isMountedRef.current || chainRequestIdRef.current !== requestId) return;
      setInstructionChain([]);
      setInstructionChainError(toErrorMessage(error));
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (isMountedRef.current && chainRequestIdRef.current === requestId) {
        setLoadingInstructionChain(false);
      }
    }
  }, [folderId]);

  useEffect(() => {
    setInstructionChain([]);
    setInstructionChainError(null);
    void loadFolder();
    void loadInstructionChain();
  }, [loadFolder, loadInstructionChain]);

  const notifyFolderUpdated = useCallback(async () => {
    if (!onFolderUpdated) return;
    try {
      await onFolderUpdated();
    } catch (error) {
      console.error("Failed to refresh folders after update:", error);
    }
  }, [onFolderUpdated]);

  const handleNameBlur = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === folder?.name) return;
    try {
      await renameChatFolder(folderId, trimmed);
      setFolder((prev) => (prev ? { ...prev, name: trimmed } : prev));
      await notifyFolderUpdated();
    } catch (error) {
      console.error("Failed to rename folder:", error);
    }
  }, [folderId, folder?.name, name, notifyFolderUpdated]);

  const handleNameKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      }
    },
    [],
  );

  const handleInstructionChange = useCallback(
    (value: string) => {
      setInstruction(value);
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        const trimmed = value.trim() || null;
        try {
          await updateChatFolder(
            folderId,
            folder?.icon ?? null,
            trimmed,
            folder?.default_model_id ?? null,
          );
          if (!isMountedRef.current) return;
          setFolder((prev) =>
            prev ? { ...prev, custom_instruction: trimmed } : prev,
          );
          void loadInstructionChain();
        } catch (error) {
          console.error("Failed to save instruction:", error);
        }
      }, 800);
    },
    [folderId, folder?.default_model_id, folder?.icon, loadInstructionChain],
  );

  const handleIconSelect = useCallback(
    async (nextIcon: FolderIconId | null) => {
      const storedIcon = toStoredFolderIcon(nextIcon);
      if ((folder?.icon ?? null) === storedIcon) return;

      try {
        await updateChatFolder(
          folderId,
          storedIcon,
          folder?.custom_instruction ?? null,
          folder?.default_model_id ?? null,
        );
        if (!isMountedRef.current) return;

        setIconId(storedIcon);
        setFolder((prev) => (prev ? { ...prev, icon: storedIcon } : prev));
        await notifyFolderUpdated();
      } catch (error) {
        console.error("Failed to update folder icon:", error);
      }
    },
    [
      folder?.custom_instruction,
      folder?.default_model_id,
      folder?.icon,
      folderId,
      notifyFolderUpdated,
    ],
  );

  const handleDefaultModelProviderChange = useCallback(
    async (provider: string) => {
      const normalizedProvider = provider.trim().toLowerCase();
      setDefaultModelProvider(normalizedProvider);

      if (!normalizedProvider) {
        setDefaultModel("");
        try {
          await saveDefaultModelId("", "");
        } catch (error) {
          console.error("Failed to clear folder default model:", error);
        }
        return;
      }

      const suggestedModel = KNOWN_CHAT_MODELS[normalizedProvider]?.[0]?.value ?? "";
      setDefaultModel(suggestedModel);
      try {
        await saveDefaultModelId(normalizedProvider, suggestedModel);
      } catch (error) {
        console.error("Failed to update folder default model provider:", error);
      }
    },
    [saveDefaultModelId],
  );

  const handleDefaultModelChange = useCallback(
    async (model: string) => {
      setDefaultModel(model);
      if (!defaultModelProvider) return;
      try {
        await saveDefaultModelId(defaultModelProvider, model);
      } catch (error) {
        console.error("Failed to update folder default model:", error);
      }
    },
    [defaultModelProvider, saveDefaultModelId],
  );

  const handleArchive = useCallback(async () => {
    try {
      await archiveChatFolder(folderId);
      onFolderArchived(folderId);
      onClose();
    } catch (error) {
      console.error("Failed to archive folder:", error);
    }
  }, [folderId, onClose, onFolderArchived]);

  if (loadingFolder) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
      </div>
    );
  }

  if (!folder) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-sm text-text-muted">
        <p>Folder settings are unavailable.</p>
        {loadError && (
          <p className="max-w-md break-words text-center text-xs text-error/80">
            {loadError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-medium text-text">
          <span>{folder.name}</span>
          {iconId && (
            <FolderIconGlyph icon={iconId} className="h-4 w-4 shrink-0 text-text-secondary" />
          )}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-6">
        {/* Name */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void handleNameBlur()}
            onKeyDown={handleNameKeyDown}
            className="w-full rounded-xl border border-border/40 bg-bg-secondary px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent/50"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">
            Icon
          </label>
          <p className="mb-2 text-[11px] text-text-muted">
            Choose a monochrome icon for this folder, or remove it.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => void handleIconSelect(null)}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                iconId === null
                  ? "border-accent/45 bg-accent/[0.08] text-accent"
                  : "border-border/40 bg-bg-secondary text-text-secondary hover:border-border/60 hover:text-text"
              }`}
            >
              <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate text-left">No icon</span>
            </button>
            {FOLDER_ICON_PRESETS.map((preset) => {
              const selected = iconId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => void handleIconSelect(preset.id)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                    selected
                      ? "border-accent/45 bg-accent/[0.08] text-accent"
                      : "border-border/40 bg-bg-secondary text-text-secondary hover:border-border/60 hover:text-text"
                  }`}
                >
                  <FolderIconGlyph icon={preset.id} className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom instruction */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">
            Custom instruction
          </label>
          <p className="mb-2 text-[11px] text-text-muted">
            Instructions added here are included in the system prompt for all chats in this folder. Parent folder instructions are inherited.
          </p>
          <textarea
            value={instruction}
            onChange={(e) => handleInstructionChange(e.target.value)}
            placeholder="e.g. Always respond in bullet points..."
            rows={5}
            className="w-full resize-y rounded-xl border border-border/40 bg-bg-secondary px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent/50"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">
            Default model
          </label>
          <p className="mb-2 text-[11px] text-text-muted">
            Optional `provider:model` override for chats in this folder. Empty means inherit from parent/global.
          </p>
          <label className="mb-1.5 block text-xs text-text-muted">Provider</label>
          <ComboSelect
            value={defaultModelProvider}
            options={providerOptions}
            placeholder="Use global default"
            onChange={(value) => void handleDefaultModelProviderChange(value)}
          />
          <label className="mb-1.5 mt-2 block text-xs text-text-muted">Model</label>
          <ComboSelect
            value={defaultModel}
            options={modelOptions}
            placeholder={
              defaultModelProvider
                ? "Select or type model name..."
                : "Select provider first..."
            }
            onChange={(value) => void handleDefaultModelChange(value)}
          />
        </div>

        {/* Instruction chain preview */}
        {(loadingInstructionChain || instructionChain.length > 0 || instructionChainError) && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Merged instruction chain (root → this folder)
            </label>
            {loadingInstructionChain ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/30 bg-bg-tertiary/50 px-3 py-2 text-xs text-text-muted">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border border-text-muted/60 border-t-transparent" />
                <span>Loading merged instruction chain…</span>
              </div>
            ) : instructionChain.length > 0 ? (
              <div className="space-y-2 rounded-xl border border-border/30 bg-bg-tertiary/50 p-3">
                {instructionChain.map((text, index) => (
                  <div
                    key={index}
                    className="rounded-lg bg-bg-secondary/60 px-3 py-2 text-xs text-text-secondary"
                  >
                    <span className="mr-2 font-mono text-[10px] text-text-muted">
                      {index + 1}.
                    </span>
                    {text}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border/30 bg-bg-tertiary/50 px-3 py-2 text-xs text-text-muted">
                No folder-level instruction chain found.
              </div>
            )}
            {instructionChainError && (
              <p className="mt-2 text-[11px] text-text-muted">
                Unable to refresh chain preview: {instructionChainError}
              </p>
            )}
          </div>
        )}

        {/* Danger zone */}
        <div className="border-t border-border/30 pt-6">
          <h3 className="mb-3 text-xs font-medium text-error/80">
            Danger zone
          </h3>
          <button
            type="button"
            onClick={() => void handleArchive()}
            className="rounded-xl border border-error/30 bg-error/[0.06] px-4 py-2 text-xs text-error transition-colors hover:bg-error/[0.12]"
          >
            Archive folder
          </button>
        </div>
      </div>
    </div>
  );
}
