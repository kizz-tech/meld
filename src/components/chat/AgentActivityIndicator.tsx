"use client";

import { useMemo } from "react";
import { useAppStore, type AgentActivity } from "@/lib/store";

interface Props {
  activity: AgentActivity;
}

const toolLabels: Record<string, string> = {
  kb_search: "Searching notes",
  kb_read: "Reading note",
  kb_create: "Creating note",
  kb_update: "Updating note",
  kb_list: "Listing notes",
  web_search: "Searching the web",
};

function trimForLabel(value: string, maxLength = 52): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function parseToolDetail(args: string): string | null {
  const raw = args.trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;

    if (typeof record.query === "string" && record.query.trim()) {
      return `query "${trimForLabel(record.query.trim(), 40)}"`;
    }

    if (typeof record.path === "string" && record.path.trim()) {
      return `path ${trimForLabel(record.path.trim())}`;
    }

    if (typeof record.folder === "string" && record.folder.trim()) {
      return `folder ${trimForLabel(record.folder.trim())}`;
    }

    if (typeof record.file === "string" && record.file.trim()) {
      return `file ${trimForLabel(record.file.trim())}`;
    }

    if (typeof record.note_path === "string" && record.note_path.trim()) {
      return `path ${trimForLabel(record.note_path.trim())}`;
    }

    if (typeof record.url === "string" && record.url.trim()) {
      return trimForLabel(record.url.trim());
    }

    const firstReadableValue = Object.entries(record).find(([, value]) => {
      if (typeof value === "string") return value.trim().length > 0;
      if (typeof value === "number") return true;
      return false;
    });

    if (!firstReadableValue) {
      return null;
    }

    return `${firstReadableValue[0]} ${trimForLabel(String(firstReadableValue[1]))}`;
  } catch {
    return trimForLabel(raw);
  }
}

export default function AgentActivityIndicator({ activity }: Props) {
  const toolCallLog = useAppStore((state) => state.toolCallLog);
  const timelineSteps = useAppStore((state) => state.timelineSteps);

  const activityTool =
    activity.type === "tool" || activity.type === "verifying"
      ? activity.tool
      : undefined;

  const latestThinkingSummary = useAppStore(
    (state) => state.latestThinkingSummary,
  );

  const detail = useMemo(() => {
    if (!activityTool || toolCallLog.length === 0) {
      return null;
    }

    const lastCall = [...toolCallLog]
      .reverse()
      .find((entry) => entry.tool === activityTool);

    return lastCall ? parseToolDetail(lastCall.args) : null;
  }, [activityTool, toolCallLog]);

  const recentActivity = useMemo(() => {
    const rows = timelineSteps
      .map((step) => {
        const path = step.file_changes?.[0]?.path;
        const query = step.args_preview?.query;
        if (typeof query === "string" && query.trim()) {
          return `Searching: "${trimForLabel(query.trim(), 38)}"`;
        }
        if (step.tool === "kb_create" && path) {
          return `Created: ${trimForLabel(path, 44)}`;
        }
        if (step.tool === "kb_update" && path) {
          return `Updated: ${trimForLabel(path, 44)}`;
        }
        if (step.tool === "kb_read" && path) {
          return `Opened: ${trimForLabel(path, 44)}`;
        }
        if (step.tool === "web_search") {
          return "Checking web sources";
        }
        return null;
      })
      .filter((row): row is string => Boolean(row));

    return rows.slice(-2);
  }, [timelineSteps]);

  let label: string;
  let icon: "pulse" | "tool" | "verify";

  switch (activity.type) {
    case "planning":
      label = "Planning next action...";
      icon = "pulse";
      break;
    case "thinking":
      label = activity.thinkingSummary?.trim()
        ? trimForLabel(activity.thinkingSummary.trim(), 80)
        : latestThinkingSummary?.trim()
          ? trimForLabel(latestThinkingSummary.trim(), 80)
          : "Thinking...";
      icon = "pulse";
      break;
    case "tool": {
      const baseLabel = activity.tool
        ? toolLabels[activity.tool] || `Running ${activity.tool}`
        : "Using tool...";
      label = detail ? `${baseLabel} · ${detail}` : baseLabel;
      icon = "tool";
      break;
    }
    case "verifying": {
      const baseLabel = "Checking results...";
      label = detail ? `${baseLabel} · ${detail}` : baseLabel;
      icon = "verify";
      break;
    }
    case "responding":
      return null;
    default:
      return null;
  }

  return (
    <div className="flex items-start gap-3 animate-fade-in">
      <div
        className="rounded-xl border border-border/60 bg-bg-secondary/80 px-3.5 py-2 text-[13px] text-text-muted shadow-md shadow-black/10 backdrop-blur-sm"
        title={label}
      >
        <div className="flex items-center gap-2.5">
        {icon === "pulse" && (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-text-secondary opacity-40" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-text-secondary" />
          </span>
        )}
        {icon === "tool" && (
          <svg
            className="w-3.5 h-3.5 text-text-muted animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83" />
          </svg>
        )}
        {icon === "verify" && (
          <svg
            className="w-3.5 h-3.5 text-success/80"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        )}
        <span key={label} className="truncate max-w-[520px] animate-fade-in">
          {label}
        </span>
        </div>
        {recentActivity.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
            {recentActivity.map((item, index) => (
              <p key={`${item}-${index}`} className="text-xs text-text-muted/85">
                {item}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
