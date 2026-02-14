import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore, type ToolResultEvent } from "./store";

let unlisteners: UnlistenFn[] = [];
let activeSetup: Promise<void> | null = null;

function parseJsonPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function pushUniqueSource(target: string[], source: string) {
  const normalized = source.trim();
  if (!normalized) return;
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function extractSourcesFromToolResult(tool: string, rawResult: unknown): string[] {
  const parsed =
    rawResult && typeof rawResult === "object"
      ? (rawResult as Record<string, unknown>)
      : null;
  if (!parsed) return [];

  const sources: string[] = [];

  if (tool === "kb_search") {
    const chunksCandidate =
      (parsed.result &&
      typeof parsed.result === "object" &&
      Array.isArray((parsed.result as Record<string, unknown>).chunks)
        ? ((parsed.result as Record<string, unknown>).chunks as unknown[])
        : null) ??
      (Array.isArray(parsed.chunks) ? (parsed.chunks as unknown[]) : null) ??
      (Array.isArray(rawResult) ? (rawResult as unknown[]) : null);

    if (chunksCandidate) {
      for (const item of chunksCandidate) {
        if (sources.length >= 5) break; // limit to top-5 most relevant
        if (!item || typeof item !== "object") continue;
        const filePath = (item as Record<string, unknown>).file_path;
        if (typeof filePath === "string") {
          pushUniqueSource(sources, filePath);
        }
      }
    }
  }

  if (tool === "kb_read" || tool === "kb_create" || tool === "kb_update") {
    const target = parsed.target;
    if (target && typeof target === "object") {
      const resolvedPath = (target as Record<string, unknown>).resolved_path;
      if (typeof resolvedPath === "string") {
        pushUniqueSource(sources, resolvedPath);
      }
    }

    for (const key of ["path", "created", "edited"]) {
      const value = parsed[key];
      if (typeof value === "string") {
        pushUniqueSource(sources, value);
      }
    }
  }

  if (tool === "web_search") {
    const resultsCandidate =
      (parsed.result &&
      typeof parsed.result === "object" &&
      Array.isArray((parsed.result as Record<string, unknown>).results)
        ? ((parsed.result as Record<string, unknown>).results as unknown[])
        : null) ??
      (Array.isArray(parsed.results) ? (parsed.results as unknown[]) : null);

    if (resultsCandidate) {
      for (const item of resultsCandidate) {
        if (!item || typeof item !== "object") continue;
        const candidate = item as Record<string, unknown>;
        const url = candidate.url;
        if (typeof url === "string") {
          pushUniqueSource(sources, url);
        }
      }
    }
  }

  return sources;
}

export function collectSourcesFromToolResults(entries: ToolResultEvent[]): string[] {
  const sources: string[] = [];
  for (const entry of entries) {
    const parsedResult = parseJsonPayload(entry.result);
    const extracted = extractSourcesFromToolResult(entry.tool, parsedResult);
    for (const source of extracted) {
      pushUniqueSource(sources, source);
    }
  }
  return sources;
}

interface ChatDonePayload {
  run_id?: string;
  content?: string;
  sources?: unknown;
  thinking_summary?: string;
  timestamp?: string | number;
}

function parseChatDonePayload(payload: unknown): ChatDonePayload {
  const parsed = parseJsonPayload(payload);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as ChatDonePayload;
}

function parseTimestamp(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const sqliteParsed = Date.parse(value.replace(" ", "T") + "Z");
    if (!Number.isNaN(sqliteParsed)) return sqliteParsed;
  }
  return Date.now();
}

function parseSources(value: unknown): string[] {
  if (!value) return [];
  const parsed = parseJsonPayload(value);
  if (!Array.isArray(parsed)) return [];

  const sources: string[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      pushUniqueSource(sources, item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    if (typeof source.path === "string") {
      pushUniqueSource(sources, source.path);
    } else if (typeof source.url === "string") {
      pushUniqueSource(sources, source.url);
    }
  }
  return sources;
}

export function setupEventListeners(): Promise<void> {
  // Prevent concurrent setup — if already in progress, return the same promise
  // to avoid registering duplicate listeners (causes doubled stream tokens)
  if (activeSetup) return activeSetup;
  activeSetup = doSetupEventListeners().finally(() => {
    activeSetup = null;
  });
  return activeSetup;
}

async function doSetupEventListeners() {
  // Clean up previous listeners
  for (const unlisten of unlisteners) {
    unlisten();
  }
  unlisteners = [];

  /* ── Chat streaming ──────────────────────────────────── */

  unlisteners.push(
    await listen<string>("chat:chunk", (event) => {
      const state = useAppStore.getState();
      if (state.streamSuppressed) {
        return;
      }
      state.appendStreamingContent(event.payload);
    }),
  );

  unlisteners.push(
    await listen<unknown>("chat:done", (event) => {
      const state = useAppStore.getState();
      if (state.streamSuppressed) {
        state.clearStreamingContent();
        state.setStreaming(false);
        state.setAgentActivity(null);
        state.setLatestThinkingSummary(null);
        state.clearThinkingLog();
        state.clearToolCallLog();
        state.clearToolResultLog();
        state.clearTimeline();
        state.setStreamSuppressed(false);
        return;
      }
      const payload = parseChatDonePayload(event.payload);
      const streamedContent = state.streamingContent.trim();
      const payloadContent =
        typeof payload.content === "string" ? payload.content.trim() : "";
      const finalContent = streamedContent || payloadContent;

      if (finalContent) {
        const runIdFromTimeline = state.timelineSteps.find((step) => step.run_id)?.run_id;
        const runIdFromCalls = state.toolCallLog.find((entry) => entry.run_id)?.run_id;
        const runId =
          (typeof payload.run_id === "string" && payload.run_id.trim().length > 0
            ? payload.run_id.trim()
            : undefined) ??
          runIdFromTimeline ??
          runIdFromCalls;

        const persistedSources = parseSources(payload.sources);
        const capturedSources = collectSourcesFromToolResults(state.toolResultsLog);
        const mergedSources: string[] = [];
        for (const source of persistedSources) {
          pushUniqueSource(mergedSources, source);
        }
        for (const source of capturedSources) {
          pushUniqueSource(mergedSources, source);
        }

        const thinkingSummary =
          state.thinkingLog[state.thinkingLog.length - 1]?.summary ||
          state.latestThinkingSummary ||
          undefined;

        state.addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: finalContent,
          timestamp: parseTimestamp(payload.timestamp),
          runId,
          thinkingSummary: thinkingSummary?.trim() || undefined,
          thinkingEntries:
            state.thinkingLog.length > 0 ? [...state.thinkingLog] : undefined,
          sources: mergedSources.length > 0 ? mergedSources : undefined,
          toolCalls:
            state.toolCallLog.length > 0 ? [...state.toolCallLog] : undefined,
          timelineSteps:
            state.timelineSteps.length > 0 ? [...state.timelineSteps] : undefined,
        });
      }
      state.clearStreamingContent();
      state.setStreaming(false);
      state.setAgentActivity(null);
      state.setLatestThinkingSummary(null);
      state.clearThinkingLog();
      state.clearToolCallLog();
      state.clearToolResultLog();
      state.clearTimeline();
      state.setStreamSuppressed(false);
    }),
  );

  unlisteners.push(
    await listen<string>("chat:error", (event) => {
      const state = useAppStore.getState();
      if (state.streamSuppressed) {
        state.clearStreamingContent();
        state.setStreaming(false);
        state.setAgentActivity(null);
        state.setLatestThinkingSummary(null);
        state.clearThinkingLog();
        state.clearToolCallLog();
        state.clearToolResultLog();
        state.clearTimeline();
        state.setStreamSuppressed(false);
        return;
      }
      state.addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Error: ${event.payload}`,
      });
      state.clearStreamingContent();
      state.setStreaming(false);
      state.setAgentActivity(null);
      state.setLatestThinkingSummary(null);
      state.clearThinkingLog();
      state.clearToolCallLog();
      state.clearToolResultLog();
      state.clearTimeline();
      state.setStreamSuppressed(false);
    }),
  );

  unlisteners.push(
    await listen("chat:cancelled", () => {
      const state = useAppStore.getState();
      state.clearStreamingContent();
      state.setStreaming(false);
      state.setAgentActivity(null);
      state.setLatestThinkingSummary(null);
      state.clearThinkingLog();
      state.clearToolCallLog();
      state.clearToolResultLog();
      state.clearTimeline();
      state.setStreamSuppressed(false);
    }),
  );

  /* ── Agent lifecycle ─────────────────────────────────── */

  unlisteners.push(
    await listen<{ state: string; iteration?: number }>(
      "agent:run_state",
      (event) => {
        const p = event.payload;
        const s = p.state;
        console.warn("[meld:run_state]", s, p);

        if (s === "planning") {
          useAppStore
            .getState()
            .setAgentActivity({ type: "planning", iteration: p.iteration });
        } else if (s === "thinking") {
          useAppStore
            .getState()
            .setAgentActivity({ type: "thinking", iteration: p.iteration });
        } else if (s === "tool_calling") {
          useAppStore
            .getState()
            .setAgentActivity({ type: "tool", iteration: p.iteration });
        } else if (s === "verifying") {
          useAppStore
            .getState()
            .setAgentActivity({ type: "verifying", iteration: p.iteration });
        } else if (s === "responding") {
          useAppStore.getState().setAgentActivity({ type: "responding" });
        } else if (
          s === "completed" ||
          s === "failed" ||
          s === "timeout" ||
          s === "cancelled"
        ) {
          useAppStore.getState().setAgentActivity(null);
        }
      },
    ),
  );

  unlisteners.push(
    await listen<unknown>(
      "agent:thinking_summary",
      (event) => {
        console.warn("[meld:thinking] raw payload:", JSON.stringify(event.payload));
        const raw = parseJsonPayload(event.payload);
        console.warn("[meld:thinking] parsed:", JSON.stringify(raw));
        const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const summary = (
          typeof p.text === "string" ? p.text
          : typeof p.summary === "string" ? p.summary
          : ""
        ).trim();
        if (!summary) {
          return;
        }
        const iteration = typeof p.iteration === "number" ? p.iteration : undefined;
        const ts = typeof p.ts === "string" ? p.ts : new Date().toISOString();
        useAppStore.getState().setAgentActivity({
          type: "thinking",
          thinkingSummary: summary,
          iteration,
        });
        useAppStore.getState().setLatestThinkingSummary(summary);
        useAppStore.getState().addThinkingLog({ summary, iteration, ts });
      },
    ),
  );

  /* ── Agent tools ─────────────────────────────────────── */

  unlisteners.push(
    await listen<{
      run_id?: string;
      id?: string;
      iteration?: number;
      tool: string;
      args: unknown;
    }>("agent:tool_call", (event) => {
      const p = event.payload;
      useAppStore.getState().addToolCallLog({
        run_id: p.run_id,
        id: p.id,
        iteration: p.iteration,
        tool: p.tool,
        args: typeof p.args === "string" ? p.args : JSON.stringify(p.args ?? {}),
      });
      useAppStore
        .getState()
        .setAgentActivity({ type: "tool", tool: p.tool, iteration: p.iteration });
    }),
  );

  unlisteners.push(
    await listen<{ tool?: string }>("agent:tool_start", (event) => {
      const tool = event.payload.tool;
      if (tool) {
        useAppStore.getState().setAgentActivity({ type: "tool", tool });
      }
    }),
  );

  unlisteners.push(
    await listen<{
      run_id?: string;
      id?: string;
      iteration?: number;
      tool: string;
      result: unknown;
    }>("agent:tool_result", (event) => {
      const p = event.payload;
      useAppStore.getState().addToolResultLog({
        run_id: p.run_id,
        id: p.id,
        iteration: p.iteration,
        tool: p.tool,
        result:
          typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? {}),
      });
    }),
  );

  unlisteners.push(
    await listen<{ tool?: string }>("agent:verification", (event) => {
      const tool = event.payload.tool;
      useAppStore.getState().setAgentActivity({ type: "verifying", tool });
    }),
  );

  /* ── Agent timeline ──────────────────────────────────── */

  unlisteners.push(
    await listen<{
      run_id?: string;
      id: string;
      ts: string;
      phase: string;
      iteration: number;
      tool?: string;
      args_preview?: Record<string, unknown>;
      result_preview?: string;
      file_changes?: unknown;
    }>("agent:timeline_step", (event) => {
      const p = event.payload;
      useAppStore.getState().addTimelineStep({
        run_id: p.run_id,
        id: p.id,
        ts: p.ts,
        phase: p.phase,
        iteration: p.iteration,
        tool: p.tool,
        args_preview: p.args_preview,
        result_preview: p.result_preview,
        file_changes: p.file_changes as
          | { path: string; action: "create" | "edit"; bytes?: number; hash_after?: string }[]
          | undefined,
      });
    }),
  );

  unlisteners.push(
    await listen("agent:timeline_done", () => {
      // Marker — no action needed, timeline is already built incrementally
    }),
  );

  /* ── Indexing ────────────────────────────────────────── */

  unlisteners.push(
    await listen<{ current: number; total: number; file: string }>(
      "index:progress",
      (event) => {
        useAppStore.getState().setIndexProgress(event.payload);
      },
    ),
  );

  unlisteners.push(
    await listen("index:done", () => {
      useAppStore.getState().setIndexing(false);
      useAppStore.getState().setIndexProgress(null);
    }),
  );
}

export function cleanupEventListeners() {
  for (const unlisten of unlisteners) {
    unlisten();
  }
  unlisteners = [];
}
