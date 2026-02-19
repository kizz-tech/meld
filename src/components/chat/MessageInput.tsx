"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { SendHorizonal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/lib/store";
import { selectMessageInputState } from "@/state/selectors";
import { cancelActiveRun, sendMessage } from "@/lib/tauri";
import { collectSourcesFromToolResults } from "@/lib/events";

const MAX_TEXTAREA_HEIGHT = 240;

interface MessageInputProps {
  onSendMessage?: (message: string) => Promise<void> | void;
  quickPrompt?: { id: number; text: string } | null;
  onQuickPromptHandled?: (id: number) => void;
}

export default function MessageInput({
  onSendMessage,
  quickPrompt = null,
  onQuickPromptHandled,
}: MessageInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { isStreaming, streamSuppressed, isIndexing, activeConversationId } = useAppStore(
    useShallow(selectMessageInputState),
  );

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  const submitMessage = useCallback(async (rawText?: string) => {
    const text = (rawText ?? input).trim();
    if (!text || isStreaming || streamSuppressed) return;

    setInput("");

    const store = useAppStore.getState();
    store.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    });

    store.setStreaming(true);
    store.setStreamSuppressed(false);
    store.clearStreamingContent();
    store.setLatestThinkingSummary(null);
    store.clearThinkingLog();
    store.clearToolCallLog();
    store.clearToolResultLog();
    store.clearTimeline();

    try {
      if (onSendMessage) {
        await onSendMessage(text);
      } else {
        await sendMessage(text, activeConversationId);
      }
    } catch (error) {
      store.addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Error: ${String(error)}`,
        timestamp: Date.now(),
      });
      store.setStreaming(false);
      store.setAgentActivity(null);
      store.setLatestThinkingSummary(null);
      store.clearThinkingLog();
      store.setStreamSuppressed(false);
    }
  }, [input, isStreaming, streamSuppressed, activeConversationId, onSendMessage]);

  useEffect(() => {
    if (!quickPrompt) return;
    textareaRef.current?.focus();
    onQuickPromptHandled?.(quickPrompt.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- quickPrompt triggers a one-time submission, not a cascading render
    void submitMessage(quickPrompt.text);
  }, [onQuickPromptHandled, quickPrompt, submitMessage]);

  const handleStop = useCallback(async () => {
    const store = useAppStore.getState();
    if (!store.isStreaming) return;

    store.setStreamSuppressed(true);

    const partialContent = store.streamingContent.trim();
    const runIdFromTimeline = store.timelineSteps.find((step) => step.run_id)?.run_id;
    const runIdFromCalls = store.toolCallLog.find((entry) => entry.run_id)?.run_id;
    const runId = runIdFromTimeline ?? runIdFromCalls;
    const thinkingSummary =
      store.thinkingLog[store.thinkingLog.length - 1]?.summary ??
      store.latestThinkingSummary ??
      undefined;

    const capturedSources = collectSourcesFromToolResults(store.toolResultsLog);

    if (partialContent.length > 0) {
      store.addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: partialContent,
        timestamp: Date.now(),
        runId,
        thinkingSummary,
        thinkingEntries:
          store.thinkingLog.length > 0 ? [...store.thinkingLog] : undefined,
        timelineSteps:
          store.timelineSteps.length > 0 ? [...store.timelineSteps] : undefined,
        sources: capturedSources.length > 0 ? capturedSources : undefined,
      });
    }

    store.clearStreamingContent();
    store.setStreaming(false);
    store.setAgentActivity(null);
    store.setLatestThinkingSummary(null);
    store.clearThinkingLog();
    store.clearToolCallLog();
    store.clearToolResultLog();
    store.clearTimeline();

    const normalizedConversationId =
      activeConversationId !== null && activeConversationId !== undefined
        ? String(activeConversationId).trim()
        : "";
    if (normalizedConversationId) {
      try {
        await cancelActiveRun(normalizedConversationId);
      } catch (error) {
        console.error("Failed to cancel active run:", error);
      }
    }

    window.setTimeout(() => {
      const latest = useAppStore.getState();
      if (!latest.isStreaming && latest.streamSuppressed) {
        latest.setStreamSuppressed(false);
      }
    }, 2500);
  }, [activeConversationId]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  };

  return (
    <div className="border-t border-border/20 bg-bg/60 px-6 py-5">
      <div className="mx-auto flex max-w-4xl items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isIndexing
              ? "Indexing in progress..."
              : streamSuppressed
                ? "Stopping current generation..."
                : "Ask about your notes..."
          }
          rows={1}
          style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
          className="flex-1 resize-none overflow-y-auto rounded-2xl border border-white/[0.04] bg-white/[0.04] px-4 py-3 text-sm leading-relaxed text-text placeholder:text-text-muted/70 outline-none transition-[background,box-shadow] duration-[120ms] focus-visible:bg-white/[0.06] focus-visible:shadow-[0_0_0_1px_var(--color-border-focus)]"
          disabled={isIndexing || isStreaming || streamSuppressed}
        />

        {isStreaming ? (
          <button
            type="button"
            onClick={() => {
              void handleStop();
            }}
            className="flex h-[48px] w-[48px] items-center justify-center rounded-2xl bg-error/12 text-error transition-all duration-[120ms] hover:bg-error/20"
            title="Stop generation"
          >
            <span className="h-3.5 w-3.5 rounded-[2px] bg-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              void submitMessage();
            }}
            disabled={!input.trim() || isIndexing || streamSuppressed}
            className="flex h-[48px] w-[48px] items-center justify-center rounded-2xl bg-accent/15 text-accent transition-all duration-[120ms] hover:bg-accent/22 disabled:cursor-not-allowed disabled:opacity-40"
            title="Send message"
          >
            <SendHorizonal className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}
