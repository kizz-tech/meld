"use client";

import { memo, type MouseEvent as ReactMouseEvent } from "react";
import HoverMarqueeText from "./HoverMarqueeText";

export interface VaultFileHandlers {
  selectNote: (path: string) => void;
  contextMenu: (event: ReactMouseEvent<HTMLElement>, path: string) => void;
  dragStart: (event: React.DragEvent<HTMLElement>, path: string) => void;
  dragEnd: () => void;
  fileDragOver: (event: React.DragEvent<HTMLElement>, filePath: string) => void;
  fileDrop: (event: React.DragEvent<HTMLElement>, filePath: string) => void;
  draftChange: (value: string) => void;
  submitRename: (path: string) => void;
  cancelRename: () => void;
}

export interface VaultFileRowProps {
  path: string;
  name: string;
  depth: number;
  isActive: boolean;
  isEditing: boolean;
  isPinned: boolean;
  draftName: string;
  savingRename: boolean;
  handlers: { readonly current: VaultFileHandlers };
}

const kbRowBaseClass =
  "group flex w-full min-w-0 items-center rounded-lg px-2.5 py-2 text-left text-[13px] transition-all duration-[120ms]";
const kbRowIdleClass =
  "text-text-secondary hover:bg-bg-tertiary/50 hover:text-text";
const kbRowActiveClass =
  "bg-accent/[0.06] text-accent";

const PinIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="h-3.5 w-3.5 shrink-0 text-accent/80"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 3h6" />
    <path d="M10 3v4l-3 3v2h10v-2l-3-3V3" />
    <path d="M12 12v9" />
  </svg>
);

const VaultFileRow = memo(
  function VaultFileRow({
    path,
    name,
    depth,
    isActive,
    isEditing,
    isPinned,
    draftName,
    savingRename,
    handlers,
  }: VaultFileRowProps) {
    return (
      <div className="relative">
        {isEditing ? (
          <div
            className="rounded-lg px-2.5 py-1.5"
            style={{ paddingLeft: `${8 + depth * 12}px` }}
          >
            <input
              autoFocus
              value={draftName}
              onChange={(event) => handlers.current.draftChange(event.target.value)}
              onBlur={() => handlers.current.submitRename(path)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handlers.current.submitRename(path);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  handlers.current.cancelRename();
                }
              }}
              disabled={savingRename}
              className="w-full rounded-lg border border-border-focus bg-bg px-2.5 py-2 text-[13px] text-text outline-none focus-visible:border-border-focus focus-visible:shadow-[0_0_0_1px_var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-70"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => handlers.current.selectNote(path)}
            onContextMenu={(event) => handlers.current.contextMenu(event, path)}
            draggable
            onDragStart={(event) => handlers.current.dragStart(event, path)}
            onDragEnd={() => handlers.current.dragEnd()}
            onDragOver={(event) => handlers.current.fileDragOver(event, path)}
            onDrop={(event) => handlers.current.fileDrop(event, path)}
            className={`${kbRowBaseClass} ${isActive ? kbRowActiveClass : kbRowIdleClass}`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            title={path}
          >
            <span className="min-w-0 flex-1">
              <HoverMarqueeText text={name} />
            </span>
            {isPinned && <PinIcon />}
          </button>
        )}
      </div>
    );
  },
  (prev, next) => {
    if (prev.isEditing !== next.isEditing) return false;
    if (prev.isEditing) {
      return (
        prev.draftName === next.draftName &&
        prev.savingRename === next.savingRename
      );
    }
    return (
      prev.path === next.path &&
      prev.name === next.name &&
      prev.depth === next.depth &&
      prev.isActive === next.isActive &&
      prev.isPinned === next.isPinned
    );
  },
);

export default VaultFileRow;
