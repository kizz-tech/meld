"use client";

import { useEffect, useRef, useState } from "react";

export interface ComboOption {
  value: string;
  label: string;
}

interface ComboSelectProps {
  value: string;
  options: ComboOption[];
  placeholder?: string;
  onChange: (value: string) => void;
  allowCustom?: boolean;
}

export default function ComboSelect({
  value,
  options,
  placeholder = "Select or type...",
  onChange,
  allowCustom = true,
}: ComboSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayValue = () => {
    const match = options.find((o) => o.value === value);
    return match ? match.label : value;
  };

  const filtered = options.filter((o) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      o.label.toLowerCase().includes(q) ||
      o.value.toLowerCase().includes(q)
    );
  });

  const showCustom =
    allowCustom &&
    query.trim() &&
    !options.some(
      (o) =>
        o.value.toLowerCase() === query.trim().toLowerCase() ||
        o.label.toLowerCase() === query.trim().toLowerCase(),
    );

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("pointerdown", handleClick);
    return () => window.removeEventListener("pointerdown", handleClick);
  }, [open]);

  const select = (val: string) => {
    onChange(val);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`flex items-center rounded-xl border bg-bg text-sm transition-colors ${
          focused
            ? "border-border-focus shadow-[0_0_0_1px_var(--color-border-focus)]"
            : "border-transparent"
        }`}
      >
        <input
          ref={inputRef}
          type="text"
          value={open ? query : displayValue()}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
            setQuery("");
          }}
          onBlur={() => {
            setFocused(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setQuery("");
              inputRef.current?.blur();
            }
            if (e.key === "Enter" && open) {
              e.preventDefault();
              if (filtered.length === 1) {
                select(filtered[0].value);
              } else if (showCustom && query.trim()) {
                select(query.trim());
              } else if (filtered.length > 0) {
                select(filtered[0].value);
              }
            }
          }}
          className="w-full bg-transparent px-3 py-2 text-text placeholder:text-text-muted outline-none"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => {
            if (open) {
              setOpen(false);
              setQuery("");
            } else {
              setOpen(true);
              setQuery("");
              inputRef.current?.focus();
            }
          }}
          className="shrink-0 px-2 text-text-muted/60 hover:text-text-secondary transition-colors"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto rounded-xl border border-border/70 bg-bg-secondary/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md">
          {filtered.length === 0 && !showCustom && (
            <div className="px-3 py-2 text-xs text-text-muted">
              No matches
            </div>
          )}
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => select(o.value)}
              className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                o.value === value
                  ? "bg-accent/[0.08] text-accent"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text"
              }`}
            >
              <span className="flex-1 truncate">{o.label}</span>
              {o.value !== o.label && (
                <span className="ml-2 shrink-0 text-[10px] font-mono text-text-muted/50">
                  {o.value}
                </span>
              )}
            </button>
          ))}
          {showCustom && (
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => select(query.trim())}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text transition-colors"
            >
              <span className="shrink-0 text-[10px] font-mono text-accent-dim">
                custom
              </span>
              <span className="truncate">{query.trim()}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
