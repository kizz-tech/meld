"use client";

import { useEffect } from "react";
import type { RunEventPayload } from "@/lib/tauri";
import RunTracePanel from "./RunTracePanel";

interface RunTraceModalProps {
  open: boolean;
  runId: string | null;
  events: RunEventPayload[] | null;
  loading: boolean;
  onClose: () => void;
}

export default function RunTraceModal({
  open,
  runId,
  events,
  loading,
  onClose,
}: RunTraceModalProps) {
  useEffect(() => {
    if (!open) return;

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose, open]);

  if (!open || !runId) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden px-4 py-4">
      <button
        aria-label="Close run trace"
        className="absolute inset-0 animate-overlay-fade bg-black/55"
        onClick={onClose}
      />

      <div className="animate-dialog-in relative flex h-[88vh] w-[92vw] max-w-[1480px] min-h-0 flex-col overflow-hidden rounded-2xl bg-bg-secondary/98 p-4 shadow-xl shadow-black/35 backdrop-blur-lg">
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3 border-b border-border/50 pb-2">
          <div className="min-w-0">
            <p className="text-xs font-mono uppercase tracking-wider text-text-muted/70">
              Run trace
            </p>
            <p className="truncate text-sm text-text-secondary" title={runId}>
              Run {runId}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border/30 text-text-muted transition-colors hover:border-border-hover hover:text-text"
            title="Close run trace"
            aria-label="Close run trace"
          >
            <span aria-hidden>×</span>
          </button>
        </div>

        <RunTracePanel
          runId={runId}
          events={events}
          loading={loading}
          className="overflow-hidden"
          eventsContainerClassName="overscroll-contain"
        />
      </div>
    </div>
  );
}
