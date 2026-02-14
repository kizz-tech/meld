"use client";

import { useCallback, type MouseEvent as ReactMouseEvent } from "react";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface ContextMenuPositionOptions {
  mode: "pointer" | "row";
  menuWidth: number;
  menuHeight: number;
  viewportPadding?: number;
  rowOffsetX?: number;
  rowOffsetY?: number;
  pointerOffsetY?: number;
}

export function useContextMenuPosition() {
  const resolvePosition = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      options: ContextMenuPositionOptions,
    ): ContextMenuPosition => {
      const viewportPadding = options.viewportPadding ?? 8;
      const rowOffsetX = options.rowOffsetX ?? 8;
      const rowOffsetY = options.rowOffsetY ?? 6;
      const pointerOffsetY = options.pointerOffsetY ?? 12;

      const targetRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      let x = event.clientX;
      let y = event.clientY;

      if (options.mode === "row") {
        x = targetRect.left + rowOffsetX;
        y = targetRect.bottom + rowOffsetY;
      }

      if (x + options.menuWidth > window.innerWidth - viewportPadding) {
        x = Math.max(
          viewportPadding,
          window.innerWidth - options.menuWidth - viewportPadding,
        );
      }
      if (x < viewportPadding) {
        x = viewportPadding;
      }

      if (y + options.menuHeight > window.innerHeight - viewportPadding) {
        if (options.mode === "row") {
          y = Math.max(
            viewportPadding,
            targetRect.top - options.menuHeight - rowOffsetY,
          );
        } else {
          y = Math.max(
            viewportPadding,
            y - options.menuHeight - pointerOffsetY,
          );
        }
      }
      if (y < viewportPadding) {
        y = viewportPadding;
      }

      return { x, y };
    },
    [],
  );

  return { resolvePosition };
}

