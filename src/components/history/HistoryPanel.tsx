"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { getHistory, revertCommit, type HistoryEntry } from "@/lib/tauri";

export default function HistoryPanel() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

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
    }
  }

  return (
    <div className="p-6 space-y-6 h-full overflow-y-auto max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">History</h2>
        <button
          onClick={() => useAppStore.getState().toggleHistory()}
          className="text-text-muted hover:text-text transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>

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
