"use client";

import type {
  Message,
  TimelineStep,
  ToolCallEvent,
  Conversation,
} from "@/lib/store";
import type {
  ConversationMessagePayload,
  ConversationPayload,
  VaultEntry,
  VaultFileEntry,
} from "@/lib/tauri";

export const normalizeTimestamp = (value?: string): number => {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const sqliteParsed = Date.parse(value.replace(" ", "T") + "Z");
  return Number.isNaN(sqliteParsed) ? Date.now() : sqliteParsed;
};

export const normalizeConversation = (
  conversation: ConversationPayload,
): Conversation => {
  const nowIso = new Date().toISOString();
  const createdAt = conversation.created_at || nowIso;
  const updatedAt = conversation.updated_at || createdAt;
  const title = conversation.title?.trim() || "Untitled chat";

  return {
    id: conversation.id,
    title,
    createdAt,
    updatedAt,
    messageCount: conversation.message_count ?? 0,
    archived: conversation.archived ?? false,
    pinned: conversation.pinned ?? false,
    sortOrder: conversation.sort_order ?? null,
    folderId: conversation.folder_id ?? null,
  };
};

const parseStringArray = (value: unknown): string[] | undefined => {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (!item || typeof item !== "object") return "";
        const source = item as Record<string, unknown>;
        const path = typeof source.path === "string" ? source.path : "";
        const url = typeof source.url === "string" ? source.url : "";
        return (path || url).trim();
      })
      .filter(Boolean);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return undefined;
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    } catch {
      return undefined;
    }
  }

  return undefined;
};

const parseToolCalls = (value: unknown): ToolCallEvent[] | undefined => {
  if (!value) return undefined;
  const asArray = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        })()
      : null;

  if (!Array.isArray(asArray)) return undefined;

  const parsed: ToolCallEvent[] = [];
  for (const item of asArray) {
    if (!item || typeof item !== "object") continue;
    const toolCall = item as Record<string, unknown>;
    const tool = typeof toolCall.tool === "string" ? toolCall.tool : "";
    if (!tool) continue;

    const argsRaw = toolCall.args ?? "";
    const args =
      typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw ?? {});
    const id =
      typeof toolCall.id === "string" && toolCall.id.trim().length > 0
        ? toolCall.id
        : undefined;
    const run_id =
      typeof toolCall.run_id === "string" && toolCall.run_id.trim().length > 0
        ? toolCall.run_id
        : undefined;
    const iteration =
      typeof toolCall.iteration === "number" ? toolCall.iteration : undefined;

    parsed.push({ run_id, id, iteration, tool, args });
  }

  return parsed.length > 0 ? parsed : undefined;
};

const parseTimeline = (value: unknown): TimelineStep[] | undefined => {
  if (!value) return undefined;
  const asArray = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        })()
      : null;

  if (!Array.isArray(asArray)) return undefined;

  const parsed: TimelineStep[] = [];
  for (const item of asArray) {
    if (!item || typeof item !== "object") continue;
    const step = item as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id : "";
    const ts = typeof step.ts === "string" ? step.ts : "";
    const phase = typeof step.phase === "string" ? step.phase : "";
    const iteration = typeof step.iteration === "number" ? step.iteration : 0;
    if (!id || !ts || !phase) continue;

    let fileChanges: TimelineStep["file_changes"] | undefined;
    if (Array.isArray(step.file_changes)) {
      const parsedChanges: NonNullable<TimelineStep["file_changes"]> = [];
      for (const change of step.file_changes) {
        if (!change || typeof change !== "object") continue;
        const fileChange = change as Record<string, unknown>;
        const path = typeof fileChange.path === "string" ? fileChange.path : "";
        const action =
          fileChange.action === "create" || fileChange.action === "edit"
            ? fileChange.action
            : null;
        if (!path || !action) continue;
        parsedChanges.push({
          path,
          action,
          bytes:
            typeof fileChange.bytes === "number"
              ? fileChange.bytes
              : undefined,
          hash_after:
            typeof fileChange.hash_after === "string"
              ? fileChange.hash_after
              : undefined,
        });
      }
      fileChanges = parsedChanges;
    }

    parsed.push({
      run_id: typeof step.run_id === "string" ? step.run_id : undefined,
      id,
      ts,
      phase,
      iteration,
      tool: typeof step.tool === "string" ? step.tool : undefined,
      args_preview:
        step.args_preview && typeof step.args_preview === "object"
          ? (step.args_preview as TimelineStep["args_preview"])
          : undefined,
      result_preview:
        typeof step.result_preview === "string" ? step.result_preview : undefined,
      file_changes: fileChanges,
    });
  }

  return parsed.length > 0 ? parsed : undefined;
};

export const normalizeMessage = (
  message: ConversationMessagePayload,
): Message => {
  const role =
    message.role === "assistant" || message.role === "tool"
      ? message.role
      : "user";
  const parsedToolCalls = parseToolCalls(message.tool_calls);
  const parsedTimeline = parseTimeline(message.timeline);
  const runId =
    (typeof message.run_id === "string" && message.run_id.trim().length > 0
      ? message.run_id
      : undefined) ??
    parsedTimeline?.find((step) => step.run_id)?.run_id ??
    parsedToolCalls?.find((call) => call.run_id)?.run_id;
  const thinkingSummary =
    typeof message.thinking_summary === "string" &&
    message.thinking_summary.trim().length > 0
      ? message.thinking_summary.trim()
      : undefined;

  return {
    id: String(message.id),
    role,
    content: message.content,
    timestamp: normalizeTimestamp(message.created_at || message.timestamp),
    runId,
    thinkingSummary,
    sources: parseStringArray(message.sources),
    toolCalls: parsedToolCalls,
    timelineSteps: parsedTimeline,
  };
};

export const sameConversation = (
  left: Conversation["id"] | null,
  right: Conversation["id"] | null,
): boolean => {
  if (left === null || right === null) return left === right;
  return String(left) === String(right);
};

const normalizePathSlashes = (path: string): string =>
  path.replace(/\\/g, "/");

const stripFragment = (path: string): string =>
  path.split("#")[0] ?? path;

const removeMdSuffix = (value: string): string =>
  value.toLowerCase().endsWith(".md") ? value.slice(0, -3) : value;

const normalizeSlugPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

const normalizePathForLooseMatch = (path: string): string => {
  const normalized = normalizePathSlashes(stripFragment(path))
    .replace(/^\/+/, "")
    .trim();
  if (!normalized) return "";
  const withoutExt = removeMdSuffix(normalized);
  return withoutExt
    .split("/")
    .map((part) => normalizeSlugPart(part))
    .filter(Boolean)
    .join("/");
};

const toPathWithMd = (path: string): string => {
  const cleaned = normalizePathSlashes(stripFragment(path)).replace(/^\/+/, "").trim();
  if (!cleaned) return "";
  return cleaned.toLowerCase().endsWith(".md") ? cleaned : `${cleaned}.md`;
};

export const findExistingVaultNote = (
  requestedPath: string,
  files: VaultFileEntry[],
): string | null => {
  const requestedWithExt = toPathWithMd(requestedPath);
  if (!requestedWithExt) return null;

  const requestedLower = requestedWithExt.toLowerCase();
  const requestedBase = requestedLower.split("/").pop() ?? requestedLower;
  const requestedLoose = normalizePathForLooseMatch(requestedWithExt);

  const exact = files.find(
    (entry) =>
      normalizePathSlashes(entry.relative_path).toLowerCase() === requestedLower,
  );
  if (exact) return exact.relative_path;

  const suffix = files.find((entry) => {
    const relativeLower = normalizePathSlashes(entry.relative_path).toLowerCase();
    return relativeLower.endsWith(`/${requestedLower}`);
  });
  if (suffix) return suffix.relative_path;

  const baseMatch = files.find((entry) => {
    const relativeLower = normalizePathSlashes(entry.relative_path).toLowerCase();
    return (relativeLower.split("/").pop() ?? relativeLower) === requestedBase;
  });
  if (baseMatch) return baseMatch.relative_path;

  const loosePathMatch = files.find((entry) => {
    const entryLoose = normalizePathForLooseMatch(entry.relative_path);
    return entryLoose === requestedLoose;
  });
  if (loosePathMatch) return loosePathMatch.relative_path;

  const requestedLooseBase = requestedLoose.split("/").pop() ?? requestedLoose;
  const looseBaseMatch = files.find((entry) => {
    const entryLoose = normalizePathForLooseMatch(entry.relative_path);
    const entryLooseBase = entryLoose.split("/").pop() ?? entryLoose;
    return entryLooseBase === requestedLooseBase;
  });
  if (looseBaseMatch) return looseBaseMatch.relative_path;

  return null;
};

export const normalizeRelativeNotePath = (
  notePath: string,
  vaultPath: string | null,
): string => {
  const trimmed = normalizePathSlashes(notePath).trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return "";

  const withoutFragment = trimmed.split("#")[0] ?? trimmed;
  const normalizedVault = vaultPath
    ? normalizePathSlashes(vaultPath).replace(/\/+$/, "")
    : "";
  const lowerSource = withoutFragment.toLowerCase();
  const lowerVault = normalizedVault.toLowerCase();
  const isWindowsAbsolutePath = /^[a-z]:\//i.test(withoutFragment);

  if (normalizedVault && lowerSource.startsWith(`${lowerVault}/`)) {
    return withoutFragment.slice(normalizedVault.length + 1);
  }
  if (isWindowsAbsolutePath) {
    return "";
  }

  return withoutFragment.replace(/^\/+/, "");
};

export function buildVaultFilesSignature(files: VaultFileEntry[]): string {
  return [...files]
    .map(
      (entry) =>
        `${normalizePathSlashes(entry.relative_path)}|${normalizePathSlashes(entry.path)}|${
          typeof entry.updated_at === "number" ? entry.updated_at : 0
        }`,
    )
    .sort()
    .join("\n");
}

export function buildVaultEntriesSignature(entries: VaultEntry[]): string {
  return [...entries]
    .map(
      (entry) =>
        `${entry.kind}|${normalizePathSlashes(entry.relative_path)}|${normalizePathSlashes(entry.path)}|${
          typeof entry.updated_at === "number" ? entry.updated_at : 0
        }`,
    )
    .sort()
    .join("\n");
}
