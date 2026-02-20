"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { SendHorizonal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/lib/store";
import { selectMessageInputState } from "@/state/selectors";
import { cancelActiveRun, sendMessage } from "@/lib/tauri";
import { collectSourcesFromToolResults } from "@/lib/events";
import { buildChatErrorToast } from "@/lib/chatErrors";

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
    if (!text || isStreaming) return;

    setInput("");

    const store = useAppStore.getState();
    const optimisticUserMessageId = crypto.randomUUID();
    store.addMessage({
      id: optimisticUserMessageId,
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
      const toast = buildChatErrorToast(error);
      store.showToast(toast.message, toast.options);
      useAppStore.setState((state) => ({
        messages: state.messages.filter((message) => message.id !== optimisticUserMessageId),
      }));
      store.setStreaming(false);
      store.setAgentActivity(null);
      store.setLatestThinkingSummary(null);
      store.clearThinkingLog();
      store.clearToolCallLog();
      store.clearToolResultLog();
      store.clearTimeline();
      store.clearStreamingContent();
      store.setStreamSuppressed(false);
    }
  }, [input, isStreaming, activeConversationId, onSendMessage]);

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
    <div className="absolute bottom-6 left-0 right-0 px-6 flex justify-center pointer-events-none z-20">
      <div className="pointer-events-auto flex w-full max-w-3xl items-center gap-2 rounded-[28px] bg-bg border border-overlay-10 shadow-[0_8px_32px_rgba(0,0,0,0.6)] ring-1 ring-overlay-5 p-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isIndexing
              ? "Indexing in progress..."
              : streamSuppressed && isStreaming
                ? "Stopping current generation..."
                : "Ask about your notes..."
          }
          rows={1}
          style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
          className="flex-1 ml-2 my-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-[15px] leading-relaxed text-text placeholder:text-text-muted/70 outline-none"
          disabled={isIndexing || isStreaming}
        />

        {isStreaming ? (
          <button
            type="button"
            onClick={() => {
              void handleStop();
            }}
            className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full bg-overlay-10 text-text-secondary shadow-sm transition-all duration-[120ms] hover:scale-105 hover:bg-overlay-15 hover:text-text active:scale-95"
            title="Stop generation"
          >
            <span className="h-3 w-3 rounded-[2px] bg-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              void submitMessage();
            }}
            disabled={!input.trim() || isIndexing}
            className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full bg-accent text-bg shadow-[0_0_16px_var(--shadow-accent-glow)] transition-all duration-[120ms] hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100 disabled:shadow-none"
            title="Send message"
          >
            <SendHorizonal className="h-4 w-4 relative -ml-[1px]" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}
