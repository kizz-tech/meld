"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  placeholder?: string;
  onChange: (value: string) => void;
  size?: "sm" | "md";
}

export default function Select({
  value,
  options,
  placeholder = "Select...",
  onChange,
  size = "md",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handleClick);
    return () => window.removeEventListener("pointerdown", handleClick);
  }, [open]);

  const pad = size === "sm" ? "px-2 py-1 text-[11px]" : "px-3 py-2 text-sm";
  const itemPad = size === "sm" ? "px-2 py-1 text-[11px]" : "px-3 py-2 text-sm";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex w-full items-center justify-between rounded-xl border bg-bg-secondary transition-colors ${pad} ${
          open
            ? "border-border-focus shadow-[0_0_0_1px_var(--color-border-focus)]"
            : "border-border/40"
        }`}
      >
        <span className={selected ? "text-text" : "text-text-muted"}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className={`ml-2 h-3 w-3 shrink-0 text-text-muted/60 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto rounded-xl border border-border/70 bg-bg-secondary/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`flex w-full items-center rounded-lg text-left transition-colors ${itemPad} ${
                o.value === value
                  ? "bg-accent/[0.08] text-accent"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
