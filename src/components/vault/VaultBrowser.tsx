"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { VaultEntry } from "@/lib/tauri";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import PromptDialog from "@/components/ui/PromptDialog";
import TreeSurface from "@/components/tree/TreeSurface";
import { useTreeDndState } from "@/components/tree/useTreeDndState";
import { useTreeContextMenu } from "@/features/shared/tree/useTreeContextMenu";
import VaultFileRow, { type VaultFileHandlers } from "./VaultFileRow";
import VaultFolderRow, { type VaultFolderHandlers } from "./VaultFolderRow";

interface VaultBrowserProps {
  entries: VaultEntry[];
  loading: boolean;
  activeNote: string | null;
  onSelectNote: (path: string) => void;
  onCreateNote: (path: string) => Promise<void> | void;
  onCreateFolder: (path: string) => Promise<void> | void;
  onArchiveEntry: (path: string) => Promise<void> | void;
  onMoveEntry: (fromPath: string, toPath: string) => Promise<void> | void;
}

type TreeNode =
  | {
      kind: "folder";
      name: string;
      path: string;
      children: TreeNode[];
    }
  | {
      kind: "file";
      name: string;
      path: string;
    };

interface MutableFolderNode {
  name: string;
  path: string;
  folders: Record<string, MutableFolderNode>;
  files: TreeNode[];
}

type MenuTarget = {
  kind: "root" | "folder" | "file";
  path: string | null;
};

type PromptDialogMode = "create-note" | "create-folder";

interface PromptDialogState {
  mode: PromptDialogMode;
  title: string;
  description?: string;
  initialValue: string;
  confirmLabel: string;
}

const KB_PIN_STORAGE_KEY = "meld.kb-pins.v1";

function loadPinnedPaths(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KB_PIN_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeRelativePath(value))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function savePinnedPaths(paths: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KB_PIN_STORAGE_KEY, JSON.stringify([...paths]));
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function fileOrFolderName(path: string): string {
  const normalized = normalizeRelativePath(path);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function parentPath(path: string): string {
  const normalized = normalizeRelativePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function buildTree(
  entries: VaultEntry[],
  pinnedPaths: Set<string>,
  updatedAtByPath: Record<string, number>,
): TreeNode[] {
  const root: MutableFolderNode = {
    name: "",
    path: "",
    folders: Object.create(null),
    files: [],
  };

  const folders = entries
    .filter((entry) => entry.kind === "folder")
    .map((entry) => normalizeRelativePath(entry.relative_path))
    .filter(Boolean)
    .sort((left, right) => left.length - right.length);

  for (const folderPath of folders) {
    const parts = folderPath.split("/").filter(Boolean);
    let cursor = root;
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let next = cursor.folders[part];
      if (!next) {
        next = {
          name: part,
          path: currentPath,
          folders: Object.create(null),
          files: [],
        };
        cursor.folders[part] = next;
      }
      cursor = next;
    }
  }

  const files = entries.filter((entry) => entry.kind === "file");
  for (const entry of files) {
    const relativePath = normalizeRelativePath(entry.relative_path);
    if (!relativePath) continue;

    const parts = relativePath.split("/").filter(Boolean);
    if (!parts.length) continue;

    let cursor = root;
    let folderPath = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      folderPath = folderPath ? `${folderPath}/${part}` : part;
      let next = cursor.folders[part];
      if (!next) {
        next = {
          name: part,
          path: folderPath,
          folders: Object.create(null),
          files: [],
        };
        cursor.folders[part] = next;
      }
      cursor = next;
    }

    const fileName = parts[parts.length - 1];
    cursor.files.push({
      kind: "file",
      name: fileName,
      path: relativePath,
    });
  }

  const folderUpdatedCache = new Map<string, number>();

  const getFolderUpdatedAt = (folder: MutableFolderNode): number => {
    if (folderUpdatedCache.has(folder.path)) {
      return folderUpdatedCache.get(folder.path) ?? 0;
    }

    let latest = folder.path ? updatedAtByPath[folder.path] ?? 0 : 0;
    for (const childFolder of Object.values(folder.folders)) {
      latest = Math.max(latest, getFolderUpdatedAt(childFolder));
    }
    for (const fileNode of folder.files) {
      latest = Math.max(latest, updatedAtByPath[fileNode.path] ?? 0);
    }

    folderUpdatedCache.set(folder.path, latest);
    return latest;
  };

  const toTree = (folder: MutableFolderNode): TreeNode[] => {
    const folders = Object.values(folder.folders)
      .sort((left, right) => {
        const leftPinned = Number(pinnedPaths.has(left.path));
        const rightPinned = Number(pinnedPaths.has(right.path));
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;

        const leftUpdated = getFolderUpdatedAt(left);
        const rightUpdated = getFolderUpdatedAt(right);
        if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;

        return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
      })
      .map((item) => ({
        kind: "folder" as const,
        name: item.name,
        path: item.path,
        children: toTree(item),
      }));

    const files = [...folder.files].sort((left, right) => {
      const leftPinned = Number(pinnedPaths.has(left.path));
      const rightPinned = Number(pinnedPaths.has(right.path));
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;

      const leftUpdated = updatedAtByPath[left.path] ?? 0;
      const rightUpdated = updatedAtByPath[right.path] ?? 0;
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;

      return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
    });

    return [...folders, ...files];
  };

  return toTree(root);
}

function ancestorsOf(path: string): string[] {
  const normalized = normalizeRelativePath(path);
  if (!normalized) return [];

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return [];

  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join("/"));
  }
  return result;
}

export interface VaultBrowserHandlers extends VaultFileHandlers, VaultFolderHandlers {}

export default function VaultBrowser({
  entries,
  loading,
  activeNote,
  onSelectNote,
  onCreateNote,
  onCreateFolder,
  onArchiveEntry,
  onMoveEntry,
}: VaultBrowserProps) {
  const expandedDefaultsAppliedRef = useRef(false);
  const draggingPathRef = useRef<string | null>(null);
  const {
    contextMenu,
    setContextMenu,
    openContextMenu: openTreeContextMenu,
  } = useTreeContextMenu<MenuTarget>({
    menuDataAttribute: "data-vault-context-menu",
  });
  const [pinnedPaths, setPinnedPaths] = useState<Set<string>>(new Set());
  const updatedAtByPath = useMemo(() => {
    const byPath: Record<string, number> = Object.create(null);
    for (const entry of entries) {
      const normalized = normalizeRelativePath(entry.relative_path);
      if (!normalized) continue;
      const updated = typeof entry.updated_at === "number" ? entry.updated_at : 0;
      byPath[normalized] = updated;
    }
    return byPath;
  }, [entries]);
  const tree = useMemo(
    () => buildTree(entries, pinnedPaths, updatedAtByPath),
    [entries, pinnedPaths, updatedAtByPath],
  );
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [promptDialog, setPromptDialog] = useState<PromptDialogState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    kind: "file" | "folder";
  } | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const {
    draggingEntity: draggingPath,
    setDraggingEntity: setDraggingPath,
    dropTarget,
    setDropTarget,
    clearDragState,
  } = useTreeDndState<string, string>();

  const resetDragState = () => {
    draggingPathRef.current = null;
    clearDragState();
  };

  const entryKindByPath = useMemo(() => {
    const kinds: Record<string, "file" | "folder"> = Object.create(null);
    for (const entry of entries) {
      const normalized = normalizeRelativePath(entry.relative_path);
      if (!normalized) continue;
      kinds[normalized] = entry.kind;
    }
    return kinds;
  }, [entries]);

  useEffect(() => {
    if (expandedDefaultsAppliedRef.current) return;
    const topLevelFolders = tree
      .filter((node): node is Extract<TreeNode, { kind: "folder" }> => node.kind === "folder")
      .map((node) => node.path);
    if (topLevelFolders.length === 0) return;

    setExpandedFolders((prev) => {
      const next = new Set(prev);
      for (const path of topLevelFolders) {
        next.add(path);
      }
      return next;
    });
    expandedDefaultsAppliedRef.current = true;
  }, [tree]);

  useEffect(() => {
    setPinnedPaths(loadPinnedPaths());
  }, []);

  useEffect(() => {
    savePinnedPaths(pinnedPaths);
  }, [pinnedPaths]);

  useEffect(() => {
    if (pinnedPaths.size === 0) return;
    const valid = new Set(
      entries
        .map((entry) => normalizeRelativePath(entry.relative_path))
        .filter(Boolean),
    );
    let changed = false;
    const next = new Set<string>();
    for (const path of pinnedPaths) {
      if (!valid.has(path)) {
        changed = true;
        continue;
      }
      next.add(path);
    }
    if (changed) {
      setPinnedPaths(next);
    }
  }, [entries, pinnedPaths]);

  useEffect(() => {
    if (!activeNote) return;
    const activeAncestors = ancestorsOf(activeNote);
    if (activeAncestors.length === 0) return;

    setExpandedFolders((prev) => {
      const missing = activeAncestors.some((path) => !prev.has(path));
      if (!missing) return prev;
      const next = new Set(prev);
      for (const path of activeAncestors) {
        next.add(path);
      }
      return next;
    });
  }, [activeNote]);

  useEffect(() => {
    if (!actionError) return;
    const timeoutId = window.setTimeout(() => {
      setActionError(null);
    }, 3600);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [actionError]);

  useEffect(() => {
    if (!editingPath) return;
    const normalizedEditingPath = normalizeRelativePath(editingPath);
    const stillExists = entries.some((entry) => {
      return normalizeRelativePath(entry.relative_path) === normalizedEditingPath;
    });
    if (stillExists) return;
    setEditingPath(null);
    setDraftName("");
    setSavingRename(false);
  }, [editingPath, entries]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    target: MenuTarget,
  ) => {
    const menuWidth = 196;
    const menuHeight =
      target.kind === "folder" ? 210 : target.kind === "file" ? 170 : 124;
    openTreeContextMenu(event, target, {
      mode: target.kind === "root" ? "pointer" : "row",
      menuWidth,
      menuHeight,
    });
  };

  const runAction = async (action: () => Promise<void> | void) => {
    setContextMenu(null);
    try {
      await action();
      setActionError(null);
    } catch (error) {
      console.error("Vault action failed:", error);
      const message =
        error instanceof Error ? error.message : String(error ?? "Unknown error");
      setActionError(message);
    }
  };

  const requestCreateNote = (folderPath: string | null) => {
    const prefix = folderPath ? `${folderPath}/` : "";
    setContextMenu(null);
    setPromptDialog({
      mode: "create-note",
      title: "Create note",
      description:
        "Enter note path (relative to Knowledge root). You can include nested folders.",
      initialValue: prefix,
      confirmLabel: "Create",
    });
  };

  const requestCreateFolder = (folderPath: string | null) => {
    const prefix = folderPath ? `${folderPath}/` : "";
    setContextMenu(null);
    setPromptDialog({
      mode: "create-folder",
      title: "Create folder",
      description: "Enter folder path (relative to Knowledge root).",
      initialValue: prefix,
      confirmLabel: "Create",
    });
  };

  const requestRename = (path: string) => {
    setContextMenu(null);
    setEditingPath(path);
    setDraftName(fileOrFolderName(path));
    setSavingRename(false);
    setActionError(null);
  };

  const requestDelete = (path: string, kind: "file" | "folder") => {
    setContextMenu(null);
    setPendingDelete({ path, kind });
  };

  const togglePin = (path: string) => {
    const normalized = normalizeRelativePath(path);
    if (!normalized) return;
    setContextMenu(null);
    setPinnedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(normalized)) {
        next.delete(normalized);
      } else {
        next.add(normalized);
      }
      return next;
    });
  };

  const handlePromptConfirm = (rawValue: string) => {
    const dialog = promptDialog;
    if (!dialog) return;

    const normalizedValue = rawValue.trim();
    if (!normalizedValue) return;

    setPromptDialog(null);

    if (dialog.mode === "create-note") {
      void runAction(async () => {
        await onCreateNote(normalizedValue);
      });
      return;
    }

    if (dialog.mode === "create-folder") {
      void runAction(async () => {
        await onCreateFolder(normalizedValue);
      });
      return;
    }
  };

  const cancelInlineRename = () => {
    if (savingRename) return;
    setEditingPath(null);
    setDraftName("");
  };

  const submitInlineRename = async (path: string) => {
    if (savingRename) return;

    const currentName = fileOrFolderName(path);
    const nextName = draftName.trim();
    if (!nextName) {
      setDraftName(currentName);
      setEditingPath(null);
      return;
    }
    if (nextName === currentName) {
      setEditingPath(null);
      return;
    }

    const parent = parentPath(path);
    const nextPath = parent ? `${parent}/${nextName}` : nextName;

    setSavingRename(true);
    try {
      await onMoveEntry(path, nextPath);
      setEditingPath(null);
      setDraftName("");
      setActionError(null);
    } catch (error) {
      console.error("Vault rename failed:", error);
      const message =
        error instanceof Error ? error.message : String(error ?? "Unknown error");
      setActionError(message);
    } finally {
      setSavingRename(false);
    }
  };

  const handleDeleteConfirm = () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    void runAction(async () => {
      await onArchiveEntry(target.path);
    });
  };

  const renderContextMenuItems = (target: MenuTarget) => (
    <>
      {target.kind === "root" && (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => requestCreateNote(null)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>New note</span>
            <span>＋</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => requestCreateFolder(null)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>New folder</span>
            <span>＋</span>
          </button>
        </>
      )}

      {target.kind === "folder" && target.path && (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => requestCreateNote(target.path)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>New note</span>
            <span>＋</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => requestCreateFolder(target.path)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>New folder</span>
            <span>＋</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => requestRename(target.path as string)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>Rename</span>
            <span>✎</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => togglePin(target.path as string)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>
              {pinnedPaths.has(normalizeRelativePath(target.path as string))
                ? "Unpin"
                : "Pin"}
            </span>
            <span>⌁</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => requestDelete(target.path as string, "folder")}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-error transition-colors hover:bg-error/10"
          >
            <span>Archive</span>
            <span>↧</span>
          </button>
        </>
      )}

      {target.kind === "file" && target.path && (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              onSelectNote(target.path as string);
            }}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>Open</span>
            <span>↩</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => requestRename(target.path as string)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>Rename</span>
            <span>✎</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => togglePin(target.path as string)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
          >
            <span>
              {pinnedPaths.has(normalizeRelativePath(target.path as string))
                ? "Unpin"
                : "Pin"}
            </span>
            <span>⌁</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => requestDelete(target.path as string, "file")}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-error transition-colors hover:bg-error/10"
          >
            <span>Archive</span>
            <span>↧</span>
          </button>
        </>
      )}
    </>
  );

  const canDropInto = (sourcePath: string, targetFolderPath: string): boolean => {
    const normalizedSource = normalizeRelativePath(sourcePath).toLowerCase();
    const normalizedTarget = normalizeRelativePath(targetFolderPath).toLowerCase();
    const sourceKind = entryKindByPath[normalizeRelativePath(sourcePath)];
    if (!sourceKind) return false;

    if (sourceKind === "folder") {
      if (
        normalizedTarget === normalizedSource ||
        normalizedTarget.startsWith(`${normalizedSource}/`)
      ) {
        return false;
      }
    }

    const sourceName = fileOrFolderName(sourcePath);
    const targetPath = normalizedTarget ? `${normalizedTarget}/${sourceName}` : sourceName;
    return targetPath.toLowerCase() !== normalizedSource;
  };

  const handleDropMove = (
    event: React.DragEvent<HTMLElement>,
    targetFolderPath: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const sourcePath =
      event.dataTransfer.getData("application/x-meld-entry-path") ||
      event.dataTransfer.getData("text/plain") ||
      draggingPathRef.current ||
      draggingPath ||
      "";
    const normalizedSource = normalizeRelativePath(sourcePath);
    const normalizedTarget = normalizeRelativePath(targetFolderPath);
    setDropTarget(null);
    resetDragState();

    if (!normalizedSource || !canDropInto(normalizedSource, normalizedTarget)) {
      return;
    }

    const targetPath = normalizedTarget
      ? `${normalizedTarget}/${fileOrFolderName(normalizedSource)}`
      : fileOrFolderName(normalizedSource);

    void runAction(async () => {
      await onMoveEntry(normalizedSource, targetPath);
    });
  };

  const handlersRef = useRef<VaultBrowserHandlers>(null!);
  handlersRef.current = {
    selectNote: onSelectNote,
    toggleFolder,
    contextMenu: (event, path) =>
      openContextMenu(event, {
        kind: entryKindByPath[normalizeRelativePath(path)] === "folder" ? "folder" : "file",
        path,
      }),
    dragStart: (event, path) => {
      event.dataTransfer.setData("application/x-meld-entry-path", path);
      event.dataTransfer.setData("text/plain", path);
      draggingPathRef.current = path;
      setDraggingPath(path);
    },
    dragEnd: resetDragState,
    fileDragOver: (event, filePath) => {
      if (!draggingPathRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const targetFolder = parentPath(filePath);
      const normalizedSource = normalizeRelativePath(draggingPathRef.current);
      if (normalizedSource && canDropInto(normalizedSource, targetFolder)) {
        setDropTarget(targetFolder);
      }
    },
    folderDragOver: (event, folderPath) => {
      if (!draggingPathRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const normalizedSource = normalizeRelativePath(draggingPathRef.current);
      if (normalizedSource && canDropInto(normalizedSource, folderPath)) {
        setDropTarget(folderPath);
      }
    },
    folderDragLeave: (event, folderPath) => {
      event.stopPropagation();
      if (dropTarget === folderPath) setDropTarget(null);
    },
    fileDrop: (event, filePath) => handleDropMove(event, parentPath(filePath)),
    folderDrop: (event, folderPath) => handleDropMove(event, folderPath),
    draftChange: setDraftName,
    submitRename: (path) => {
      void submitInlineRename(path);
    },
    cancelRename: cancelInlineRename,
  };

  const normalizedActiveNote = normalizeRelativePath(activeNote ?? "");

  const renderNode = (node: TreeNode, depth: number) => {
    if (node.kind === "folder") {
      return (
        <VaultFolderRow
          key={`folder:${node.path}`}
          path={node.path}
          name={node.name}
          depth={depth}
          isExpanded={expandedFolders.has(node.path)}
          isDrop={dropTarget === node.path}
          isEditing={editingPath === node.path}
          isPinned={pinnedPaths.has(node.path)}
          draftName={draftName}
          savingRename={savingRename}
          handlers={handlersRef}
        >
          {node.children.map((child) => renderNode(child, depth + 1))}
        </VaultFolderRow>
      );
    }

    return (
      <VaultFileRow
        key={`file:${node.path}`}
        path={node.path}
        name={node.name}
        depth={depth}
        isActive={normalizedActiveNote === node.path}
        isDrop={false}
        isEditing={editingPath === node.path}
        isPinned={pinnedPaths.has(node.path)}
        draftName={draftName}
        savingRename={savingRename}
        handlers={handlersRef}
      />
    );
  };

  if (loading && tree.length === 0) {
    return (
      <div className="flex items-center justify-center py-6">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted/60 border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <TreeSurface
        onRootContextMenu={(event) =>
          openContextMenu(event, { kind: "root", path: null })
        }
        onRootDragOver={(event) => {
          if (!draggingPathRef.current) return;
          event.preventDefault();
          const normalizedSource = normalizeRelativePath(draggingPathRef.current);
          if (normalizedSource && canDropInto(normalizedSource, "")) {
            setDropTarget("");
          }
        }}
        onRootDragLeave={(event) => {
          if (event.currentTarget !== event.target) return;
          if (dropTarget === "") {
            setDropTarget(null);
          }
        }}
        onRootDrop={(event) => handleDropMove(event, "")}
      >
        {tree.length === 0 ? (
          <p className="px-2 text-xs text-text-muted/60">
            No notes yet. Right click to create your first note.
          </p>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}

        {loading && tree.length > 0 && (
          <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-border/60 bg-bg-secondary/75 px-2 py-1 backdrop-blur-sm">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text-muted/60 border-t-transparent" />
          </div>
        )}

        {actionError && !contextMenu && (
          <div className="absolute inset-x-1.5 bottom-1 z-[115] rounded-lg border border-error/40 bg-error/[0.08] px-2.5 py-1.5 text-xs text-error">
            {actionError}
          </div>
        )}
      </TreeSurface>

      {contextMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            data-vault-context-menu
            role="menu"
            className="animate-fade-in fixed z-[220] min-w-[192px] rounded-lg border border-border/70 bg-bg-secondary/95 p-1.5 shadow-lg shadow-black/25 backdrop-blur-md"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
            }}
          >
            {renderContextMenuItems(contextMenu.target)}
          </div>,
          document.body,
        )}

      <PromptDialog
        open={promptDialog !== null}
        title={promptDialog?.title ?? ""}
        description={promptDialog?.description}
        initialValue={promptDialog?.initialValue ?? ""}
        confirmLabel={promptDialog?.confirmLabel ?? "Save"}
        onCancel={() => setPromptDialog(null)}
        onConfirm={handlePromptConfirm}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Archive this entry?"
        description={
          pendingDelete
            ? `This will move ${
                pendingDelete.kind === "folder" ? "folder" : "note"
              } "${pendingDelete.path}" into .archive.`
            : ""
        }
        confirmLabel="Archive"
        cancelLabel="Cancel"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
