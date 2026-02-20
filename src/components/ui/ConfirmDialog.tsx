"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onCancel, open]);

  if (!open) {
    return null;
  }

  if (typeof document === "undefined") {
    return null;
  }

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        aria-label="Close confirmation dialog"
        className="absolute inset-0 bg-scrim-50 animate-overlay-fade"
        onClick={onCancel}
      />

      <div className="relative w-full max-w-sm rounded-2xl border border-overlay-6 bg-bg-secondary/98 p-6 shadow-xl shadow-black/30 backdrop-blur-lg space-y-4 animate-dialog-in">
        <h3 className="text-lg font-semibold">{title}</h3>
        {description && (
          <p className="text-sm text-text-secondary whitespace-pre-line">{description}</p>
        )}

        <div className="flex justify-end gap-2.5 pt-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-xl border border-overlay-6 bg-bg-tertiary/60 text-text-secondary hover:text-text hover:bg-bg-tertiary transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm rounded-xl transition-colors ${
              destructive
                ? "bg-error/20 text-error hover:bg-error/30"
                : "bg-accent text-bg hover:opacity-90"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
