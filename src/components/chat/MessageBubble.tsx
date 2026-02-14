"use client";

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { openFileExternal } from "@/lib/tauri";
import {
  decodeWikilinkHref,
  resolveWikilinkPath,
  transformWikilinks,
} from "@/lib/wikilinks";
import type { AgentActivity, Message, TimelineStep } from "@/lib/store";

interface Props {
  message: Message;
  isLastAssistant?: boolean;
  deletesFollowingAssistantReply?: boolean;
  liveActivity?: AgentActivity | null;
  onEditMessage?: (messageId: string, content: string) => Promise<void> | void;
  onDeleteMessage?: (messageId: string) => Promise<void> | void;
  onRegenerateMessage?: (assistantMessageId?: string) => Promise<void> | void;
  onOpenNote?: (path: string) => void;
  onOpenRunTrace?: (runId: string) => Promise<void> | void;
}

interface IconButtonProps {
  title: string;
  onClick: () => void;
  children: ReactNode;
}

function IconButton({ title, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted/80 transition-colors duration-[120ms] hover:text-text outline-none"
    >
      {children}
    </button>
  );
}

function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }

  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateText(value: string, maxLength = 80): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function extractPath(step: TimelineStep): string | null {
  const changedPath = step.file_changes?.find((change) => change.path)?.path;
  if (changedPath) return changedPath;

  const argsPath = step.args_preview?.path;
  if (typeof argsPath === "string" && argsPath.trim().length > 0) {
    return argsPath.trim();
  }

  return null;
}

function extractQuery(step: TimelineStep): string | null {
  const query = step.args_preview?.query;
  if (typeof query === "string" && query.trim().length > 0) {
    return query.trim();
  }
  return null;
}

function toActivityLabel(step: TimelineStep): string | null {
  const path = extractPath(step);
  const query = extractQuery(step);
  const firstChange = step.file_changes?.[0];
  const size = firstChange ? formatBytes(firstChange.bytes) : "";
  const sizeSuffix = size ? ` (${size})` : "";

  switch (step.tool) {
    case "kb_search":
      return query ? `Searched notes for "${truncateText(query, 56)}"` : "Searched notes";
    case "kb_read":
      return path ? `Opened ${path}` : "Opened a note";
    case "kb_list":
      return "Checked note list";
    case "kb_create":
      return path ? `Created ${path}${sizeSuffix}` : "Created a note";
    case "kb_update":
      return path ? `Updated ${path}` : "Updated a note";
    case "web_search":
      return query ? `Searched the web for "${truncateText(query, 56)}"` : "Searched the web";
    default:
      break;
  }

  if (step.file_changes && step.file_changes.length > 0) {
    if (step.file_changes.length === 1) {
      const change = step.file_changes[0];
      if (!change) return "Updated note";
      const verb = change.action === "create" ? "Created" : "Updated";
      return `${verb} ${change.path}`;
    }
    return `Updated ${step.file_changes.length} notes`;
  }

  if (step.phase === "context_compaction") {
    return "Compressed context to keep the reply focused";
  }
  if (step.phase === "agent:provider_retry") {
    return "Retried the model response";
  }
  if (step.phase === "agent:provider_fallback") {
    return "Switched to a fallback model";
  }

  if (step.result_preview) {
    const preview = step.result_preview.trim();
    if (preview && /timeout|failed|error/i.test(preview)) {
      return truncateText(preview);
    }
  }

  return null;
}

function toActivityDetail(step: TimelineStep): string | null {
  const firstChange = step.file_changes?.[0];

  switch (step.tool) {
    case "kb_search": {
      const parts: string[] = [];
      if (step.result_preview) {
        const chunkMatch = step.result_preview.match(/(\d+)\s*chunk/i);
        if (chunkMatch) parts.push(`Found ${chunkMatch[1]} chunks`);
      }
      const query = extractQuery(step);
      if (query) parts.push(`for query '${truncateText(query, 40)}'`);
      const hyde = step.args_preview?.hyde;
      const rerank = step.args_preview?.rerank;
      if (hyde !== undefined || rerank !== undefined) {
        const flags: string[] = [];
        if (hyde !== undefined) flags.push(`hyde=${hyde}`);
        if (rerank !== undefined) flags.push(`rerank=${rerank}`);
        parts.push(`(${flags.join(", ")})`);
      }
      return parts.length > 0 ? parts.join(" ") : null;
    }
    case "kb_read": {
      const path = step.args_preview?.path;
      if (typeof path === "string" && path.trim()) {
        const label = toActivityLabel(step);
        if (label && label.includes(path.trim())) return null;
        return path.trim();
      }
      return null;
    }
    case "kb_create": {
      if (firstChange) {
        const size = formatBytes(firstChange.bytes);
        return size ? `${firstChange.path} (${size})` : firstChange.path;
      }
      return null;
    }
    case "kb_update": {
      if (firstChange) return firstChange.path;
      return null;
    }
    case "web_search": {
      if (step.result_preview) {
        const countMatch = step.result_preview.match(/(\d+)\s*result/i);
        if (countMatch) return `${countMatch[1]} results`;
      }
      return null;
    }
    default:
      return null;
  }
}

function formatStepTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Merge tool_start + tool_result into one composite step per tool call,
 * drop verify steps. Non-tool steps pass through unchanged.
 */
function mergeToolPhases(steps: TimelineStep[]): TimelineStep[] {
  const merged: TimelineStep[] = [];
  let pendingStart: TimelineStep | null = null;

  for (const step of steps) {
    if (step.phase === "tool_start") {
      pendingStart = step;
      continue;
    }
    if (step.phase === "verify") {
      continue;
    }
    if (step.phase === "tool_result") {
      merged.push({
        ...step,
        args_preview: pendingStart?.args_preview ?? step.args_preview,
      });
      pendingStart = null;
      continue;
    }
    // Non-tool phases (plan, done, context_compaction, etc.)
    merged.push(step);
  }

  // Dangling tool_start without a tool_result (tool still running)
  if (pendingStart) {
    merged.push(pendingStart);
  }

  return merged;
}

function summarizeTimeline(steps: TimelineStep[]): string {
  const merged = mergeToolPhases(steps);
  const counts = {
    search: 0,
    read: 0,
    create: 0,
    update: 0,
    web: 0,
    other: 0,
  };

  for (const step of merged) {
    switch (step.tool) {
      case "kb_search":
        counts.search += 1;
        break;
      case "kb_read":
        counts.read += 1;
        break;
      case "kb_create":
        counts.create += 1;
        break;
      case "kb_update":
        counts.update += 1;
        break;
      case "web_search":
        counts.web += 1;
        break;
      default:
        if (toActivityLabel(step)) {
          counts.other += 1;
        }
        break;
    }
  }

  const parts: string[] = [];
  if (counts.search > 0) {
    parts.push(`Searched ${counts.search} ${counts.search === 1 ? "note" : "notes"}`);
  }
  if (counts.read > 0) {
    parts.push(`Opened ${counts.read} ${counts.read === 1 ? "note" : "notes"}`);
  }
  if (counts.create > 0) {
    parts.push(`Created ${counts.create} ${counts.create === 1 ? "note" : "notes"}`);
  }
  if (counts.update > 0) {
    parts.push(`Updated ${counts.update} ${counts.update === 1 ? "note" : "notes"}`);
  }
  if (counts.web > 0) {
    parts.push(`Checked web ${counts.web} ${counts.web === 1 ? "time" : "times"}`);
  }
  if (parts.length === 0 && counts.other > 0) {
    parts.push(`Completed ${counts.other} actions`);
  }

  return parts.join(" · ");
}

interface UnifiedTimelineRow {
  id: string;
  kind: "action" | "thinking";
  tool?: string;
  text: string;
  detail?: string;
  time: string;
  ts: number;
}

function buildUnifiedRows(
  steps: TimelineStep[],
  thinkingEntries?: import("@/lib/store").ThinkingEntry[],
): UnifiedTimelineRow[] {
  const rows: UnifiedTimelineRow[] = [];
  const merged = mergeToolPhases(steps);

  for (const step of merged) {
    const label = toActivityLabel(step);
    if (!label) continue;
    rows.push({
      id: step.id,
      kind: "action",
      tool: step.tool ?? step.phase,
      text: label,
      detail: toActivityDetail(step) ?? undefined,
      time: formatStepTime(step.ts),
      ts: Date.parse(step.ts) || 0,
    });
  }

  if (thinkingEntries) {
    for (let i = 0; i < thinkingEntries.length; i++) {
      const entry = thinkingEntries[i];
      if (!entry.summary.trim()) continue;
      rows.push({
        id: `thinking-${i}`,
        kind: "thinking",
        text: entry.summary,
        time: entry.ts ? formatStepTime(entry.ts) : "",
        ts: entry.ts ? Date.parse(entry.ts) || 0 : 0,
      });
    }
  }

  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function TimelineRowIcon({ row }: { row: UnifiedTimelineRow }) {
  const cls = "h-3.5 w-3.5 shrink-0";

  if (row.kind === "thinking") {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" className={`${cls} text-text-muted`}>
        <path d="M8 1a5 5 0 0 0-3.5 8.57V12a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V9.57A5 5 0 0 0 8 1Zm-1.5 13a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-3Z" />
      </svg>
    );
  }

  switch (row.tool) {
    case "kb_search":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={`${cls} text-text-muted`}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" strokeLinecap="round" />
        </svg>
      );
    case "kb_read":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={`${cls} text-text-muted`}>
          <path d="M3 2.5h7l3 3V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V2.5Z" />
          <path d="M10 2.5v3h3" />
        </svg>
      );
    case "kb_create":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={`${cls} text-success/70`}>
          <path d="M3 2.5h7l3 3V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V2.5Z" />
          <path d="M8 6v5M5.5 8.5h5" strokeLinecap="round" />
        </svg>
      );
    case "kb_update":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={`${cls} text-text-muted`}>
          <path d="M11.5 2.5 13.5 4.5 6 12H4v-2l7.5-7.5Z" strokeLinejoin="round" />
        </svg>
      );
    case "web_search":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={`${cls} text-text-muted`}>
          <circle cx="8" cy="8" r="6" />
          <path d="M2 8h12M8 2c-2 2.5-2 9 0 12M8 2c2 2.5 2 9 0 12" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={`${cls} text-text-muted/60`}>
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </svg>
      );
  }
}

function liveActivityToRow(activity: AgentActivity): UnifiedTimelineRow | null {
  const liveLabels: Record<string, string> = {
    kb_search: "Searching notes",
    kb_read: "Reading note",
    kb_create: "Creating note",
    kb_update: "Updating note",
    kb_list: "Listing notes",
    web_search: "Searching the web",
  };

  switch (activity.type) {
    case "planning":
      return { id: "live", kind: "action", text: "Planning next action...", time: "", ts: Date.now() };
    case "thinking":
      return {
        id: "live",
        kind: "thinking",
        text: activity.thinkingSummary?.trim() || "Thinking...",
        time: "",
        ts: Date.now(),
      };
    case "tool":
      return {
        id: "live",
        kind: "action",
        tool: activity.tool,
        text: activity.tool ? liveLabels[activity.tool] || `Running ${activity.tool}` : "Using tool...",
        time: "",
        ts: Date.now(),
      };
    case "verifying":
      return { id: "live", kind: "action", text: "Checking results...", time: "", ts: Date.now() };
    default:
      return null;
  }
}

function TimelineRow({ row }: { row: UnifiedTimelineRow }) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const isThinking = row.kind === "thinking";

  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors ${
        isThinking
          ? "border-l border-l-text-muted/20"
          : "border-l border-l-border-hover/50"
      }`}
    >
      <div className="mt-0.5 flex items-center">
        <TimelineRowIcon row={row} />
      </div>
      <div className="min-w-0 flex-1">
        {isThinking ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setThinkingExpanded((p) => !p);
            }}
            className="w-full text-left"
          >
            <p
              className={`text-[12px] leading-relaxed italic text-text-muted/90 ${
                thinkingExpanded ? "" : "truncate"
              }`}
            >
              {row.text}
            </p>
          </button>
        ) : (
          <p className="text-[12px] leading-relaxed text-text-secondary">
            {row.text}
          </p>
        )}
        {row.detail && !isThinking && (
          <p className="mt-0.5 text-[11px] leading-snug text-text-muted/70">
            {row.detail}
          </p>
        )}
      </div>
      {row.time && (
        <span className="mt-0.5 shrink-0 text-[10px] font-mono text-text-muted/50">
          {row.time}
        </span>
      )}
    </div>
  );
}

function TimelineDisplay({
  steps,
  thinkingEntries,
  liveActivity,
}: {
  steps: TimelineStep[];
  thinkingEntries?: import("@/lib/store").ThinkingEntry[];
  liveActivity?: AgentActivity | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(
    () => buildUnifiedRows(steps, thinkingEntries),
    [steps, thinkingEntries],
  );

  const liveRow = useMemo(
    () => (liveActivity ? liveActivityToRow(liveActivity) : null),
    [liveActivity],
  );

  const lastRow = rows[rows.length - 1] ?? liveRow;
  const isLive = Boolean(liveActivity && liveActivity.type !== "responding");

  const summaryLabel = useMemo(() => summarizeTimeline(steps), [steps]);

  if (!lastRow && !liveRow) return null;

  const previewRow = isLive && liveRow ? liveRow : lastRow;

  return (
    <section
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((prev) => !prev)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded((prev) => !prev);
        }
      }}
      className="cursor-pointer rounded-lg py-1.5"
    >
      <div className="flex w-full items-center gap-2">
        {isLive && previewRow ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-text-secondary opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-text-secondary" />
            </span>
            <span
              className={`truncate text-[12px] leading-relaxed ${
                previewRow.kind === "thinking"
                  ? "italic text-text-muted/90"
                  : "text-text-secondary"
              }`}
            >
              {previewRow.text}
            </span>
            {rows.length > 1 && (
              <span className="shrink-0 text-[10px] text-text-muted/50">
                +{rows.length - 1}
              </span>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[12px] leading-relaxed text-text-secondary">
              {summaryLabel || previewRow?.text || "Activity"}
            </span>
          </div>
        )}
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-3 w-3 shrink-0 text-text-muted/60 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </div>

      {expanded && rows.length > 0 && (
        <div className="mt-2 space-y-1">
          {rows.map((row) => (
            <TimelineRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function SourcesDisplay({
  sources,
  onOpenSource,
}: {
  sources: string[];
  onOpenSource?: (source: string) => void;
}) {
  return (
    <div className="mt-3 pt-2">
      <p className="mb-1 text-[10px] font-mono uppercase tracking-widest text-accent-dim/70">
        Sources
      </p>
      <div className="flex flex-wrap gap-1">
        {sources.map((source) => (
          <button
            key={source}
            type="button"
            onClick={() => onOpenSource?.(source)}
            className="rounded-full bg-accent/[0.08] px-2.5 py-0.5 text-[11px] text-accent/80 transition-all duration-[120ms] hover:bg-accent/[0.14] hover:text-accent"
            title={source}
          >
            {source}
          </button>
        ))}
      </div>
    </div>
  );
}

function isPersistedMessageId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function isExternalHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:)/i.test(href.trim());
}

function normalizeTimestamp(value?: number): string {
  if (!value || !Number.isFinite(value)) return "—";
  const date = new Date(value);
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function textFromReactChildren(children: ReactNode): string {
  const collect = (node: ReactNode): string => {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map((child) => collect(child)).join("");
    if (node && typeof node === "object" && "props" in node) {
      const props = node.props as { children?: ReactNode };
      return collect(props.children);
    }
    return "";
  };

  return collect(children).trim();
}

function MessageBubble({
  message,
  isLastAssistant = false,
  deletesFollowingAssistantReply = false,
  liveActivity,
  onEditMessage,
  onDeleteMessage,
  onRegenerateMessage,
  onOpenNote,
  onOpenRunTrace,
}: Props) {
  const isUser = message.role === "user";
  const isStreamingMessage = message.id === "streaming";
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(message.content);
  const [savingEdit, setSavingEdit] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showTechMenu, setShowTechMenu] = useState(false);
  const techMenuRef = useRef<HTMLDivElement | null>(null);

  const markdownContent = useMemo(
    () => transformWikilinks(message.content),
    [message.content],
  );
  const timestampLabel = useMemo(
    () => normalizeTimestamp(message.timestamp),
    [message.timestamp],
  );
  const canEdit =
    !isStreamingMessage &&
    isUser &&
    Boolean(onEditMessage) &&
    isPersistedMessageId(message.id);
  const canDelete =
    !isStreamingMessage &&
    Boolean(onDeleteMessage) &&
    isPersistedMessageId(message.id);
  const canRegenerate =
    !isStreamingMessage &&
    message.role === "assistant" &&
    isLastAssistant &&
    Boolean(onRegenerateMessage);
  const canOpenRunTrace =
    !isStreamingMessage &&
    message.role === "assistant" &&
    Boolean(message.runId && onOpenRunTrace);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      console.error("Failed to copy message:", error);
    }
  };

  const submitEdit = async () => {
    if (!onEditMessage) return;
    const nextValue = draftText.trim();
    if (!nextValue) return;

    setSavingEdit(true);
    setLocalError(null);
    try {
      await onEditMessage(message.id, nextValue);
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to edit message:", error);
      setLocalError("Failed to edit message");
    } finally {
      setSavingEdit(false);
    }
  };

  const confirmDelete = async () => {
    if (!onDeleteMessage) return;
    setDeleting(true);
    setLocalError(null);
    try {
      await onDeleteMessage(message.id);
      setPendingDelete(false);
      setShowTechMenu(false);
    } catch (error) {
      console.error("Failed to delete message:", error);
      setLocalError("Failed to delete message");
    } finally {
      setDeleting(false);
    }
  };

  const openReference = (target: string) => {
    const normalized = target.trim();
    if (!normalized) return;
    if (isExternalHref(normalized)) {
      void openFileExternal(normalized);
      return;
    }
    onOpenNote?.(normalized);
  };

  useEffect(() => {
    if (!showTechMenu) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!techMenuRef.current || !target) return;
      if (techMenuRef.current.contains(target)) return;
      setShowTechMenu(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [showTechMenu]);

  const actionBar = !isStreamingMessage ? (
    <div className="flex items-center gap-1">
      {canEdit && (
        <IconButton
          title="Edit message"
          onClick={() => {
            setDraftText(message.content);
            setLocalError(null);
            setIsEditing(true);
          }}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M13.586 3.586a2 2 0 112.828 2.828l-8.56 8.56a1 1 0 01-.447.263l-3 1a1 1 0 01-1.264-1.264l1-3a1 1 0 01.263-.447l8.56-8.56z" />
          </svg>
        </IconButton>
      )}

      {message.role === "assistant" && (
        <IconButton
          title="Copy response"
          onClick={() => {
            void handleCopy();
          }}
        >
          {copied ? (
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path
                fillRule="evenodd"
                d="M16.704 5.29a1 1 0 00-1.408-1.418L8.08 11.057 4.704 7.67a1 1 0 10-1.408 1.418l4.08 4.09a1 1 0 001.417 0l7.91-7.888z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H7a2 2 0 01-2-2V4z" />
              <path d="M3 6a1 1 0 00-1 1v9a2 2 0 002 2h7a1 1 0 100-2H4V7a1 1 0 00-1-1z" />
            </svg>
          )}
        </IconButton>
      )}

      {canRegenerate && (
        <IconButton
          title="Regenerate response"
          onClick={() => {
            void onRegenerateMessage?.(
              isPersistedMessageId(message.id) ? message.id : undefined,
            );
          }}
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.65}
            className="h-3.5 w-3.5"
          >
            <path d="M3.5 8.5a6.5 6.5 0 0111.7-2.7" strokeLinecap="round" />
            <path d="M14.8 2.6v3.7h-3.7" strokeLinecap="round" />
            <path d="M16.5 11.5a6.5 6.5 0 01-11.7 2.7" strokeLinecap="round" />
            <path d="M5.2 17.4v-3.7h3.7" strokeLinecap="round" />
          </svg>
        </IconButton>
      )}

      {(canDelete || canOpenRunTrace) && (
        <div ref={techMenuRef} className="relative">
          <IconButton
            title="Technical actions"
            onClick={() => setShowTechMenu((prev) => !prev)}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M10 4.75a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zM10 11.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zM8.75 16a1.25 1.25 0 102.5 0 1.25 1.25 0 00-2.5 0z" />
            </svg>
          </IconButton>

          {showTechMenu && (
            <div className="absolute right-0 top-[calc(100%+8px)] z-40 min-w-[170px] rounded-lg border border-border/70 bg-bg-secondary/95 p-1.5 shadow-xl shadow-black/45">
              {canOpenRunTrace && message.runId && (
                <button
                  type="button"
                  onClick={() => {
                    setShowTechMenu(false);
                    void onOpenRunTrace?.(message.runId as string);
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
                >
                  <span>Run trace</span>
                  <span>↗</span>
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={() => setPendingDelete(true)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-error transition-colors hover:bg-error/10"
                >
                  <span>Delete</span>
                  <span>⌫</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <>
      <div className="group animate-message-enter">
        {/* Timeline — separated above for assistant */}
        {!isUser &&
          ((message.timelineSteps && message.timelineSteps.length > 0) ||
            (message.thinkingEntries && message.thinkingEntries.length > 0) ||
            (isStreamingMessage && liveActivity)) && (
          <div className="mb-1.5">
            <TimelineDisplay
              steps={message.timelineSteps ?? []}
              thinkingEntries={message.thinkingEntries}
              liveActivity={isStreamingMessage ? liveActivity : undefined}
            />
          </div>
        )}

        {/* Message content */}
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
          {isEditing ? (
            <div className="max-w-[75%] space-y-2 rounded-2xl border border-white/[0.06] bg-white/[0.05] px-4 py-3">
              <textarea
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                rows={4}
                disabled={savingEdit}
                className="w-full resize-y rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-text outline-none focus-visible:border-white/[0.12]"
              />
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditing(false);
                    setDraftText(message.content);
                    setLocalError(null);
                  }}
                  className="rounded-lg px-2.5 py-1 text-xs text-text-muted transition-colors duration-[120ms] hover:text-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void submitEdit();
                  }}
                  disabled={savingEdit || !draftText.trim()}
                  className="rounded-lg bg-accent/15 px-2.5 py-1 text-xs text-accent transition-colors duration-[120ms] hover:bg-accent/22 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingEdit ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          ) : isUser ? (
            <div className="max-w-[75%] rounded-2xl border border-white/[0.06] bg-white/[0.05] px-4 py-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">
                {message.content}
              </p>
            </div>
          ) : (
            <div
              className="max-w-[85%]"
              style={{
                minHeight: isStreamingMessage ? "48px" : undefined,
                overflowAnchor: isStreamingMessage ? "none" : undefined,
              }}
            >
              <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({
                      href,
                      children,
                      className,
                      node: _node,
                      ...props
                    }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => {
                      const resolvedHref = (href ?? "").trim();
                      const wikilinkTarget = decodeWikilinkHref(resolvedHref);

                      if (wikilinkTarget && onOpenNote) {
                        const resolvedPath = resolveWikilinkPath(
                          wikilinkTarget,
                          message.sources ?? [],
                        );
                        return (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onOpenNote(resolvedPath);
                            }}
                            className="mx-0.5 inline-flex items-center rounded-full border border-accent/30 bg-accent/[0.08] px-2 py-0.5 text-[11px] font-mono text-accent transition-colors hover:border-accent/50 hover:bg-accent/[0.14]"
                            title={`Open [[${wikilinkTarget}]]`}
                          >
                            [[{children}]]
                          </button>
                        );
                      }

                      const fallbackTarget = textFromReactChildren(children);
                      const internalTarget = resolvedHref || fallbackTarget;
                      const hashLink = resolvedHref.startsWith("#");
                      const externalLink = isExternalHref(resolvedHref);

                      if (onOpenNote && internalTarget && !externalLink && !hashLink) {
                        return (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onOpenNote(internalTarget);
                            }}
                            className={`cursor-pointer text-text-secondary underline decoration-border-hover/75 underline-offset-2 transition-colors hover:text-text ${
                              className ?? ""
                            }`.trim()}
                            title={internalTarget}
                          >
                            {children}
                          </button>
                        );
                      }

                      if (!resolvedHref) {
                        return (
                          <span
                            className={`text-text-secondary underline decoration-border-hover/75 underline-offset-2 ${
                              className ?? ""
                            }`.trim()}
                          >
                            {children}
                          </span>
                        );
                      }

                      return (
                        <a
                          {...props}
                          href={resolvedHref}
                          className={`text-text-secondary underline decoration-border-hover/75 underline-offset-2 transition-colors hover:text-text ${
                            className ?? ""
                          }`.trim()}
                          target={externalLink ? "_blank" : props.target}
                          rel={externalLink ? "noreferrer" : props.rel}
                          onClick={(event) => {
                            if (!externalLink) return;
                            event.preventDefault();
                            event.stopPropagation();
                            void openFileExternal(resolvedHref);
                          }}
                        >
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {markdownContent}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>

        {/* Actions + timestamp — below message */}
        {!isStreamingMessage && (
          <div className={`mt-1 flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div className="flex items-center gap-2 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100">
              <span
                className="text-[10px] font-mono text-text-muted/50"
                title={
                  message.timestamp
                    ? new Date(message.timestamp).toLocaleString()
                    : "Timestamp unavailable"
                }
              >
                {timestampLabel}
              </span>
              {actionBar}
            </div>
          </div>
        )}

        {localError && (
          <p className={`mt-1 text-xs text-error ${isUser ? "text-right" : ""}`}>
            {localError}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title="Delete message?"
        description={
          isUser && deletesFollowingAssistantReply
            ? "This removes your prompt and the assistant reply right after it."
            : "This removes the selected message from the conversation."
        }
        confirmLabel={deleting ? "Deleting..." : "Delete"}
        cancelLabel="Cancel"
        destructive
        onCancel={() => {
          if (deleting) return;
          setPendingDelete(false);
        }}
        onConfirm={() => {
          if (deleting) return;
          void confirmDelete();
        }}
      />
    </>
  );
}

export default memo(MessageBubble);
