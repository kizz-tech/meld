"use client";

import { useMemo, useState } from "react";

interface FrontmatterBlockProps {
  data: Record<string, unknown>;
}

type EntryKind = "tags" | "status" | "date" | "value";

interface FrontmatterEntry {
  key: string;
  kind: EntryKind;
  value: string;
  tags?: string[];
}

const DATE_KEYS = new Set([
  "date",
  "created",
  "updated",
  "modified",
  "due",
  "published",
  "publish",
]);

const STATUS_KEYS = new Set(["status", "state", "phase"]);

function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, "");
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? normalizeTag(item) : ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => normalizeTag(item))
      .filter(Boolean);
  }

  return [];
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const items = value
      .map((item) => stringifyValue(item))
      .filter((item) => item !== "—");
    return items.length > 0 ? items.join(", ") : "—";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "—";
    }
  }

  return "—";
}

function formatDateValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "—";

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return trimmed;

  return new Date(parsed).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function statusTone(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["done", "completed", "closed", "success"].includes(normalized)) {
    return "border-success/45 bg-success/10 text-success";
  }
  if (["in-progress", "in progress", "active", "doing"].includes(normalized)) {
    return "border-warning/45 bg-warning/10 text-warning";
  }
  if (["blocked", "error", "failed"].includes(normalized)) {
    return "border-error/45 bg-error/10 text-error";
  }
  return "border-accent/40 bg-accent/[0.08] text-accent";
}

function toEntries(data: Record<string, unknown>): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];

  for (const [key, value] of Object.entries(data)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey) continue;

    if (normalizedKey === "tags") {
      const tags = parseTags(value);
      entries.push({
        key,
        kind: "tags",
        value: tags.length > 0 ? tags.map((tag) => `#${tag}`).join(", ") : "No tags",
        tags,
      });
      continue;
    }

    if (STATUS_KEYS.has(normalizedKey)) {
      entries.push({
        key,
        kind: "status",
        value: stringifyValue(value),
      });
      continue;
    }

    if (DATE_KEYS.has(normalizedKey)) {
      entries.push({
        key,
        kind: "date",
        value: formatDateValue(stringifyValue(value)),
      });
      continue;
    }

    entries.push({
      key,
      kind: "value",
      value: stringifyValue(value),
    });
  }

  return entries;
}

export default function FrontmatterBlock({ data }: FrontmatterBlockProps) {
  const [collapsed, setCollapsed] = useState(false);
  const entries = useMemo(() => toEntries(data), [data]);

  if (entries.length === 0) return null;

  return (
    <section className="surface-card rounded-xl p-3">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-bg-secondary/35 px-2.5 py-2 text-left"
      >
        <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted/70">
          Frontmatter
        </span>
        <span className="pill-badge text-text-muted">
          {collapsed ? "Show" : "Hide"}
        </span>
      </button>

      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr] mt-2.5"
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.key} className="flex flex-wrap items-center gap-2">
                <span className="pill-badge">{entry.key}</span>

                {entry.kind === "tags" ? (
                  entry.tags && entry.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {entry.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-accent/30 bg-accent/[0.08] px-2 py-0.5 text-[11px] font-mono text-accent"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[12px] text-text-secondary">{entry.value}</span>
                  )
                ) : entry.kind === "status" ? (
                  <span className={`pill-badge ${statusTone(entry.value)}`}>
                    {entry.value}
                  </span>
                ) : (
                  <span className="text-[12px] text-text-secondary break-words">
                    {entry.value}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
