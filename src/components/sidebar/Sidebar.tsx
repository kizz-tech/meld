"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useAppStore, type Conversation } from "@/lib/store";
import type { VaultEntry } from "@/lib/tauri";
import VaultBrowser from "@/components/vault/VaultBrowser";
import TreeSurface from "@/components/tree/TreeSurface";
import { useTreeDndState } from "@/components/tree/useTreeDndState";
import { useTreeContextMenu } from "@/features/shared/tree/useTreeContextMenu";
import ConversationRow, { type ConversationRowHandlers } from "./ConversationRow";
import ChatFolderRow, { type ChatFolderRowHandlers } from "./ChatFolderRow";

interface SidebarProps {
  conversations: Conversation[];
  activeConversationId: Conversation["id"] | null;
  vaultEntries: VaultEntry[];
  loadingVaultFiles: boolean;
  activeNotePath: string | null;
  onSelectConversation: (conversationId: Conversation["id"]) => void;
  onSelectNote: (notePath: string) => void;
  onNewChat: () => void;
  onRenameConversation: (
    conversationId: Conversation["id"],
    title: string,
  ) => Promise<void> | void;
  onReorderConversations: (
    conversationIds: Conversation["id"][],
  ) => Promise<void> | void;
  onArchiveConversation: (
    conversationId: Conversation["id"],
  ) => Promise<void> | void;
  onUnarchiveConversation: (
    conversationId: Conversation["id"],
  ) => Promise<void> | void;
  onPinConversation: (
    conversationId: Conversation["id"],
  ) => Promise<void> | void;
  onUnpinConversation: (
    conversationId: Conversation["id"],
  ) => Promise<void> | void;
  onCreateKbNote: (path: string) => Promise<void> | void;
  onCreateKbFolder: (path: string) => Promise<void> | void;
  onArchiveKbEntry: (path: string) => Promise<void> | void;
  onMoveKbEntry: (fromPath: string, toPath: string) => Promise<void> | void;
}

const CHAT_LAYOUT_STORAGE_KEY = "meld.chat-layout.v1";

interface ChatFolder {
  id: string;
  name: string;
  parentId: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ChatLayoutSnapshot {
  folders: ChatFolder[];
  assignments: Record<string, string>;
}

interface ContextMenuTarget {
  kind: "conversation" | "folder" | "root";
  id: string;
}

type ChatDragEntity =
  | { kind: "conversation"; id: string }
  | { kind: "folder"; id: string };

type ChatDropTarget = { kind: "root" } | { kind: "folder"; folderId: string };

const sameConversation = (
  left: Conversation["id"] | null,
  right: Conversation["id"] | null,
): boolean => {
  if (left === null || right === null) return left === right;
  return String(left) === String(right);
};

const getConversationTitle = (conversation: Conversation): string => {
  const title = conversation.title.trim();
  return title.length > 0 ? title : "Untitled chat";
};

const parseDateMs = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const sqliteParsed = Date.parse(value.replace(" ", "T") + "Z");
  return Number.isNaN(sqliteParsed) ? 0 : sqliteParsed;
};

const sortConversationsByRecent = (items: Conversation[]): Conversation[] => {
  return [...items].sort((left, right) => {
    const pinDiff = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinDiff !== 0) return pinDiff;

    const leftSortOrder =
      typeof left.sortOrder === "number" ? left.sortOrder : Number.MAX_SAFE_INTEGER;
    const rightSortOrder =
      typeof right.sortOrder === "number" ? right.sortOrder : Number.MAX_SAFE_INTEGER;
    if (leftSortOrder !== rightSortOrder) {
      return leftSortOrder - rightSortOrder;
    }

    const updatedDiff = parseDateMs(right.updatedAt) - parseDateMs(left.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;

    return parseDateMs(right.createdAt) - parseDateMs(left.createdAt);
  });
};

const sortFoldersByRecent = (items: ChatFolder[]): ChatFolder[] => {
  return [...items].sort((left, right) => {
    const pinDiff = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinDiff !== 0) return pinDiff;

    const updatedDiff = parseDateMs(right.updatedAt) - parseDateMs(left.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;

    return parseDateMs(right.createdAt) - parseDateMs(left.createdAt);
  });
};

const nowIso = (): string => new Date().toISOString();

const generateFolderId = (): string =>
  `folder_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const createFolderName = (existingNames: Set<string>): string => {
  if (!existingNames.has("New folder")) return "New folder";
  let index = 2;
  while (existingNames.has(`New folder ${index}`)) {
    index += 1;
  }
  return `New folder ${index}`;
};

const normalizeVaultPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\/+/, "").trim();

const createKnowledgeNoteName = (entries: VaultEntry[]): string => {
  const existing = new Set(
    entries.map((entry) => normalizeVaultPath(entry.relative_path).toLowerCase()),
  );

  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `-${index}`;
    const candidate = `new-note${suffix}.md`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
};

const createKnowledgeFolderName = (entries: VaultEntry[]): string => {
  const existing = new Set(
    entries.map((entry) => normalizeVaultPath(entry.relative_path).toLowerCase()),
  );

  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `-${index}`;
    const candidate = `new-folder${suffix}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
};

const loadChatLayoutSnapshot = (): ChatLayoutSnapshot => {
  if (typeof window === "undefined") {
    return { folders: [], assignments: {} };
  }

  try {
    const raw = window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY);
    if (!raw) return { folders: [], assignments: {} };
    const parsed = JSON.parse(raw) as Partial<ChatLayoutSnapshot>;

    const folders = Array.isArray(parsed.folders)
      ? parsed.folders
          .filter((item): item is ChatFolder => {
            if (!item || typeof item !== "object") return false;
            const candidate = item as Partial<ChatFolder>;
            return (
              typeof candidate.id === "string" &&
              typeof candidate.name === "string" &&
              (candidate.parentId === null || typeof candidate.parentId === "string")
            );
          })
          .map((item) => ({
            id: item.id,
            name: item.name.trim() || "Untitled folder",
            parentId: item.parentId,
            pinned: Boolean(item.pinned),
            archived: Boolean(item.archived),
            createdAt: item.createdAt || nowIso(),
            updatedAt: item.updatedAt || item.createdAt || nowIso(),
          }))
      : [];

    const assignments: Record<string, string> = Object.create(null);
    if (parsed.assignments && typeof parsed.assignments === "object") {
      for (const [key, value] of Object.entries(parsed.assignments)) {
        if (typeof value !== "string" || !value.trim()) continue;
        assignments[key] = value;
      }
    }

    return { folders, assignments };
  } catch {
    return { folders: [], assignments: {} };
  }
};

const saveChatLayoutSnapshot = (snapshot: ChatLayoutSnapshot): void => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CHAT_LAYOUT_STORAGE_KEY, JSON.stringify(snapshot));
};

const getFolderDescendants = (folders: ChatFolder[], rootId: string): Set<string> => {
  const descendants = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    descendants.add(current);
    folders.forEach((folder) => {
      if (folder.parentId === current && !descendants.has(folder.id)) {
        stack.push(folder.id);
      }
    });
  }
  return descendants;
};

export default function Sidebar({
  conversations,
  activeConversationId,
  vaultEntries,
  loadingVaultFiles,
  activeNotePath,
  onSelectConversation,
  onSelectNote,
  onNewChat,
  onRenameConversation,
  onReorderConversations,
  onArchiveConversation,
  onUnarchiveConversation,
  onPinConversation,
  onUnpinConversation,
  onCreateKbNote,
  onCreateKbFolder,
  onArchiveKbEntry,
  onMoveKbEntry,
}: SidebarProps) {
  const { sidebarCollapsed, toggleSidebarCollapsed, viewMode, setViewMode } =
    useAppStore(useShallow((s) => ({
      sidebarCollapsed: s.sidebarCollapsed,
      toggleSidebarCollapsed: s.toggleSidebarCollapsed,
      viewMode: s.viewMode,
      setViewMode: s.setViewMode,
    })));
  const {
    contextMenu,
    setContextMenu,
    closeContextMenu,
    openContextMenu: openTreeContextMenu,
  } = useTreeContextMenu<ContextMenuTarget>({
    menuDataAttribute: "data-sidebar-context-menu",
  });

  const [chatFolders, setChatFolders] = useState<ChatFolder[]>([]);
  const [conversationFolders, setConversationFolders] = useState<Record<string, string>>(
    Object.create(null),
  );
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [pendingFolderForNewChat, setPendingFolderForNewChat] = useState<string | null>(
    null,
  );

  const [editingConversationId, setEditingConversationId] = useState<
    Conversation["id"] | null
  >(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const {
    draggingEntity,
    setDraggingEntity,
    dropTarget,
    setDropTarget,
    clearDragState,
  } = useTreeDndState<ChatDragEntity, ChatDropTarget>();
  const draggingEntityRef = useRef<ChatDragEntity | null>(null);

  useEffect(() => {
    const snapshot = loadChatLayoutSnapshot();
    setChatFolders(snapshot.folders);
    setConversationFolders(snapshot.assignments);

    setExpandedFolderIds(() => {
      const next = new Set<string>();
      snapshot.folders.forEach((folder) => {
        if (!folder.archived && folder.parentId === null) {
          next.add(folder.id);
        }
      });
      return next;
    });
  }, []);

  useEffect(() => {
    saveChatLayoutSnapshot({
      folders: chatFolders,
      assignments: conversationFolders,
    });
  }, [chatFolders, conversationFolders]);

  useEffect(() => {
    if (!sidebarError) return;
    const timeoutId = window.setTimeout(() => {
      setSidebarError(null);
    }, 3600);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [sidebarError]);

  useEffect(() => {
    if (viewMode === "chats") return;
    draggingEntityRef.current = null;
    closeContextMenu();
    clearDragState();
  }, [clearDragState, closeContextMenu, viewMode]);

  const resetDragState = () => {
    draggingEntityRef.current = null;
    clearDragState();
  };

  const resolveDraggingEntity = (
    event?: React.DragEvent<HTMLElement>,
  ): ChatDragEntity | null => {
    const kind = event?.dataTransfer.getData("application/x-meld-chat-kind");
    const id = event?.dataTransfer.getData("application/x-meld-chat-id");
    if ((kind === "conversation" || kind === "folder") && id) {
      return { kind, id };
    }
    return draggingEntityRef.current ?? draggingEntity;
  };

  useEffect(() => {
    const validFolderIds = new Set(
      chatFolders.filter((folder) => !folder.archived).map((folder) => folder.id),
    );
    const activeConversationIds = new Set(
      conversations.map((conversation) => String(conversation.id)),
    );

    let changed = false;
    const nextAssignments: Record<string, string> = Object.create(null);
    for (const conversation of conversations) {
      const key = String(conversation.id);
      const folderId = conversationFolders[key];
      if (!folderId) continue;
      if (!validFolderIds.has(folderId)) {
        changed = true;
        continue;
      }
      nextAssignments[key] = folderId;
    }

    for (const assignedConversationId of Object.keys(conversationFolders)) {
      if (!activeConversationIds.has(assignedConversationId)) {
        changed = true;
        break;
      }
    }

    if (changed || Object.keys(nextAssignments).length !== Object.keys(conversationFolders).length) {
      setConversationFolders(nextAssignments);
    }
  }, [chatFolders, conversationFolders, conversations]);

  useEffect(() => {
    if (!pendingFolderForNewChat) return;
    const folderExists = chatFolders.some(
      (folder) => folder.id === pendingFolderForNewChat && !folder.archived,
    );
    if (!folderExists) {
      setPendingFolderForNewChat(null);
      return;
    }

    if (activeConversationId === null) return;
    const key = String(activeConversationId);
    const hasConversation = conversations.some(
      (conversation) =>
        sameConversation(conversation.id, activeConversationId) && !conversation.archived,
    );
    if (!hasConversation) return;

    setConversationFolders((prev) => {
      if (prev[key] === pendingFolderForNewChat) return prev;
      return {
        ...prev,
        [key]: pendingFolderForNewChat,
      };
    });
    setChatFolders((prev) =>
      prev.map((folder) =>
        folder.id === pendingFolderForNewChat
          ? { ...folder, updatedAt: nowIso() }
          : folder,
      ),
    );
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      next.add(pendingFolderForNewChat);
      return next;
    });
    setPendingFolderForNewChat(null);
  }, [activeConversationId, chatFolders, conversations, pendingFolderForNewChat]);

  const activeConversations = useMemo(
    () =>
      sortConversationsByRecent(
        conversations.filter((conversation) => !conversation.archived),
      ),
    [conversations],
  );

  const archivedConversations = useMemo(
    () =>
      sortConversationsByRecent(
        conversations.filter((conversation) => Boolean(conversation.archived)),
      ),
    [conversations],
  );

  const visibleFolders = useMemo(
    () => sortFoldersByRecent(chatFolders.filter((folder) => !folder.archived)),
    [chatFolders],
  );

  const folderById = useMemo(() => {
    const next = new Map<string, ChatFolder>();
    visibleFolders.forEach((folder) => {
      next.set(folder.id, folder);
    });
    return next;
  }, [visibleFolders]);

  const foldersByParent = useMemo(() => {
    const map = new Map<string | null, ChatFolder[]>();
    visibleFolders.forEach((folder) => {
      const key = folder.parentId;
      const bucket = map.get(key) ?? [];
      bucket.push(folder);
      map.set(key, bucket);
    });

    for (const [key, bucket] of map.entries()) {
      map.set(key, sortFoldersByRecent(bucket));
    }
    return map;
  }, [visibleFolders]);

  const conversationsByFolder = useMemo(() => {
    const map = new Map<string | null, Conversation[]>();
    activeConversations.forEach((conversation) => {
      const folderId = conversationFolders[String(conversation.id)];
      const key = folderId && folderById.has(folderId) ? folderId : null;
      const bucket = map.get(key) ?? [];
      bucket.push(conversation);
      map.set(key, bucket);
    });

    for (const [key, bucket] of map.entries()) {
      map.set(key, sortConversationsByRecent(bucket));
    }
    return map;
  }, [activeConversations, conversationFolders, folderById]);

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    menu: ContextMenuTarget,
  ) => {
    const menuWidth = 188;
    const menuHeight =
      menu.kind === "folder" ? 214 : menu.kind === "conversation" ? 228 : 104;
    openTreeContextMenu(event, menu, {
      mode: menu.kind === "root" ? "pointer" : "row",
      menuWidth,
      menuHeight,
    });
  };

  const beginRenameConversation = (conversation: Conversation) => {
    setContextMenu(null);
    setEditingFolderId(null);
    setEditingConversationId(conversation.id);
    setDraftTitle(getConversationTitle(conversation));
  };

  const beginRenameFolder = (folder: ChatFolder) => {
    setContextMenu(null);
    setEditingConversationId(null);
    setEditingFolderId(folder.id);
    setDraftTitle(folder.name);
  };

  const cancelRename = () => {
    if (savingRename) return;
    setEditingConversationId(null);
    setEditingFolderId(null);
    setDraftTitle("");
  };

  const submitRenameConversation = async (conversation: Conversation) => {
    if (savingRename) return;

    const nextTitle = draftTitle.trim();
    if (!nextTitle || nextTitle === getConversationTitle(conversation)) {
      setEditingConversationId(null);
      return;
    }

    setSavingRename(true);
    try {
      await onRenameConversation(conversation.id, nextTitle);
      setEditingConversationId(null);
      setDraftTitle("");
    } catch (error) {
      console.error("Failed to rename conversation", error);
      setSidebarError(`Failed to rename conversation: ${String(error)}`);
    } finally {
      setSavingRename(false);
    }
  };

  const submitRenameFolder = async (folder: ChatFolder) => {
    if (savingRename) return;
    const nextName = draftTitle.trim();
    if (!nextName || nextName === folder.name) {
      setEditingFolderId(null);
      return;
    }

    setSavingRename(true);
    try {
      setChatFolders((prev) =>
        prev.map((item) =>
          item.id === folder.id
            ? {
                ...item,
                name: nextName,
                updatedAt: nowIso(),
              }
            : item,
        ),
      );
      setEditingFolderId(null);
      setDraftTitle("");
    } catch (error) {
      console.error("Failed to rename folder", error);
      setSidebarError(`Failed to rename folder: ${String(error)}`);
    } finally {
      setSavingRename(false);
    }
  };

  const createFolder = (parentId: string | null) => {
    const existingNames = new Set(
      chatFolders
        .filter((folder) => folder.parentId === parentId && !folder.archived)
        .map((folder) => folder.name),
    );

    const name = createFolderName(existingNames);
    const createdAt = nowIso();
    const nextFolder: ChatFolder = {
      id: generateFolderId(),
      name,
      parentId,
      pinned: false,
      archived: false,
      createdAt,
      updatedAt: createdAt,
    };

    setChatFolders((prev) => sortFoldersByRecent([...prev, nextFolder]));
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      next.add(nextFolder.id);
      if (parentId) next.add(parentId);
      return next;
    });
    setEditingConversationId(null);
    setEditingFolderId(nextFolder.id);
    setDraftTitle(name);
  };

  const archiveConversationRow = async (conversation: Conversation) => {
    setContextMenu(null);
    try {
      await onArchiveConversation(conversation.id);
      setConversationFolders((prev) => {
        const key = String(conversation.id);
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (error) {
      console.error("Failed to archive conversation", error);
      setSidebarError(`Failed to archive conversation: ${String(error)}`);
    }
  };

  const unarchiveConversationRow = async (conversation: Conversation) => {
    setContextMenu(null);
    try {
      await onUnarchiveConversation(conversation.id);
    } catch (error) {
      console.error("Failed to unarchive conversation", error);
      setSidebarError(`Failed to unarchive conversation: ${String(error)}`);
    }
  };

  const pinConversationRow = async (conversation: Conversation) => {
    setContextMenu(null);
    try {
      await onPinConversation(conversation.id);
    } catch (error) {
      console.error("Failed to pin conversation", error);
      setSidebarError(`Failed to pin conversation: ${String(error)}`);
    }
  };

  const unpinConversationRow = async (conversation: Conversation) => {
    setContextMenu(null);
    try {
      await onUnpinConversation(conversation.id);
    } catch (error) {
      console.error("Failed to unpin conversation", error);
      setSidebarError(`Failed to unpin conversation: ${String(error)}`);
    }
  };

  const setConversationFolder = (conversationId: Conversation["id"], folderId: string | null) => {
    const key = String(conversationId);
    setConversationFolders((prev) => {
      if (!folderId) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === folderId) return prev;
      return {
        ...prev,
        [key]: folderId,
      };
    });
  };

  const touchFolder = (folderId: string | null) => {
    if (!folderId) return;
    setChatFolders((prev) =>
      prev.map((folder) =>
        folder.id === folderId
          ? {
              ...folder,
              updatedAt: nowIso(),
            }
          : folder,
      ),
    );
  };

  const persistConversationOrder = (
    movedConversationId?: string,
  ) => {
    const orderedIds = [
      ...(movedConversationId ? [movedConversationId] : []),
      ...activeConversations
        .map((conversation) => String(conversation.id))
        .filter((id) => id !== movedConversationId),
    ];
    if (orderedIds.length === 0) return;

    void Promise.resolve(onReorderConversations(orderedIds)).catch((error) => {
      console.error("Failed to reorder conversations", error);
      setSidebarError(`Failed to reorder conversations: ${String(error)}`);
    });
  };

  const canDropIntoFolder = (
    entity: ChatDragEntity | null,
    targetFolderId: string,
  ): boolean => {
    if (!entity) return false;
    if (!folderById.has(targetFolderId)) return false;

    if (entity.kind === "conversation") {
      const currentFolderId = conversationFolders[entity.id] ?? null;
      return currentFolderId !== targetFolderId;
    }

    if (entity.id === targetFolderId) return false;
    const descendants = getFolderDescendants(chatFolders, entity.id);
    return !descendants.has(targetFolderId);
  };

  const canDropToRoot = (entity: ChatDragEntity | null): boolean => {
    if (!entity) return false;
    if (entity.kind === "conversation") {
      return Boolean(conversationFolders[entity.id]) || activeConversations.length > 1;
    }

    const folder = folderById.get(entity.id);
    if (!folder) return false;
    return folder.parentId !== null;
  };

  const dropEntityToFolder = (entity: ChatDragEntity, targetFolderId: string) => {
    if (!canDropIntoFolder(entity, targetFolderId)) {
      resetDragState();
      return;
    }

    if (entity.kind === "conversation") {
      setConversationFolder(entity.id, targetFolderId);
      touchFolder(targetFolderId);
      setExpandedFolderIds((prev) => {
        const next = new Set(prev);
        next.add(targetFolderId);
        return next;
      });
      resetDragState();
      return;
    }

    setChatFolders((prev) =>
      sortFoldersByRecent(
        prev.map((folder) =>
          folder.id === entity.id
            ? {
                ...folder,
                parentId: targetFolderId,
                updatedAt: nowIso(),
              }
            : folder,
        ),
      ),
    );
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      next.add(targetFolderId);
      return next;
    });
    resetDragState();
  };

  const dropEntityToRoot = (entity: ChatDragEntity) => {
    if (!canDropToRoot(entity)) {
      resetDragState();
      return;
    }

    if (entity.kind === "conversation") {
      setConversationFolder(entity.id, null);
      persistConversationOrder(entity.id);
      resetDragState();
      return;
    }

    setChatFolders((prev) =>
      sortFoldersByRecent(
        prev.map((folder) =>
          folder.id === entity.id
            ? {
                ...folder,
                parentId: null,
                updatedAt: nowIso(),
              }
            : folder,
        ),
      ),
    );
    resetDragState();
  };

  const toggleFolderExpanded = (folderId: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const toggleFolderPin = (folder: ChatFolder) => {
    setContextMenu(null);
    setChatFolders((prev) =>
      sortFoldersByRecent(
        prev.map((candidate) =>
          candidate.id === folder.id
            ? {
                ...candidate,
                pinned: !candidate.pinned,
                updatedAt: nowIso(),
              }
            : candidate,
        ),
      ),
    );
  };

  const archiveFolder = (folder: ChatFolder) => {
    setContextMenu(null);
    const descendants = getFolderDescendants(chatFolders, folder.id);

    setChatFolders((prev) =>
      prev.map((candidate) =>
        descendants.has(candidate.id)
          ? {
              ...candidate,
              archived: true,
              pinned: false,
              updatedAt: nowIso(),
            }
          : candidate,
      ),
    );

    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      descendants.forEach((id) => next.delete(id));
      return next;
    });

    setConversationFolders((prev) => {
      const next: Record<string, string> = Object.create(null);
      for (const [conversationId, folderId] of Object.entries(prev)) {
        if (descendants.has(folderId)) continue;
        next[conversationId] = folderId;
      }
      return next;
    });
  };

  const startNewChat = (folderId: string | null = null) => {
    setContextMenu(null);
    setEditingConversationId(null);
    setEditingFolderId(null);
    setPendingFolderForNewChat(folderId);
    setViewMode("chats");
    onNewChat();
  };

  type SidebarHandlers = ConversationRowHandlers & ChatFolderRowHandlers;

  const sidebarHandlersRef = useRef<SidebarHandlers>(null!);
  sidebarHandlersRef.current = {
    selectConversation: (conversationId) => onSelectConversation(conversationId),
    beginRenameConversation: (conversationId) => {
      const conversation = conversations.find((c) =>
        sameConversation(c.id, conversationId),
      );
      if (conversation) beginRenameConversation(conversation);
    },
    contextMenu: (event, conversationId) =>
      openContextMenu(event, { kind: "conversation", id: conversationId }),
    conversationDragStart: (event, conversationId) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-meld-chat-kind", "conversation");
      event.dataTransfer.setData("application/x-meld-chat-id", conversationId);
      const entity: ChatDragEntity = { kind: "conversation", id: conversationId };
      draggingEntityRef.current = entity;
      setDraggingEntity(entity);
    },
    dragEnd: resetDragState,
    conversationDragOver: (event, _conversationId, parentFolderId) => {
      const entity = resolveDraggingEntity(event);
      if (!entity) return;
      const shouldDropToRoot = parentFolderId === null;
      const canDrop = shouldDropToRoot
        ? canDropToRoot(entity)
        : canDropIntoFolder(entity, parentFolderId);
      if (!canDrop) return;
      event.preventDefault();
      event.stopPropagation();
      if (shouldDropToRoot) {
        setDropTarget({ kind: "root" });
      } else {
        setDropTarget({ kind: "folder", folderId: parentFolderId });
      }
    },
    conversationDrop: (event, _conversationId, parentFolderId) => {
      const entity = resolveDraggingEntity(event);
      if (!entity) return;
      event.preventDefault();
      event.stopPropagation();
      if (parentFolderId === null) {
        dropEntityToRoot(entity);
      } else {
        dropEntityToFolder(entity, parentFolderId);
      }
    },
    toggleFolderExpanded: toggleFolderExpanded,
    folderContextMenu: (event, folderId) =>
      openContextMenu(event, { kind: "folder", id: folderId }),
    folderDragStart: (event, folderId) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-meld-chat-kind", "folder");
      event.dataTransfer.setData("application/x-meld-chat-id", folderId);
      const entity: ChatDragEntity = { kind: "folder", id: folderId };
      draggingEntityRef.current = entity;
      setDraggingEntity(entity);
    },
    folderDragOver: (event, folderId) => {
      const entity = resolveDraggingEntity(event);
      if (!canDropIntoFolder(entity, folderId)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget({ kind: "folder", folderId });
    },
    folderDragLeave: (folderId) => {
      if (dropTarget?.kind === "folder" && dropTarget.folderId === folderId) {
        setDropTarget(null);
      }
    },
    folderDrop: (event, folderId) => {
      const entity = resolveDraggingEntity(event);
      if (!entity) return;
      event.preventDefault();
      event.stopPropagation();
      dropEntityToFolder(entity, folderId);
    },
    draftChange: setDraftTitle,
    submitRenameConversation: (conversationId) => {
      const conversation = conversations.find((c) =>
        sameConversation(c.id, conversationId),
      );
      if (conversation) void submitRenameConversation(conversation);
    },
    submitRenameFolder: (folderId) => {
      const folder = chatFolders.find((f) => f.id === folderId);
      if (folder) void submitRenameFolder(folder);
    },
    cancelRename,
  };

  const createRootKnowledgeNote = async () => {
    const path = createKnowledgeNoteName(vaultEntries);
    try {
      await onCreateKbNote(path);
      onSelectNote(path);
    } catch (error) {
      console.error("Failed to create note", error);
      setSidebarError(`Failed to create note: ${String(error)}`);
    }
  };

  const createRootKnowledgeFolder = async () => {
    const path = createKnowledgeFolderName(vaultEntries);
    try {
      await onCreateKbFolder(path);
    } catch (error) {
      console.error("Failed to create folder", error);
      setSidebarError(`Failed to create folder: ${String(error)}`);
    }
  };

  const renderConversationRow = (conversation: Conversation, depth: number) => {
    const conversationId = String(conversation.id);
    return (
      <ConversationRow
        key={`conversation:${conversationId}`}
        conversationId={conversationId}
        title={getConversationTitle(conversation)}
        depth={depth}
        isActive={activeConversationId !== null && sameConversation(conversation.id, activeConversationId)}
        isEditing={editingConversationId !== null && sameConversation(editingConversationId, conversation.id)}
        isPinned={Boolean(conversation.pinned)}
        parentFolderId={conversationFolders[conversationId] ?? null}
        draftTitle={draftTitle}
        savingRename={savingRename}
        handlers={sidebarHandlersRef}
      />
    );
  };

  const renderFolderRow = (folder: ChatFolder, depth: number): React.ReactNode => {
    const childFolders = foldersByParent.get(folder.id) ?? [];
    const childConversations = conversationsByFolder.get(folder.id) ?? [];
    const isExpanded = expandedFolderIds.has(folder.id);

    return (
      <ChatFolderRow
        key={`folder:${folder.id}`}
        folderId={folder.id}
        name={folder.name}
        depth={depth}
        isExpanded={isExpanded}
        isDrop={dropTarget?.kind === "folder" && dropTarget.folderId === folder.id}
        isEditing={editingFolderId === folder.id}
        isPinned={folder.pinned}
        draftTitle={draftTitle}
        savingRename={savingRename}
        handlers={sidebarHandlersRef}
      >
        {isExpanded && (
          <>
            {childFolders.map((child) => renderFolderRow(child, depth + 1))}
            {childConversations.map((conversation) =>
              renderConversationRow(conversation, depth + 1),
            )}
          </>
        )}
      </ChatFolderRow>
    );
  };

  const rootFolders = foldersByParent.get(null) ?? [];
  const rootConversations = conversationsByFolder.get(null) ?? [];

  const selectedMenuConversation =
    contextMenu?.target.kind === "conversation"
      ? conversations.find((conversation) =>
          sameConversation(conversation.id, contextMenu.target.id),
        )
      : null;

  const selectedMenuFolder =
    contextMenu?.target.kind === "folder"
      ? visibleFolders.find((folder) => folder.id === contextMenu.target.id) ?? null
      : null;
  const selectedMenuRoot = contextMenu?.target.kind === "root";

  const contextMenuNode =
    contextMenu && typeof document !== "undefined"
      ? createPortal(
          <div
            data-sidebar-context-menu
            role="menu"
            className="animate-fade-in fixed z-[220] min-w-[188px] rounded-lg border border-border/70 bg-bg-secondary/95 p-1 shadow-lg shadow-black/25 backdrop-blur-md"
            style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          >
            {selectedMenuConversation && (
              <>
                <button
                  type="button"
                  onClick={() => beginRenameConversation(selectedMenuConversation)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                >
                  <span>Rename</span>
                  <span>✎</span>
                </button>
                {selectedMenuConversation.archived ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        void unarchiveConversationRow(selectedMenuConversation);
                      }}
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                    >
                      <span>Unarchive</span>
                      <span>↶</span>
                    </button>
                  </>
                ) : (
                  <>
                    {selectedMenuConversation.pinned ? (
                      <button
                        type="button"
                        onClick={() => {
                          void unpinConversationRow(selectedMenuConversation);
                        }}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                      >
                        <span>Unpin</span>
                        <span>⌁</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          void pinConversationRow(selectedMenuConversation);
                        }}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                      >
                        <span>Pin</span>
                        <span>⌁</span>
                      </button>
                    )}
                    {conversationFolders[String(selectedMenuConversation.id)] && (
                      <button
                        type="button"
                        onClick={() => {
                          setContextMenu(null);
                          setConversationFolder(selectedMenuConversation.id, null);
                          persistConversationOrder(String(selectedMenuConversation.id));
                        }}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                      >
                        <span>Move to root</span>
                        <span>↤</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        void archiveConversationRow(selectedMenuConversation);
                      }}
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-error transition-colors hover:bg-error/10"
                    >
                      <span>Archive</span>
                      <span>↧</span>
                    </button>
                  </>
                )}
              </>
            )}

            {selectedMenuFolder && (
              <>
                <button
                  type="button"
                  onClick={() => startNewChat(selectedMenuFolder.id)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                >
                  <span>New chat</span>
                  <span>＋</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setContextMenu(null);
                    createFolder(selectedMenuFolder.id);
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                >
                  <span>New folder</span>
                  <span>＋</span>
                </button>
                <button
                  type="button"
                  onClick={() => beginRenameFolder(selectedMenuFolder)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                >
                  <span>Rename</span>
                  <span>✎</span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleFolderPin(selectedMenuFolder)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                >
                  <span>{selectedMenuFolder.pinned ? "Unpin" : "Pin"}</span>
                  <span>⌁</span>
                </button>
                <button
                  type="button"
                  onClick={() => archiveFolder(selectedMenuFolder)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-error transition-colors hover:bg-error/10"
                >
                  <span>Archive folder</span>
                  <span>↧</span>
                </button>
              </>
            )}

            {selectedMenuRoot && (
              <>
                <button
                  type="button"
                  onClick={() => startNewChat(null)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                >
                  <span>New chat</span>
                  <span>＋</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setContextMenu(null);
                    createFolder(null);
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                >
                  <span>New folder</span>
                  <span>＋</span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <aside
        className={`h-full shrink-0 bg-bg-secondary/40 transition-[width] duration-[180ms] ease-out ${
          sidebarCollapsed ? "w-14" : "w-[248px]"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="p-3 pb-3.5">
            {!sidebarCollapsed && (
              <div className="mb-3 grid grid-cols-2 rounded-xl bg-bg/50 p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("chats")}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${
                    viewMode === "chats"
                      ? "bg-bg-tertiary text-text"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  Chats
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("files")}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${
                    viewMode === "files"
                      ? "bg-bg-tertiary text-text"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  Knowledge
                </button>
              </div>
            )}

            {sidebarCollapsed && (
              <div className="mb-3 flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => setViewMode("chats")}
                  className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                    viewMode === "chats"
                      ? "bg-bg-tertiary text-text"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                  title="Chats"
                >
                  C
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("files")}
                  className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                    viewMode === "files"
                      ? "bg-bg-tertiary text-text"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                  title="Knowledge"
                >
                  K
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                if (viewMode === "chats") {
                  startNewChat(null);
                  return;
                }
                void createRootKnowledgeNote();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-accent/20 bg-accent/[0.06] px-2 py-2 text-sm text-accent/80 transition-all duration-[120ms] hover:bg-accent/[0.12] hover:text-accent hover:border-accent/30"
              title={viewMode === "chats" ? "New chat" : "New note"}
            >
              <span className="text-base leading-none">+</span>
              {!sidebarCollapsed && (
                <span>{viewMode === "chats" ? "New chat" : "New note"}</span>
              )}
            </button>

            {!sidebarCollapsed && (
              <button
                type="button"
                onClick={() => {
                  if (viewMode === "chats") {
                    createFolder(null);
                    return;
                  }
                  void createRootKnowledgeFolder();
                }}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-border/20 bg-bg-tertiary/30 px-2 py-1.5 text-xs text-text-secondary transition-all duration-[120ms] hover:bg-bg-tertiary/60 hover:text-text hover:border-border/40"
                title="New folder"
              >
                <span className="text-sm leading-none">+</span>
                <span>New folder</span>
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden px-2.5 py-2">
            {viewMode === "files" ? (
              sidebarCollapsed ? null : (
                <VaultBrowser
                  entries={vaultEntries}
                  loading={loadingVaultFiles}
                  activeNote={activeNotePath}
                  onSelectNote={onSelectNote}
                  onCreateNote={onCreateKbNote}
                  onCreateFolder={onCreateKbFolder}
                  onArchiveEntry={onArchiveKbEntry}
                  onMoveEntry={onMoveKbEntry}
                />
              )
            ) : (
              <TreeSurface
                onRootContextMenu={(event) => {
                  openContextMenu(event, { kind: "root", id: "root" });
                }}
                onRootDragOver={(event) => {
                  const entity = resolveDraggingEntity(event);
                  if (!canDropToRoot(entity)) return;
                  event.preventDefault();
                  setDropTarget({ kind: "root" });
                }}
                onRootDragLeave={(event) => {
                  if (event.currentTarget !== event.target) return;
                  if (dropTarget?.kind === "root") {
                    setDropTarget(null);
                  }
                }}
                onRootDrop={(event) => {
                  const entity = resolveDraggingEntity(event);
                  if (!entity) return;
                  event.preventDefault();
                  event.stopPropagation();
                  dropEntityToRoot(entity);
                }}
              >
                {!sidebarCollapsed && rootFolders.map((folder) => renderFolderRow(folder, 0))}
                {!sidebarCollapsed &&
                  rootConversations.map((conversation) =>
                    renderConversationRow(conversation, 0),
                  )}

                {sidebarCollapsed && (
                  <div>
                    {activeConversations.map((conversation) =>
                      renderConversationRow(conversation, 0),
                    )}
                  </div>
                )}

                {!sidebarCollapsed && archivedConversations.length > 0 && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setShowArchived((prev) => !prev)}
                      className="mb-1.5 flex w-full items-center justify-between px-1 text-[10px] font-mono uppercase tracking-widest text-text-muted/70 hover:text-text-secondary"
                    >
                      <span>Archived ({archivedConversations.length})</span>
                      <span>{showArchived ? "▾" : "▸"}</span>
                    </button>
                    {showArchived && (
                      <div>
                        {archivedConversations.map((conversation) => {
                          const title = getConversationTitle(conversation);
                          return (
                            <div
                              key={`archived:${String(conversation.id)}`}
                              onContextMenu={(event) => {
                                openContextMenu(event, {
                                  kind: "conversation",
                                  id: String(conversation.id),
                                });
                              }}
                              className="group relative flex w-full min-w-0 items-center rounded-lg px-2.5 py-2 text-left text-[13px] transition-all duration-[120ms] text-text-secondary hover:bg-bg-tertiary/50 hover:text-text"
                              style={{ paddingLeft: "8px" }}
                            >
                              <button
                                type="button"
                                onClick={() => onSelectConversation(conversation.id)}
                                title={title}
                                className="min-w-0 flex-1 truncate text-left"
                              >
                                {title}
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void unarchiveConversationRow(conversation);
                                }}
                                className="rounded px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                              >
                                Unarchive
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {!sidebarCollapsed &&
                  activeConversations.length === 0 &&
                  archivedConversations.length === 0 && (
                    <p className="px-2 text-xs text-text-muted/60">No chats yet.</p>
                  )}
              </TreeSurface>
            )}
          </div>

          <div className="p-3 pt-3.5">
            {!sidebarCollapsed && sidebarError && (
              <p className="mb-2 rounded-md border border-error/40 bg-error/[0.08] px-2 py-1.5 text-[11px] text-error">
                {sidebarError}
              </p>
            )}
            <button
              onClick={toggleSidebarCollapsed}
              className="flex w-full items-center justify-center gap-2 rounded-xl px-2 py-1.5 text-sm text-text-muted transition-all duration-[120ms] hover:bg-bg-tertiary/60 hover:text-text-secondary"
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <span className="text-xs">{sidebarCollapsed ? ">>" : "<<"}</span>
              {!sidebarCollapsed && <span>Collapse</span>}
            </button>
          </div>
        </div>
      </aside>

      {contextMenuNode}
    </>
  );
}
