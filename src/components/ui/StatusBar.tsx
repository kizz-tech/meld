"use client";

import { RefreshCw } from "lucide-react";

interface StatusBarProps {
  vaultPath: string | null;
  fileCount: number;
  modelId: string;
  isIndexing: boolean;
  indexProgress: { current: number; total: number; file: string } | null;
  onReindex?: () => Promise<void> | void;
}

export default function StatusBar({
  vaultPath,
  fileCount,
  modelId,
  isIndexing,
  indexProgress,
  onReindex,
}: StatusBarProps) {
  const indexLabel = isIndexing
    ? `Indexing... ${indexProgress ? `${indexProgress.current}/${indexProgress.total}` : ""
      }`.trim()
    : `Indexed · ${fileCount} notes`;

  return (
    <footer className="flex h-9 items-center gap-3 border-t border-white/5 bg-black/20 px-4 pb-0.5 font-mono text-[10px] text-text-muted/60">
      <span
        className="min-w-0 flex-1 truncate"
        title={vaultPath ?? "No vault selected"}
      >
        {vaultPath ?? "No vault selected"}
      </span>

      <span className="pill-badge shrink-0 text-text-muted">
        <span className={`pill-dot ${isIndexing ? "bg-warning/80" : "bg-success/75"}`} />
        {indexLabel}
        <button
          type="button"
          onClick={() => {
            if (!isIndexing) {
              void onReindex?.();
            }
          }}
          disabled={isIndexing}
          className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-text-muted transition-all duration-[120ms] hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          title={isIndexing ? "Indexing in progress" : "Reindex"}
          aria-label={isIndexing ? "Indexing in progress" : "Reindex"}
        >
          <RefreshCw className={`h-3 w-3 ${isIndexing ? "animate-spin" : ""}`} strokeWidth={1.8} />
        </button>
      </span>
      <span className="pill-badge shrink-0 text-text-muted">
        <span className="pill-dot" />
        {modelId}
      </span>
    </footer>
  );
}
