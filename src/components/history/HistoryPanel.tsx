"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { getHistory, revertCommit, type HistoryEntry } from "@/lib/tauri";

export default function HistoryPanel() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const timeoutId = window.setTimeout(() => {
      setError(null);
    }, 3600);
    return () => window.clearTimeout(timeoutId);
  }, [error]);

  async function loadHistory() {
    try {
      const history = await getHistory();
      setEntries(history);
    } catch (e) {
      console.error("Failed to load history:", e);
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    loadHistory();
  }, []);

  async function handleRevert(commitId: string) {
    try {
      await revertCommit(commitId);
      await loadHistory();
    } catch (e) {
      console.error("Failed to revert:", e);
      setError(`Failed to revert: ${String(e)}`);
    }
  }

  return (
    <div className="p-6 space-y-6 h-full overflow-y-auto scrollbar-visible max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">History</h2>
        <button
          onClick={() => useAppStore.getState().toggleHistory()}
          className="text-text-muted hover:text-text transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-error/40 bg-error/[0.08] px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-text-muted text-sm text-center py-8">
          No history yet. Changes will appear here after the agent modifies your
          notes.
        </p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="p-4 bg-bg-secondary/40 rounded-xl space-y-2"
            >
              <p className="text-sm">{entry.message}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  {new Date(entry.timestamp * 1000).toLocaleString()}
                </span>
                <button
                  onClick={() => handleRevert(entry.id)}
                  className="text-xs px-2 py-1 text-error hover:bg-error/10 rounded transition-colors"
                >
                  Revert
                </button>
              </div>
              {entry.files_changed.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {entry.files_changed.map((file) => (
                    <span
                      key={file}
                      className="text-xs px-1.5 py-0.5 bg-bg-tertiary rounded text-text-muted"
                    >
                      {file}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
