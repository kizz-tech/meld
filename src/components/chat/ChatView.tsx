"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/lib/store";
import { getRunEvents, type RunEventPayload } from "@/lib/tauri";
import { selectChatViewState } from "@/state/selectors";
import { setupEventListeners } from "@/lib/events";
import RunTraceModal from "@/components/ui/RunTraceModal";
import MessageBubble from "./MessageBubble";
import MessageInput from "./MessageInput";

const QUICK_PROMPTS = [
  "What am I working on?",
  "Summarize my latest notes",
  "Find connections I'm missing",
  "Draft a plan for today from my vault",
];

interface ChatViewProps {
  onSendMessage?: (message: string) => Promise<void> | void;
  onRegenerateLastResponse?: (assistantMessageId?: string) => Promise<void> | void;
  onEditMessage?: (messageId: string, content: string) => Promise<void> | void;
  onDeleteMessage?: (messageId: string) => Promise<void> | void;
  onOpenNote?: (path: string) => void;
}

function ChatView({
  onSendMessage,
  onRegenerateLastResponse,
  onEditMessage,
  onDeleteMessage,
  onOpenNote,
}: ChatViewProps) {
  const { messages, streamingContent, isStreaming, agentActivity, timelineSteps, thinkingLog } =
    useAppStore(useShallow(selectChatViewState));
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoStickRef = useRef(true);
  const initialized = useRef(false);
  const [runTraceOpen, setRunTraceOpen] = useState(false);
  const [runTraceId, setRunTraceId] = useState<string | null>(null);
  const [runTraceEvents, setRunTraceEvents] = useState<RunEventPayload[] | null>(null);
  const [runTraceLoading, setRunTraceLoading] = useState(false);
  const [quickPrompt, setQuickPrompt] = useState<{ id: number; text: string } | null>(
    null,
  );

  const lastAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant") {
        return message.id;
      }
    }
    return null;
  }, [messages]);

  const userMessagesWithFollowingAssistant = useMemo(() => {
    const ids = new Set<string>();
    for (let index = 0; index < messages.length; index += 1) {
      const current = messages[index];
      if (current.role !== "user") continue;
      const next = messages[index + 1];
      if (next?.role === "assistant") {
        ids.add(current.id);
      }
    }
    return ids;
  }, [messages]);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void setupEventListeners();
    }
  }, []);

  useEffect(() => {
    if (!autoStickRef.current) {
      return;
    }
    bottomRef.current?.scrollIntoView({
      behavior: isStreaming ? "auto" : "smooth",
      block: "end",
    });
  }, [agentActivity, isStreaming, messages, streamingContent]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    autoStickRef.current = distanceToBottom < 120;
  };

  const handleOpenRunTrace = async (runId: string) => {
    setRunTraceOpen(true);
    setRunTraceId(runId);
    setRunTraceLoading(true);
    setRunTraceEvents(null);

    try {
      const events = await getRunEvents(runId);
      setRunTraceEvents(events);
    } catch (error) {
      console.error("Failed to load run trace:", error);
      setRunTraceEvents([]);
    } finally {
      setRunTraceLoading(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-6 pt-5 pb-32"
      >
        {messages.length === 0 && !isStreaming && (
          <div className="flex h-full flex-col items-center justify-center text-text-muted">
            <div className="relative mx-auto w-full max-w-[560px] rounded-[32px] px-8 py-12 text-center">
              <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_center,var(--color-accent)_0,transparent_50%)] opacity-5 blur-3xl" />
              <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-[20px] bg-accent/10 border border-accent/20 shadow-[0_0_32px_rgba(232,202,114,0.15)]">
                <span className="h-3 w-3 rounded-full bg-accent shadow-[0_0_16px_rgba(232,202,114,0.8)]" />
              </div>
              <p className="text-[36px] font-display italic tracking-tight text-text drop-shadow-[0_2px_16px_rgba(255,255,255,0.08)]">
                Ask anything about your vault
              </p>
              <p className="mt-2 text-[15px] text-text-secondary/80">
                Your knowledge, your context, your AI.
              </p>

              <div className="mt-10 grid gap-3.5">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() =>
                      setQuickPrompt({
                        id: Date.now() + Math.floor(Math.random() * 1000),
                        text: prompt,
                      })
                    }
                    className="w-full rounded-[24px] border border-overlay-5 bg-overlay-2 px-6 py-4.5 text-left text-[14px] text-text-secondary transition-all duration-[240ms] hover:border-overlay-10 hover:bg-overlay-6 hover:text-text hover:shadow-[0_8px_24px_rgba(0,0,0,0.2)]"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            isLastAssistant={
              message.role === "assistant" && message.id === lastAssistantMessageId
            }
            deletesFollowingAssistantReply={userMessagesWithFollowingAssistant.has(
              message.id,
            )}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
            onRegenerateMessage={onRegenerateLastResponse}
            onOpenNote={onOpenNote}
            onOpenRunTrace={handleOpenRunTrace}
          />
        ))}

        {isStreaming && (
          <MessageBubble
            message={{
              id: "streaming",
              role: "assistant",
              content: streamingContent,
              timestamp: Date.now(),
              timelineSteps: timelineSteps.length > 0 ? timelineSteps : undefined,
              thinkingEntries: thinkingLog.length > 0 ? thinkingLog : undefined,
            }}
            liveActivity={agentActivity}
          />
        )}

        <div ref={bottomRef} />
      </div>

      <MessageInput
        onSendMessage={onSendMessage}
        quickPrompt={quickPrompt}
        onQuickPromptHandled={(id) => {
          setQuickPrompt((current) => (current?.id === id ? null : current));
        }}
      />

      <RunTraceModal
        open={runTraceOpen}
        runId={runTraceId}
        events={runTraceEvents}
        loading={runTraceLoading}
        onClose={() => {
          setRunTraceOpen(false);
          setRunTraceId(null);
          setRunTraceEvents(null);
          setRunTraceLoading(false);
        }}
      />
    </div>
  );
}

export default memo(ChatView);
