"use client";

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
    ? `Indexing... ${
        indexProgress ? `${indexProgress.current}/${indexProgress.total}` : ""
      }`.trim()
    : `Indexed · ${fileCount} notes`;

  return (
    <footer className="flex h-8 items-center gap-2.5 bg-bg-secondary/25 px-3 font-mono text-[10px] text-text-muted/60">
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
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            className={`h-3 w-3 ${isIndexing ? "animate-spin" : ""}`}
          >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v4h4" />
          </svg>
        </button>
      </span>
      <span className="pill-badge shrink-0 text-text-muted">
        <span className="pill-dot" />
        {modelId}
      </span>
    </footer>
  );
}
