"use client";

import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

interface TreeSurfaceProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  onRootContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onRootDragLeave?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onRootDrop?: (event: ReactDragEvent<HTMLDivElement>) => void;
}

function joinClasses(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export default function TreeSurface({
  children,
  className,
  contentClassName,
  onRootContextMenu,
  onRootDragOver,
  onRootDragLeave,
  onRootDrop,
}: TreeSurfaceProps) {
  return (
    <div
      className={joinClasses(
        "relative h-full min-h-0 overflow-x-hidden overflow-y-auto",
        className,
      )}
      onContextMenu={onRootContextMenu}
      onDragOver={onRootDragOver}
      onDragLeave={onRootDragLeave}
      onDrop={onRootDrop}
    >
      <div className={joinClasses("relative min-h-full pb-2", contentClassName)}>
        {children}
      </div>
    </div>
  );
}

