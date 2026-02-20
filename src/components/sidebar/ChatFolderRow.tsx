"use client";

import { memo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Pin } from "lucide-react";

export interface ChatFolderRowHandlers {
  toggleFolderExpanded: (folderId: string) => void;
  folderContextMenu: (event: ReactMouseEvent<HTMLElement>, folderId: string) => void;
  folderDragStart: (event: React.DragEvent<HTMLElement>, folderId: string) => void;
  dragEnd: () => void;
  folderDragOver: (event: React.DragEvent<HTMLElement>, folderId: string) => void;
  folderDragLeave: (folderId: string) => void;
  folderDrop: (event: React.DragEvent<HTMLElement>, folderId: string) => void;
  draftChange: (value: string) => void;
  submitRenameFolder: (folderId: string) => void;
  cancelRename: () => void;
}

export interface ChatFolderRowProps {
  folderId: string;
  name: string;
  depth: number;
  isExpanded: boolean;
  isDrop: boolean;
  isEditing: boolean;
  isPinned: boolean;
  draftTitle: string;
  savingRename: boolean;
  children: ReactNode;
  handlers: { readonly current: ChatFolderRowHandlers };
}

const rowBaseClass =
  "group relative flex w-full min-w-0 items-center rounded-xl px-2.5 py-2 text-left text-[13px] transition-all duration-[120ms]";
const rowIdleClass =
  "text-text-secondary hover:bg-bg-tertiary/50 hover:text-text";
const rowDropClass =
  "bg-bg-tertiary/70 text-text";

const PinIcon = () => (
  <Pin className="h-3.5 w-3.5 shrink-0 text-accent/80" strokeWidth={1.8} aria-hidden="true" />
);

const ChatFolderRow = memo(
  function ChatFolderRow({
    folderId,
    name,
    depth,
    isExpanded,
    isDrop,
    isEditing,
    isPinned,
    draftTitle,
    savingRename,
    children,
    handlers,
  }: ChatFolderRowProps) {
    return (
      <div className="relative">
        {isEditing ? (
          <div
            className="rounded-lg py-1"
            style={{ paddingLeft: `${8 + depth * 12}px` }}
          >
            <input
              autoFocus
              value={draftTitle}
              onChange={(event) => handlers.current.draftChange(event.target.value)}
              onBlur={() => handlers.current.submitRenameFolder(folderId)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handlers.current.submitRenameFolder(folderId);
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
            onClick={() => handlers.current.toggleFolderExpanded(folderId)}
            onContextMenu={(event) => handlers.current.folderContextMenu(event, folderId)}
            draggable
            onDragStart={(event) => handlers.current.folderDragStart(event, folderId)}
            onDragEnd={() => handlers.current.dragEnd()}
            onDragOver={(event) => handlers.current.folderDragOver(event, folderId)}
            onDragLeave={(event) => {
              event.stopPropagation();
              handlers.current.folderDragLeave(folderId);
            }}
            onDrop={(event) => handlers.current.folderDrop(event, folderId)}
            title={name}
            className={`${rowBaseClass} ${isDrop ? rowDropClass : rowIdleClass}`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
          >
            <span className="mr-1 text-[11px]">{isExpanded ? "▾" : "▸"}</span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
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
        prev.draftTitle === next.draftTitle &&
        prev.savingRename === next.savingRename
      );
    }
    return (
      prev.folderId === next.folderId &&
      prev.name === next.name &&
      prev.depth === next.depth &&
      prev.isExpanded === next.isExpanded &&
      prev.isDrop === next.isDrop &&
      prev.isPinned === next.isPinned &&
      prev.children === next.children
    );
  },
);

export default ChatFolderRow;
