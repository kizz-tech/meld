"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export default function PromptDialog({
  open,
  title,
  description,
  initialValue = "",
  placeholder,
  confirmLabel = "Save",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing prop to local state on dialog open
    setValue(initialValue);
  }, [initialValue, open]);

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
    <div className="fixed inset-0 z-[160] flex items-center justify-center px-4">
      <button
        aria-label="Close prompt dialog"
        className="absolute inset-0 animate-overlay-fade bg-black/60"
        onClick={onCancel}
      />

      <div className="relative w-full max-w-md space-y-4 rounded-2xl border border-border/60 bg-bg-secondary/95 p-5 shadow-2xl shadow-black/50 backdrop-blur-lg animate-dialog-in">
        <h3 className="text-lg font-semibold">{title}</h3>
        {description && (
          <p className="whitespace-pre-line text-sm text-text-secondary">{description}</p>
        )}

        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConfirm(value);
            }
          }}
          placeholder={placeholder}
          className="w-full rounded-lg border border-border/60 bg-bg/70 px-3 py-2 text-sm text-text outline-none transition-colors focus-visible:border-border-focus focus-visible:shadow-[0_0_0_1px_var(--color-border-focus)]"
        />

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="rounded-md bg-bg-tertiary px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-border hover:text-text"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => onConfirm(value)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-bg transition-opacity hover:opacity-90"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
