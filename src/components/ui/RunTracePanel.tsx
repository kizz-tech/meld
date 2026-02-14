"use client";

import { useMemo, useState } from "react";
import type { RunEventPayload, RunTokenUsagePayload } from "@/lib/tauri";

interface RunTracePanelProps {
  runId: string;
  events: RunEventPayload[] | null;
  tokenUsage?: RunTokenUsagePayload | null;
  loading: boolean;
  className?: string;
  eventsContainerClassName?: string;
}

interface NormalizedTokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

const tokenCountFormatter = new Intl.NumberFormat();

function formatRunEventTime(ts: string): string {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function summarizeRunEvent(event: RunEventPayload): string {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;

  if (event.event_type === "agent:run_state") {
    const state =
      payload && typeof payload.state === "string"
        ? payload.state
        : "unknown";
    const reason =
      payload && typeof payload.reason === "string" ? payload.reason : "";
    return reason ? `${state} (${reason})` : state;
  }

  if (event.event_type === "agent:verification") {
    const action =
      payload && typeof payload.action === "string"
        ? payload.action
        : "verify";
    const ok =
      payload && typeof payload.ok === "boolean" ? String(payload.ok) : "?";
    return `${action} · ok=${ok}`;
  }

  if (event.event_type === "agent:tool_start") {
    const tool =
      payload && typeof payload.tool === "string" ? payload.tool : "tool";
    return `start ${tool}`;
  }

  if (event.event_type === "agent:tool_result") {
    const tool =
      payload && typeof payload.tool === "string" ? payload.tool : "tool";
    return `result ${tool}`;
  }

  if (event.event_type === "agent:provider_retry") {
    const provider =
      payload && typeof payload.provider === "string"
        ? payload.provider
        : "provider";
    const model =
      payload && typeof payload.model === "string"
        ? payload.model
        : "model";
    const attempt =
      payload && typeof payload.attempt === "number" ? payload.attempt : "?";
    const maxAttempts =
      payload && typeof payload.max_attempts === "number"
        ? payload.max_attempts
        : "?";
    const retryInMs =
      payload && typeof payload.retry_in_ms === "number"
        ? payload.retry_in_ms
        : "?";
    return `retry ${provider}:${model} (${attempt}/${maxAttempts}) in ${retryInMs}ms`;
  }

  if (event.event_type === "agent:provider_fallback") {
    const from =
      payload && typeof payload.from_model_id === "string"
        ? payload.from_model_id
        : "unknown";
    const to =
      payload && typeof payload.to_model_id === "string"
        ? payload.to_model_id
        : "unknown";
    return `fallback ${from} -> ${to}`;
  }

  if (event.event_type === "agent:context_compaction") {
    const before =
      payload && typeof payload.before_tokens === "number"
        ? payload.before_tokens
        : "?";
    const after =
      payload && typeof payload.after_tokens === "number"
        ? payload.after_tokens
        : "?";
    return `tokens ${before} -> ${after}`;
  }

  return "";
}

function stateTone(state: string): string {
  if (state === "completed") return "border-success/45 bg-success/10 text-success";
  if (state === "timeout") return "border-warning/45 bg-warning/10 text-warning";
  if (state === "failed" || state === "cancelled") {
    return "border-error/45 bg-error/10 text-error";
  }
  if (state === "verifying") {
    return "border-border-hover/70 bg-bg-secondary/70 text-text-secondary";
  }
  return "border-border/65 bg-bg-secondary/60 text-text-muted";
}

function stringifyPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
}

function isFailureRunEvent(event: RunEventPayload): boolean {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;

  if (event.event_type === "agent:run_state") {
    const state =
      payload && typeof payload.state === "string"
        ? payload.state
        : "";
    return state === "failed" || state === "timeout" || state === "cancelled";
  }

  if (event.event_type === "agent:verification") {
    const ok = payload && typeof payload.ok === "boolean" ? payload.ok : true;
    const proof =
      payload && payload.proof && typeof payload.proof === "object"
        ? (payload.proof as Record<string, unknown>)
        : null;
    const readbackOk =
      proof && typeof proof.readback_ok === "boolean"
        ? proof.readback_ok
        : true;
    return !ok || !readbackOk;
  }

  if (event.event_type === "agent:tool_result") {
    const result =
      payload && payload.result && typeof payload.result === "object"
        ? (payload.result as Record<string, unknown>)
        : null;
    const ok = result && typeof result.ok === "boolean" ? result.ok : true;
    return !ok || Boolean(result?.error);
  }

  return false;
}

function parseTokenValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }
  return null;
}

function readFirstTokenValue(
  payload: RunTokenUsagePayload,
  keys: string[],
): number | null {
  for (const key of keys) {
    const parsed = parseTokenValue(payload[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeTokenUsage(
  payload: RunTokenUsagePayload | null | undefined,
): NormalizedTokenUsage | null {
  if (!payload || typeof payload !== "object") return null;

  const input = readFirstTokenValue(payload, [
    "input_tokens",
    "input",
    "prompt_tokens",
  ]);
  const output = readFirstTokenValue(payload, [
    "output_tokens",
    "output",
    "completion_tokens",
  ]);
  const totalFromPayload = readFirstTokenValue(payload, ["total_tokens", "total"]);
  const total =
    totalFromPayload ?? (input !== null && output !== null ? input + output : null);

  if (input === null && output === null && total === null) {
    return null;
  }

  return {
    ...(input !== null ? { input } : {}),
    ...(output !== null ? { output } : {}),
    ...(total !== null ? { total } : {}),
  };
}

function extractTokenUsageFromPayload(
  payload: unknown,
): NormalizedTokenUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const typedPayload = payload as RunTokenUsagePayload;

  const direct = normalizeTokenUsage(typedPayload);
  if (direct) return direct;

  const nestedCandidates = [
    typedPayload.token_usage,
    typedPayload.usage,
    typedPayload.model_usage,
  ];
  for (const candidate of nestedCandidates) {
    if (candidate && typeof candidate === "object") {
      const parsed = normalizeTokenUsage(candidate as RunTokenUsagePayload);
      if (parsed) return parsed;
    }
  }

  const result =
    typedPayload.result && typeof typedPayload.result === "object"
      ? (typedPayload.result as RunTokenUsagePayload)
      : null;
  if (result) {
    const parsed = normalizeTokenUsage(result);
    if (parsed) return parsed;
    const nestedResultCandidates = [result.token_usage, result.usage];
    for (const candidate of nestedResultCandidates) {
      if (candidate && typeof candidate === "object") {
        const nestedParsed = normalizeTokenUsage(
          candidate as RunTokenUsagePayload,
        );
        if (nestedParsed) return nestedParsed;
      }
    }
  }

  return null;
}

function extractTokenUsageFromEvents(
  events: RunEventPayload[] | null,
): NormalizedTokenUsage | null {
  if (!events || events.length === 0) return null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const parsed = extractTokenUsageFromPayload(events[i].payload);
    if (parsed) return parsed;
  }
  return null;
}

function formatTokenCount(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return tokenCountFormatter.format(value);
}

export default function RunTracePanel({
  runId,
  events,
  tokenUsage,
  loading,
  className,
  eventsContainerClassName,
}: RunTracePanelProps) {
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [onlyFailures, setOnlyFailures] = useState(false);

  const availableChannels = useMemo(() => {
    if (!events || events.length === 0) return [];
    return Array.from(new Set(events.map((event) => event.channel))).sort();
  }, [events]);

  const availableEventTypes = useMemo(() => {
    if (!events || events.length === 0) return [];
    return Array.from(new Set(events.map((event) => event.event_type))).sort();
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (!events) return [];
    const q = query.trim().toLowerCase();
    return events.filter((event) => {
      if (channelFilter !== "all" && event.channel !== channelFilter) {
        return false;
      }
      if (typeFilter !== "all" && event.event_type !== typeFilter) {
        return false;
      }
      if (onlyFailures && !isFailureRunEvent(event)) {
        return false;
      }
      if (!q) return true;

      const summary = summarizeRunEvent(event).toLowerCase();
      const payloadText = stringifyPayload(event.payload).toLowerCase();
      return (
        event.event_type.toLowerCase().includes(q) ||
        event.channel.toLowerCase().includes(q) ||
        summary.includes(q) ||
        payloadText.includes(q)
      );
    });
  }, [channelFilter, events, onlyFailures, query, typeFilter]);

  const lifecycleStates = useMemo(() => {
    if (!events || events.length === 0) return [];

    const states: Array<{ state: string; reason?: string; ts: string }> = [];
    for (const event of events) {
      if (event.event_type !== "agent:run_state") continue;
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      const state =
        payload && typeof payload.state === "string"
          ? payload.state
          : null;
      if (!state) continue;

      const reason =
        payload && typeof payload.reason === "string"
          ? payload.reason
          : undefined;

      const prev = states[states.length - 1];
      if (prev && prev.state === state && prev.reason === reason) {
        continue;
      }

      states.push({ state, reason, ts: event.ts });
    }

    return states;
  }, [events]);

  const resolvedTokenUsage = useMemo(() => {
    const fromSummary = normalizeTokenUsage(tokenUsage ?? null);
    if (fromSummary) return fromSummary;
    return extractTokenUsageFromEvents(events);
  }, [events, tokenUsage]);

  const rootClassName = `flex min-h-0 flex-1 flex-col space-y-2 ${
    className ?? ""
  }`.trim();
  const eventsClassName = `min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 ${
    eventsContainerClassName ?? ""
  }`.trim();

  return (
    <div className={rootClassName}>
      <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted/80">
        Run Trace · {runId}
      </p>

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted/60 border-t-transparent" />
        </div>
      ) : !events || events.length === 0 ? (
        <p className="text-[11px] text-text-muted">No run events captured.</p>
      ) : (
        <>
          {lifecycleStates.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted/70">
                Lifecycle
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {lifecycleStates.map((item, idx) => (
                  <div
                    key={`${item.state}-${item.ts}-${idx}`}
                    className="flex items-center gap-1.5"
                  >
                    <span
                      className={`pill-badge ${stateTone(item.state)}`}
                      title={
                        item.reason
                          ? `${item.state} (${item.reason})`
                          : item.state
                      }
                    >
                      {item.state}
                    </span>
                    {idx < lifecycleStates.length - 1 && (
                      <span className="text-[10px] text-text-muted/50">-&gt;</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {resolvedTokenUsage && (
            <div className="space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted/70">
                Token usage
              </p>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded border border-border/55 bg-bg-secondary/55 px-1.5 py-0.5 text-[10px] text-text-muted">
                  input {formatTokenCount(resolvedTokenUsage.input)}
                </span>
                <span className="rounded border border-border/55 bg-bg-secondary/55 px-1.5 py-0.5 text-[10px] text-text-muted">
                  output {formatTokenCount(resolvedTokenUsage.output)}
                </span>
                <span className="rounded border border-border/55 bg-bg-secondary/55 px-1.5 py-0.5 text-[10px] text-text-muted">
                  total {formatTokenCount(resolvedTokenUsage.total)}
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-1.5 md:grid-cols-4">
            <select
              value={channelFilter}
              onChange={(event) => setChannelFilter(event.target.value)}
              className="rounded-lg border border-border/60 bg-bg-secondary/70 px-2 py-1 text-[11px] text-text-muted focus-visible:border-border-hover focus:outline-none"
            >
              <option value="all">All channels</option>
              {availableChannels.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </select>

            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              className="rounded-lg border border-border/60 bg-bg-secondary/70 px-2 py-1 text-[11px] text-text-muted focus-visible:border-border-hover focus:outline-none"
            >
              <option value="all">All event types</option>
              {availableEventTypes.map((eventType) => (
                <option key={eventType} value={eventType}>
                  {eventType}
                </option>
              ))}
            </select>

            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search payload..."
              className="rounded-lg border border-border/60 bg-bg-secondary/70 px-2 py-1 text-[11px] text-text-muted placeholder:text-text-muted/60 focus-visible:border-border-hover focus:outline-none"
            />

            <label className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-bg-secondary/70 px-2 py-1 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={onlyFailures}
                onChange={(event) => setOnlyFailures(event.target.checked)}
              />
              Only failures
            </label>
          </div>

          <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted/70">
            Showing {filteredEvents.length} / {events.length}
          </p>

          <div className={eventsClassName}>
            {filteredEvents.map((event) => (
              <details
                key={`${runId}-${event.id}`}
                className="rounded-lg border border-border/40 bg-bg-secondary/40 px-2 py-1.5"
              >
                <summary className="cursor-pointer list-none">
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
                    <span>#{event.iteration}</span>
                    <span className="text-text-muted/70">{event.channel}</span>
                    <span>{event.event_type}</span>
                    <span className="ml-auto text-text-muted/60">
                      {formatRunEventTime(event.ts)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-text-muted/80">
                    {summarizeRunEvent(event)}
                  </p>
                </summary>
                <pre className="mt-2 overflow-x-auto rounded bg-bg/70 p-2 text-[10px] text-text-muted">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
