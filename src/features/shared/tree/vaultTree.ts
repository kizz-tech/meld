import type { VaultEntry } from "@/lib/tauri";

export type TreeNode =
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

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

export function fileOrFolderName(path: string): string {
  const normalized = normalizeRelativePath(path);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function parentPath(path: string): string {
  const normalized = normalizeRelativePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

export function buildTree(
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
    if (parts.length === 0) continue;

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

export function ancestorsOf(path: string): string[] {
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
