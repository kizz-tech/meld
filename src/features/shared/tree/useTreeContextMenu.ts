"use client";

import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  useContextMenuPosition,
  type ContextMenuPositionOptions,
} from "@/components/tree/useContextMenuPosition";

export interface TreeContextMenuState<TTarget> {
  target: TTarget;
  x: number;
  y: number;
}

interface UseTreeContextMenuOptions {
  menuDataAttribute: string;
}

export function useTreeContextMenu<TTarget>({
  menuDataAttribute,
}: UseTreeContextMenuOptions) {
  const { resolvePosition } = useContextMenuPosition();
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState<TTarget> | null>(
    null,
  );

  useEffect(() => {
    const selector = `[${menuDataAttribute}]`;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(selector)) return;
      setContextMenu(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuDataAttribute]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const openContextMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      target: TTarget,
      positionOptions: ContextMenuPositionOptions,
    ) => {
      event.preventDefault();
      event.stopPropagation();

      const position = resolvePosition(event, positionOptions);
      setContextMenu({
        target,
        x: position.x,
        y: position.y,
      });
    },
    [resolvePosition],
  );

  return {
    contextMenu,
    setContextMenu,
    closeContextMenu,
    openContextMenu,
  };
}
