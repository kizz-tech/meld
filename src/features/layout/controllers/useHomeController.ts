"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useAppStore,
  type Conversation,
  type Folder,
  type Message,
} from "@/lib/store";
import {
  archiveConversation,
  createFolder as createVaultFolder,
  createNote as createVaultNote,
  deleteMessage,
  archiveVaultEntry,
  editUserMessage,
  getConfig,
  getConversationMessages,
  getVaultInfo,
  listArchivedConversations,
  listConversations,
  listVaultEntries,
  listVaultFiles,
  moveVaultEntry,
  openFileExternal,
  pinConversation,
  previewFile,
  regenerateLastResponse,
  reorderConversations,
  reindex,
  renameConversation,
  sendMessage,
  setEmbeddingModel,
  unarchiveConversation,
  unpinConversation,
  createChatFolder,
  listChatFolders,
  renameChatFolder,
  archiveChatFolder,
  pinChatFolder,
  unpinChatFolder,
  moveChatFolder,
  setConversationFolder,
  type VaultEntry,
  type VaultFileEntry,
  type FolderPayload,
} from "@/lib/tauri";
import { setupEventListeners } from "@/lib/events";
import {
  buildVaultEntriesSignature,
  buildVaultFilesSignature,
  findExistingVaultNote,
  normalizeConversation,
  normalizeMessage,
  normalizeRelativeNotePath,
  sameConversation,
} from "@/features/layout/lib/home-helpers";
import {
  DEFAULT_EMBEDDING_MODELS,
  resolveEmbeddingProviderForIndexing,
} from "@/lib/providerCredentials";
import { buildIndexingDisabledToast, buildReindexErrorToast } from "@/lib/chatErrors";

export function useHomeController() {
  const {
    isOnboarded,
    showSettings,
    showHistory,
    showVaultSwitcher,
    vaultPath,
    fileCount,
    chatProvider,
    chatModel,
    isIndexing,
    indexProgress,
    conversations,
    activeConversationId,
    viewMode,
    activeNote,
    noteHistory,
    noteHistoryIndex,
    folders,
    activeFolderId,
    showFolderSettings,
    setViewMode,
    openNote,
    goToPreviousNote,
    goToNextNote,
    toggleSettings,
    toggleHistory,
    openVaultSwitcher,
    closeVaultSwitcher,
    setMessages,
    setActiveConversation,
    clearChat,
    newChat,
    openFolderSettings,
    closeFolderSettings,
  } = useAppStore(
    useShallow((state) => ({
      isOnboarded: state.isOnboarded,
      showSettings: state.showSettings,
      showHistory: state.showHistory,
      showVaultSwitcher: state.showVaultSwitcher,
      vaultPath: state.vaultPath,
      fileCount: state.fileCount,
      chatProvider: state.chatProvider,
      chatModel: state.chatModel,
      isIndexing: state.isIndexing,
      indexProgress: state.indexProgress,
      conversations: state.conversations,
      activeConversationId: state.activeConversationId,
      viewMode: state.viewMode,
      activeNote: state.activeNote,
      noteHistory: state.noteHistory,
      noteHistoryIndex: state.noteHistoryIndex,
      folders: state.folders,
      activeFolderId: state.activeFolderId,
      showFolderSettings: state.showFolderSettings,
      setViewMode: state.setViewMode,
      openNote: state.openNote,
      goToPreviousNote: state.goToPreviousNote,
      goToNextNote: state.goToNextNote,
      toggleSettings: state.toggleSettings,
      toggleHistory: state.toggleHistory,
      openVaultSwitcher: state.openVaultSwitcher,
      closeVaultSwitcher: state.closeVaultSwitcher,
      setMessages: state.setMessages,
      setActiveConversation: state.setActiveConversation,
      clearChat: state.clearChat,
      newChat: state.newChat,
      openFolderSettings: state.openFolderSettings,
      closeFolderSettings: state.closeFolderSettings,
    })),
  );

  const [loading, setLoading] = useState(true);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [vaultFiles, setVaultFiles] = useState<VaultFileEntry[]>([]);
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([]);
  const [loadingVaultFiles, setLoadingVaultFiles] = useState(false);
  const [noteContent, setNoteContent] = useState<string | null>(null);
  const [loadingNotePreview, setLoadingNotePreview] = useState(false);
  const [pendingFolderForNewChatId, setPendingFolderForNewChatId] = useState<string | null>(null);
  const vaultFilesRequestInFlight = useRef(false);
  const vaultSnapshotInitializedRef = useRef(false);
  const vaultFilesSignatureRef = useRef("");
  const vaultEntriesSignatureRef = useRef("");
  const lastVaultPathRef = useRef<string | null>(null);
  const vaultFilesRef = useRef(vaultFiles);
  vaultFilesRef.current = vaultFiles;
  const vaultPathRef = useRef(vaultPath);
  vaultPathRef.current = vaultPath;
  const selectNoteTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadConversations = useCallback(async () => {
    setLoadingConversations(true);
    try {
      const [activeResult, archivedResult] = await Promise.all([
        listConversations(),
        listArchivedConversations(),
      ]);
      const normalized = [...activeResult, ...archivedResult].map((conversation) =>
        normalizeConversation(conversation),
      );
      const store = useAppStore.getState();
      store.setConversations(normalized);
      if (
        store.activeConversationId !== null &&
        !normalized.some((conversation) =>
          sameConversation(conversation.id, store.activeConversationId),
        )
      ) {
        store.clearChat();
      }
    } catch (error) {
      console.error("Failed to load conversations:", error);
      useAppStore.getState().setConversations([]);
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  const normalizeFolder = (payload: FolderPayload): Folder => ({
    id: String(payload.id),
    name: payload.name,
    icon: payload.icon ?? null,
    customInstruction: payload.custom_instruction ?? null,
    defaultModelId: payload.default_model_id ?? null,
    parentId: payload.parent_id ? String(payload.parent_id) : null,
    pinned: payload.pinned ?? false,
    archived: payload.archived ?? false,
    sortOrder: payload.sort_order ?? null,
    createdAt: payload.created_at ?? new Date().toISOString(),
    updatedAt: payload.updated_at ?? new Date().toISOString(),
  });

  const loadFolders = useCallback(async () => {
    try {
      const result = await listChatFolders();
      useAppStore.getState().setFolders(result.map(normalizeFolder));
    } catch (error) {
      console.error("Failed to load folders:", error);
    }
  }, []);

  const loadVaultFiles = useCallback(async (options?: { silent?: boolean }) => {
    if (vaultFilesRequestInFlight.current) return;
    const silent = Boolean(options?.silent);
    const shouldShowLoading = !silent || !vaultSnapshotInitializedRef.current;

    vaultFilesRequestInFlight.current = true;
    if (shouldShowLoading) {
      setLoadingVaultFiles(true);
    }

    try {
      const [files, entries] = await Promise.all([
        listVaultFiles(),
        listVaultEntries(),
      ]);

      const filesSignature = buildVaultFilesSignature(files);
      const entriesSignature = buildVaultEntriesSignature(entries);

      if (filesSignature !== vaultFilesSignatureRef.current) {
        setVaultFiles(files);
        vaultFilesSignatureRef.current = filesSignature;
      }
      if (entriesSignature !== vaultEntriesSignatureRef.current) {
        setVaultEntries(entries);
        vaultEntriesSignatureRef.current = entriesSignature;
      }

      vaultSnapshotInitializedRef.current = true;
    } catch (error) {
      console.error("Failed to load vault files:", error);
      if (!vaultSnapshotInitializedRef.current) {
        setVaultFiles([]);
        setVaultEntries([]);
        vaultFilesSignatureRef.current = "";
        vaultEntriesSignatureRef.current = "";
      }
    } finally {
      if (shouldShowLoading) {
        setLoadingVaultFiles(false);
      }
      vaultFilesRequestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    async function restoreState() {
      try {
        const config = await getConfig();
        const store = useAppStore.getState();

        if (config.chat_provider) store.setChatProvider(config.chat_provider);
        if (config.chat_model) store.setChatModel(config.chat_model);
        if (config.embedding_provider) {
          store.setEmbeddingProvider(config.embedding_provider);
        }

        if (config.vault_path) {
          const info = await getVaultInfo();
          if (info) {
            store.setVaultPath(info.path, info.file_count);
            store.setOnboarded(true);
            await setupEventListeners();
          }
        }
      } catch (error) {
        console.error("Failed to restore state:", error);
      }
      setLoading(false);
    }
    void restoreState();
  }, []);

  useEffect(() => {
    if (!isOnboarded) return;
    void loadConversations();
    void loadFolders();
  }, [isOnboarded, loadConversations, loadFolders]);

  useEffect(() => {
    const normalizedVaultPath = vaultPath
      ? vaultPath.replace(/\\/g, "/").replace(/\/+$/, "")
      : null;

    if (!isOnboarded || !normalizedVaultPath) {
      lastVaultPathRef.current = normalizedVaultPath;
      return;
    }

    if (lastVaultPathRef.current === normalizedVaultPath) {
      return;
    }

    const isInitialVault = lastVaultPathRef.current === null;
    lastVaultPathRef.current = normalizedVaultPath;
    if (isInitialVault) {
      return;
    }

    useAppStore.setState({
      activeNote: null,
      noteHistory: [],
      noteHistoryIndex: -1,
    });
    setNoteContent(null);
    setVaultFiles([]);
    setVaultEntries([]);
    vaultSnapshotInitializedRef.current = false;
    vaultFilesSignatureRef.current = "";
    vaultEntriesSignatureRef.current = "";
    void loadVaultFiles();
  }, [isOnboarded, loadVaultFiles, vaultPath]);

  useEffect(() => {
    if (viewMode !== "files") return;
    if (vaultFiles.length > 0 || loadingVaultFiles) return;
    void loadVaultFiles();
  }, [loadVaultFiles, loadingVaultFiles, vaultFiles.length, viewMode]);

  useEffect(() => {
    if (!isOnboarded || viewMode !== "files") return;

    const refresh = () => {
      void loadVaultFiles({ silent: true });
    };

    const onWindowFocus = () => refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    const intervalId = window.setInterval(refresh, 4000);
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isOnboarded, loadVaultFiles, viewMode]);

  useEffect(() => {
    if (!activeNote) {
      setNoteContent(null);
      setLoadingNotePreview(false);
      return;
    }

    const normalizedActive = activeNote.replace(/\\/g, "/");
    const selected = vaultFilesRef.current.find(
      (entry) =>
        entry.relative_path.replace(/\\/g, "/").toLowerCase() ===
        normalizedActive.toLowerCase(),
    );

    if (!selected) {
      setNoteContent(null);
      const currentViewMode = useAppStore.getState().viewMode;
      if (currentViewMode === "files") {
        void loadVaultFiles({ silent: true });
      }
      return;
    }

    let cancelled = false;
    setLoadingNotePreview(true);

    void previewFile(selected.path)
      .then((content) => {
        if (cancelled) return;
        setNoteContent(content);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to preview note:", error);
        setNoteContent(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingNotePreview(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeNote, loadVaultFiles]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isMeta = event.metaKey || event.ctrlKey;
      if (!isMeta) return;

      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setPendingFolderForNewChatId(null);
        newChat();
      } else if (event.key === ",") {
        event.preventDefault();
        toggleSettings();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [newChat, toggleSettings]);

  const handleSelectConversation = useCallback(
    async (conversationId: Conversation["id"]) => {
      // Close Settings/History/FolderSettings when selecting a chat
      const s = useAppStore.getState();
      if (s.showSettings) s.toggleSettings();
      if (s.showHistory) s.toggleHistory();
      if (s.showFolderSettings) s.closeFolderSettings();

      // Suppress streaming events from the previous conversation so chat:done
      // handler just resets state instead of building a message from stale data.
      // chat:done will reset streamSuppressed back to false.
      useAppStore.setState({
        streamingContent: "",
        isStreaming: false,
        streamSuppressed: true,
        agentActivity: null,
        latestThinkingSummary: null,
        thinkingLog: [],
        toolCallLog: [],
        toolResultsLog: [],
        timelineSteps: [],
      });

      setPendingFolderForNewChatId(null);
      setActiveConversation(conversationId);
      try {
        const result = await getConversationMessages(conversationId);
        setMessages(result.map((message) => normalizeMessage(message)));
      } catch (error) {
        console.error("Failed to load conversation messages:", error);
        useAppStore.getState().showToast("Failed to load messages");
        setMessages([]);
      }
    },
    [setActiveConversation, setMessages],
  );

  const handleNewChat = useCallback((folderId: string | null = null) => {
    const s = useAppStore.getState();
    if (s.showSettings) s.toggleSettings();
    if (s.showHistory) s.toggleHistory();
    if (s.showFolderSettings) s.closeFolderSettings();
    setViewMode("chats");
    setPendingFolderForNewChatId(folderId);
    newChat();
  }, [newChat, setViewMode]);

  const resolveAndOpenNote = useCallback(
    async (path: string) => {
      const normalized = normalizeRelativeNotePath(path, vaultPathRef.current);
      if (!normalized) return;

      const cachedMatch = findExistingVaultNote(normalized, vaultFilesRef.current);
      if (cachedMatch) {
        setViewMode("files");
        openNote(cachedMatch);
        return;
      }

      let nextFiles = vaultFilesRef.current;
      try {
        nextFiles = await listVaultFiles();
      } catch (error) {
        console.error("Failed to refresh vault files for wikilink:", error);
      }

      const existing = findExistingVaultNote(normalized, nextFiles);
      if (existing) {
        setViewMode("files");
        openNote(existing);
        void loadVaultFiles({ silent: true });
        return;
      }

      useAppStore.getState().showToast(`Note "${normalized}" not found`);
    },
    [loadVaultFiles, openNote, setViewMode],
  );

  const handleSelectNote = useCallback(
    (path: string) => {
      // Close Settings/History/FolderSettings when selecting a note
      const s = useAppStore.getState();
      if (s.showSettings) s.toggleSettings();
      if (s.showHistory) s.toggleHistory();
      if (s.showFolderSettings) s.closeFolderSettings();

      clearTimeout(selectNoteTimerRef.current);
      selectNoteTimerRef.current = setTimeout(() => {
        void resolveAndOpenNote(path);
      }, 50);
    },
    [resolveAndOpenNote],
  );

  const handleOpenNoteFromChat = useCallback(
    (path: string) => {
      if (!path.trim()) {
        openNote("");
        return;
      }
      void resolveAndOpenNote(path);
    },
    [openNote, resolveAndOpenNote],
  );

  const handleSendMessage = useCallback(
    async (message: string) => {
      const store = useAppStore.getState();
      store.setStreamSuppressed(false);
      const pendingFolderId =
        store.activeConversationId === null
          ? pendingFolderForNewChatId
          : null;
      const response = await sendMessage(
        message,
        store.activeConversationId,
        pendingFolderId,
      );
      const conversationId = String(response.conversation_id);
      if (!sameConversation(store.activeConversationId, conversationId)) {
        store.setActiveConversation(conversationId);
      }

      const persistedMessages = await getConversationMessages(conversationId);
      setMessages(persistedMessages.map((item) => normalizeMessage(item)));
      await loadConversations();
      setPendingFolderForNewChatId(null);
    },
    [loadConversations, pendingFolderForNewChatId, setMessages],
  );

  const handleRegenerateLastResponse = useCallback(
    async (assistantMessageId?: string) => {
      const store = useAppStore.getState();
      if (!store.activeConversationId) {
        throw new Error("No active conversation to regenerate");
      }

      store.setStreaming(true);
      store.setStreamSuppressed(false);
      store.clearStreamingContent();
      store.setLatestThinkingSummary(null);
      store.clearToolCallLog();
      store.clearToolResultLog();
      store.clearTimeline();

      try {
        const normalizedAssistantId =
          assistantMessageId && /^\d+$/.test(assistantMessageId.trim())
            ? assistantMessageId
            : null;

        await regenerateLastResponse(
          String(store.activeConversationId),
          normalizedAssistantId,
        );

        const refreshed = await getConversationMessages(
          String(store.activeConversationId),
        );
        setMessages(refreshed.map((item) => normalizeMessage(item)));
        await loadConversations();
      } catch (error) {
        store.setStreaming(false);
        store.clearStreamingContent();
        store.setAgentActivity(null);
        store.setStreamSuppressed(false);
        store.setLatestThinkingSummary(null);
        store.clearToolCallLog();
        store.clearToolResultLog();
        store.clearTimeline();
        throw error;
      }
    },
    [loadConversations, setMessages],
  );

  const handleCreateKbNote = useCallback(
    async (path: string) => {
      const createdPath = await createVaultNote(path);
      await loadVaultFiles({ silent: true });
      setViewMode("files");
      openNote(createdPath);
    },
    [loadVaultFiles, openNote, setViewMode],
  );

  const handleCreateKbFolder = useCallback(
    async (path: string) => {
      await createVaultFolder(path);
      await loadVaultFiles({ silent: true });
    },
    [loadVaultFiles],
  );

  const handleArchiveKbEntry = useCallback(
    async (path: string) => {
      await archiveVaultEntry(path);
      await loadVaultFiles({ silent: true });
    },
    [loadVaultFiles],
  );

  const handleMoveKbEntry = useCallback(
    async (fromPath: string, toPath: string) => {
      const movedPath = await moveVaultEntry(fromPath, toPath);
      const normalizedActive = activeNote
        ? activeNote.replace(/\\/g, "/").toLowerCase()
        : "";
      const normalizedFrom = fromPath.replace(/\\/g, "/").toLowerCase();
      const normalizedMoved = movedPath.replace(/\\/g, "/");

      if (normalizedActive) {
        if (normalizedActive === normalizedFrom) {
          openNote(normalizedMoved);
        } else if (normalizedActive.startsWith(`${normalizedFrom}/`)) {
          const suffix = activeNote?.slice(fromPath.length) ?? "";
          openNote(`${normalizedMoved}${suffix}`);
        }
      }

      await loadVaultFiles({ silent: true });
    },
    [activeNote, loadVaultFiles, openNote],
  );

  const handleOpenNoteInEditor = useCallback(
    async (path: string) => {
      const normalized = normalizeRelativeNotePath(path, vaultPathRef.current);
      if (!normalized) return;

      const normalizedTarget = normalized.replace(/\\/g, "/").toLowerCase();
      const selected = vaultFilesRef.current.find(
        (entry) =>
          entry.relative_path.replace(/\\/g, "/").toLowerCase() === normalizedTarget,
      );
      const absolutePath = selected?.path ?? (vaultPathRef.current ? `${vaultPathRef.current}/${normalized}` : null);
      if (!absolutePath) return;

      await openFileExternal(absolutePath);
    },
    [],
  );

  const handleReindex = useCallback(async () => {
    const store = useAppStore.getState();
    if (store.isIndexing) return;

    try {
      const config = await getConfig();
      const resolvedEmbeddingProvider = resolveEmbeddingProviderForIndexing(config);
      const currentEmbeddingProvider =
        config.embedding_provider?.trim().toLowerCase() || "openai";

      if (!resolvedEmbeddingProvider) {
        const toast = buildIndexingDisabledToast();
        store.showToast(toast.message, toast.options);
        return;
      }

      if (resolvedEmbeddingProvider !== currentEmbeddingProvider) {
        await setEmbeddingModel(
          resolvedEmbeddingProvider,
          DEFAULT_EMBEDDING_MODELS[resolvedEmbeddingProvider],
        );
        store.setEmbeddingProvider(resolvedEmbeddingProvider);
      }
    } catch (error) {
      console.error("Failed to prepare reindex:", error);
    }

    store.setIndexing(true);
    try {
      await reindex();
    } catch (error) {
      console.error("Failed to reindex:", error);
      const toast = buildReindexErrorToast(error);
      store.showToast(toast.message, toast.options);
    } finally {
      store.setIndexing(false);
    }
  }, []);

  const handleReorderConversations = useCallback(
    async (conversationIds: Conversation["id"][]) => {
      const normalizedIds = conversationIds
        .map((id) => String(id).trim())
        .filter((id) => id.length > 0);
      if (normalizedIds.length === 0) {
        return;
      }

      await reorderConversations(normalizedIds);

      const orderById = new Map(
        normalizedIds.map((id, index) => [id, index + 1]),
      );
      const store = useAppStore.getState();
      store.setConversations(
        store.conversations.map((conversation) => {
          if (conversation.archived) return conversation;
          const nextSortOrder = orderById.get(String(conversation.id));
          if (typeof nextSortOrder !== "number") return conversation;
          return { ...conversation, sortOrder: nextSortOrder };
        }),
      );
    },
    [],
  );

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      const store = useAppStore.getState();
      const targetIndex = store.messages.findIndex((message) => message.id === messageId);
      const targetMessage = targetIndex >= 0 ? store.messages[targetIndex] : null;
      const persistedIdPattern = /^\d+$/;
      const idsToDelete: string[] = [];

      if (persistedIdPattern.test(messageId.trim())) {
        idsToDelete.push(messageId);
      }

      if (targetMessage?.role === "user") {
        const nextAssistant = store.messages
          .slice(targetIndex + 1)
          .find(
            (message) =>
              message.role === "assistant" && persistedIdPattern.test(message.id.trim()),
          );
        if (nextAssistant && !idsToDelete.includes(nextAssistant.id)) {
          idsToDelete.push(nextAssistant.id);
        }
      }

      if (idsToDelete.length === 0) {
        return;
      }

      for (const id of idsToDelete) {
        await deleteMessage(id);
      }

      if (store.activeConversationId === null) {
        const deletedIds = new Set(idsToDelete);
        const filtered = store.messages.filter((message) => !deletedIds.has(message.id));
        setMessages(filtered);
        return;
      }

      const refreshed = await getConversationMessages(store.activeConversationId);
      const normalizedMessages = refreshed.map((message) => normalizeMessage(message));
      setMessages(normalizedMessages);

      const activeConversation = store.conversations.find((conversation) =>
        sameConversation(conversation.id, store.activeConversationId),
      );
      if (activeConversation) {
        store.upsertConversation({
          ...activeConversation,
          updatedAt: new Date().toISOString(),
          messageCount: normalizedMessages.length,
        });
      }
    },
    [setMessages],
  );

  const handleEditMessage = useCallback(
    async (messageId: string, content: string) => {
      const normalized = content.trim();
      if (!normalized) {
        throw new Error("Message content cannot be empty");
      }

      const store = useAppStore.getState();
      const previousMessages = [...store.messages];
      const targetIndex = previousMessages.findIndex(
        (message) => message.id === messageId && message.role === "user",
      );
      if (targetIndex < 0) {
        throw new Error("User message not found");
      }

      const truncatedMessages = previousMessages.slice(0, targetIndex + 1);
      truncatedMessages[targetIndex] = {
        ...truncatedMessages[targetIndex],
        content: normalized,
      };

      const activeConversation = store.conversations.find((conversation) =>
        sameConversation(conversation.id, store.activeConversationId),
      );

      store.setMessages(truncatedMessages);
      if (activeConversation) {
        store.upsertConversation({
          ...activeConversation,
          updatedAt: new Date().toISOString(),
          messageCount: truncatedMessages.length,
        });
      }

      store.setStreaming(true);
      store.setStreamSuppressed(false);
      store.clearStreamingContent();
      store.setLatestThinkingSummary(null);
      store.clearToolCallLog();
      store.clearToolResultLog();
      store.clearTimeline();

      try {
        const response = await editUserMessage(messageId, normalized);
        if (
          store.activeConversationId === null ||
          String(store.activeConversationId) !== String(response.conversation_id)
        ) {
          store.setActiveConversation(response.conversation_id);
        }
      } catch (error) {
        store.setMessages(previousMessages);
        if (activeConversation) {
          store.upsertConversation(activeConversation);
        }
        store.setStreaming(false);
        store.clearStreamingContent();
        store.setStreamSuppressed(false);
        store.clearToolCallLog();
        store.clearToolResultLog();
        store.clearTimeline();
        store.setLatestThinkingSummary(null);
        throw error;
      }
    },
    [],
  );

  const handleRenameConversation = useCallback(
    async (conversationId: Conversation["id"], title: string) => {
      const normalizedTitle = title.trim();
      if (!normalizedTitle) return;

      await renameConversation(conversationId, normalizedTitle);

      const store = useAppStore.getState();
      const existing = store.conversations.find((conversation) =>
        sameConversation(conversation.id, conversationId),
      );
      if (!existing) return;

      store.upsertConversation({
        ...existing,
        title: normalizedTitle,
        updatedAt: new Date().toISOString(),
      });
    },
    [],
  );

  const handleArchiveConversation = useCallback(
    async (conversationId: Conversation["id"]) => {
      await archiveConversation(conversationId);

      const store = useAppStore.getState();
      const existing = store.conversations.find((conversation) =>
        sameConversation(conversation.id, conversationId),
      );
      if (!existing) return;

      const updatedAt = new Date().toISOString();
      store.upsertConversation({
        ...existing,
        archived: true,
        pinned: false,
        updatedAt,
      });

      if (!sameConversation(store.activeConversationId, conversationId)) {
        return;
      }

      const nextActive = store.conversations
        .filter((conversation) => !conversation.archived)
        .find((conversation) => !sameConversation(conversation.id, conversationId));

      if (!nextActive) {
        store.clearChat();
        return;
      }

      await handleSelectConversation(nextActive.id);
    },
    [handleSelectConversation],
  );

  const handleUnarchiveConversation = useCallback(
    async (conversationId: Conversation["id"]) => {
      await unarchiveConversation(conversationId);

      const store = useAppStore.getState();
      const existing = store.conversations.find((conversation) =>
        sameConversation(conversation.id, conversationId),
      );
      if (!existing) return;

      const minSortOrder = store.conversations
        .filter(
          (conversation) =>
            !conversation.archived &&
            typeof conversation.sortOrder === "number",
        )
        .reduce<number | null>((minValue, conversation) => {
          if (typeof conversation.sortOrder !== "number") return minValue;
          if (minValue === null) return conversation.sortOrder;
          return Math.min(minValue, conversation.sortOrder);
        }, null);

      store.upsertConversation({
        ...existing,
        archived: false,
        sortOrder: (minSortOrder ?? 1) - 1,
        updatedAt: new Date().toISOString(),
      });
    },
    [],
  );

  const handlePinConversation = useCallback(
    async (conversationId: Conversation["id"]) => {
      await pinConversation(conversationId);

      const store = useAppStore.getState();
      const existing = store.conversations.find((conversation) =>
        sameConversation(conversation.id, conversationId),
      );
      if (!existing) return;

      store.upsertConversation({
        ...existing,
        pinned: true,
        updatedAt: new Date().toISOString(),
      });
    },
    [],
  );

  const handleUnpinConversation = useCallback(
    async (conversationId: Conversation["id"]) => {
      await unpinConversation(conversationId);

      const store = useAppStore.getState();
      const existing = store.conversations.find((conversation) =>
        sameConversation(conversation.id, conversationId),
      );
      if (!existing) return;

      store.upsertConversation({
        ...existing,
        pinned: false,
        updatedAt: new Date().toISOString(),
      });
    },
    [],
  );

  const handleCreateChatFolder = useCallback(
    async (parentId: string | null): Promise<string> => {
      const id = await createChatFolder("New folder", parentId);
      await loadFolders();
      return String(id);
    },
    [loadFolders],
  );

  const handleRenameChatFolder = useCallback(
    async (folderId: string, name: string) => {
      await renameChatFolder(folderId, name);
      await loadFolders();
    },
    [loadFolders],
  );

  const handleArchiveChatFolder = useCallback(
    async (folderId: string) => {
      await archiveChatFolder(folderId);
      await loadFolders();
      await loadConversations();
    },
    [loadConversations, loadFolders],
  );

  const handlePinChatFolder = useCallback(
    async (folderId: string) => {
      await pinChatFolder(folderId);
      await loadFolders();
    },
    [loadFolders],
  );

  const handleUnpinChatFolder = useCallback(
    async (folderId: string) => {
      await unpinChatFolder(folderId);
      await loadFolders();
    },
    [loadFolders],
  );

  const handleMoveChatFolder = useCallback(
    async (folderId: string, newParentId: string | null) => {
      await moveChatFolder(folderId, newParentId);
      await loadFolders();
    },
    [loadFolders],
  );

  const handleSetConversationFolder = useCallback(
    async (conversationId: string, folderId: string | null) => {
      await setConversationFolder(conversationId, folderId);
      await loadConversations();
    },
    [loadConversations],
  );

  const handleOpenFolderSettings = useCallback(
    (folderId: string) => {
      openFolderSettings(folderId);
    },
    [openFolderSettings],
  );

  const handleCloseFolderSettings = useCallback(() => {
    closeFolderSettings();
  }, [closeFolderSettings]);

  const handleFolderArchived = useCallback(
    async (_folderId: string) => {
      await loadFolders();
      await loadConversations();
    },
    [loadConversations, loadFolders],
  );

  const handleFolderUpdated = useCallback(async () => {
    await loadFolders();
  }, [loadFolders]);

  const vaultName = useMemo(() => {
    if (!vaultPath) return "Vault";
    const normalizedPath = vaultPath.replaceAll("\\", "/");
    const parts = normalizedPath.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "Vault";
  }, [vaultPath]);

  const folderById = useMemo(() => {
    const map = new Map<string, Folder>();
    folders.forEach((folder) => {
      map.set(folder.id, folder);
    });
    return map;
  }, [folders]);

  const activeConversation = useMemo(
    () =>
      conversations.find((conversation) =>
        sameConversation(conversation.id, activeConversationId),
      ) ?? null,
    [activeConversationId, conversations],
  );

  const activeChatFolderPath = useMemo(() => {
    const startFolderId = activeConversation?.folderId ?? pendingFolderForNewChatId;
    if (!startFolderId) {
      return [] as string[];
    }

    const chain: string[] = [];
    const visited = new Set<string>();
    let currentFolderId: string | null = startFolderId;

    while (currentFolderId) {
      if (visited.has(currentFolderId)) break;
      visited.add(currentFolderId);

      const folder = folderById.get(currentFolderId);
      if (!folder) break;
      chain.push(folder.name);
      currentFolderId = folder.parentId;
    }

    chain.reverse();
    return chain;
  }, [activeConversation?.folderId, folderById, pendingFolderForNewChatId]);

  const isChatScopedToFolder = activeChatFolderPath.length > 0;
  const chatScopeLabel = isChatScopedToFolder
    ? activeChatFolderPath.join(" / ")
    : "Root";

  const activeModelId = useMemo(() => {
    const fallbackModelId = chatModel
      ? `${chatProvider}:${chatModel}`
      : chatProvider || "—";

    const resolveFolderModelId = (
      startFolderId: string | null | undefined,
    ): string | null => {
      let currentFolderId = startFolderId ?? null;
      const visited = new Set<string>();

      while (currentFolderId) {
        if (visited.has(currentFolderId)) break;
        visited.add(currentFolderId);

        const folder = folderById.get(currentFolderId);
        if (!folder) break;

        const normalizedModelId = folder.defaultModelId?.trim();
        if (normalizedModelId) {
          return normalizedModelId;
        }
        currentFolderId = folder.parentId;
      }

      return null;
    };

    const folderModelId = resolveFolderModelId(
      activeConversation?.folderId ?? pendingFolderForNewChatId,
    );
    return folderModelId ?? fallbackModelId;
  }, [
    activeConversation?.folderId,
    chatModel,
    chatProvider,
    folderById,
    pendingFolderForNewChatId,
  ]);

  return {
    state: {
      loading,
      isOnboarded,
      showSettings,
      showHistory,
      showVaultSwitcher,
      vaultPath,
      fileCount,
      chatProvider,
      chatModel,
      isIndexing,
      indexProgress,
      conversations,
      activeConversationId,
      viewMode,
      activeNote,
      noteHistory,
      noteHistoryIndex,
      loadingConversations,
      vaultEntries,
      loadingVaultFiles,
      noteContent,
      loadingNotePreview,
      vaultName,
      activeModelId,
      chatScopeLabel,
      isChatScopedToFolder,
      folders,
      activeFolderId,
      showFolderSettings,
    },
    actions: {
      setViewMode,
      goToPreviousNote,
      goToNextNote,
      toggleSettings,
      toggleHistory,
      openVaultSwitcher,
      closeVaultSwitcher,
      handleSendMessage,
      handleRegenerateLastResponse,
      handleSelectConversation,
      handleSelectNote,
      handleNewChat,
      handleRenameConversation,
      handleReorderConversations,
      handleArchiveConversation,
      handleUnarchiveConversation,
      handlePinConversation,
      handleUnpinConversation,
      handleCreateChatFolder,
      handleRenameChatFolder,
      handleArchiveChatFolder,
      handlePinChatFolder,
      handleUnpinChatFolder,
      handleMoveChatFolder,
      handleSetConversationFolder,
      handleOpenFolderSettings,
      handleCloseFolderSettings,
      handleFolderArchived,
      handleFolderUpdated,
      handleCreateKbNote,
      handleCreateKbFolder,
      handleArchiveKbEntry,
      handleMoveKbEntry,
      handleOpenNoteFromChat,
      handleOpenNoteInEditor,
      handleDeleteMessage,
      handleEditMessage,
      handleReindex,
    },
  };
}
