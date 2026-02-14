"use client";

import { useCallback, useState } from "react";

export function useTreeDndState<TDragEntity, TDropTarget>() {
  const [draggingEntity, setDraggingEntity] = useState<TDragEntity | null>(null);
  const [dropTarget, setDropTarget] = useState<TDropTarget | null>(null);

  const clearDragState = useCallback(() => {
    setDraggingEntity(null);
    setDropTarget(null);
  }, []);

  return {
    draggingEntity,
    setDraggingEntity,
    dropTarget,
    setDropTarget,
    clearDragState,
  };
}

