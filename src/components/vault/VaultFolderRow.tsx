"use client";

import { memo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Pin } from "lucide-react";
import HoverMarqueeText from "./HoverMarqueeText";

export interface VaultFolderHandlers {
  toggleFolder: (path: string) => void;
  contextMenu: (event: ReactMouseEvent<HTMLElement>, path: string) => void;
  dragStart: (event: React.DragEvent<HTMLElement>, path: string) => void;
  dragEnd: () => void;
  folderDragOver: (event: React.DragEvent<HTMLElement>, folderPath: string) => void;
  folderDragLeave: (event: React.DragEvent<HTMLElement>, folderPath: string) => void;
  folderDrop: (event: React.DragEvent<HTMLElement>, folderPath: string) => void;
  draftChange: (value: string) => void;
  submitRename: (path: string) => void;
  cancelRename: () => void;
}

export interface VaultFolderRowProps {
  path: string;
  name: string;
  depth: number;
  isExpanded: boolean;
  isDrop: boolean;
  isEditing: boolean;
  isPinned: boolean;
  draftName: string;
  savingRename: boolean;
  children: ReactNode;
  handlers: { readonly current: VaultFolderHandlers };
}

const kbRowBaseClass =
  "group flex w-full min-w-0 items-center rounded-xl px-2.5 py-2 text-left text-[13px] transition-all duration-[120ms]";
const kbRowIdleClass =
  "text-text-secondary hover:bg-bg-tertiary/50 hover:text-text";
const kbRowDropClass =
  "bg-bg-tertiary/70 text-text";

const PinIcon = () => (
  <Pin className="h-3.5 w-3.5 shrink-0 text-accent/80" strokeWidth={1.8} aria-hidden="true" />
);

const VaultFolderRow = memo(
  function VaultFolderRow({
    path,
    name,
    depth,
    isExpanded,
    isDrop,
    isEditing,
    isPinned,
    draftName,
    savingRename,
    children,
    handlers,
  }: VaultFolderRowProps) {
    return (
      <div className="relative">
        {isEditing ? (
          <div
            className="flex items-center rounded-lg px-2.5 py-1.5"
            style={{ paddingLeft: `${8 + depth * 12}px` }}
          >
            <span className="mr-1 text-[11px] text-text-muted/65">▸</span>
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
            onClick={() => handlers.current.toggleFolder(path)}
            onContextMenu={(event) => handlers.current.contextMenu(event, path)}
            draggable
            onDragStart={(event) => handlers.current.dragStart(event, path)}
            onDragEnd={() => handlers.current.dragEnd()}
            onDragOver={(event) => handlers.current.folderDragOver(event, path)}
            onDragLeave={(event) => handlers.current.folderDragLeave(event, path)}
            onDrop={(event) => handlers.current.folderDrop(event, path)}
            className={`${kbRowBaseClass} ${isDrop ? kbRowDropClass : kbRowIdleClass}`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            title={path}
          >
            <span className="mr-1 text-[11px]">{isExpanded ? "▾" : "▸"}</span>
            <span className="min-w-0 flex-1">
              <HoverMarqueeText text={name} />
            </span>
            {isPinned && <PinIcon />}
          </button>
        )}
        {isExpanded && <div>{children}</div>}
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
      prev.isExpanded === next.isExpanded &&
      prev.isDrop === next.isDrop &&
      prev.isPinned === next.isPinned &&
      prev.children === next.children
    );
  },
);

export default VaultFolderRow;
