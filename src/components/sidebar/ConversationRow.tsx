"use client";

import { memo, type MouseEvent as ReactMouseEvent } from "react";

export interface ConversationRowHandlers {
  selectConversation: (conversationId: string) => void;
  beginRenameConversation: (conversationId: string) => void;
  contextMenu: (event: ReactMouseEvent<HTMLElement>, conversationId: string) => void;
  conversationDragStart: (event: React.DragEvent<HTMLElement>, conversationId: string) => void;
  dragEnd: () => void;
  conversationDragOver: (event: React.DragEvent<HTMLElement>, conversationId: string, parentFolderId: string | null) => void;
  conversationDrop: (event: React.DragEvent<HTMLElement>, conversationId: string, parentFolderId: string | null) => void;
  draftChange: (value: string) => void;
  submitRenameConversation: (conversationId: string) => void;
  cancelRename: () => void;
}

export interface ConversationRowProps {
  conversationId: string;
  title: string;
  depth: number;
  isActive: boolean;
  isEditing: boolean;
  isPinned: boolean;
  parentFolderId: string | null;
  draftTitle: string;
  savingRename: boolean;
  handlers: { readonly current: ConversationRowHandlers };
}

const rowBaseClass =
  "group relative flex w-full min-w-0 items-center rounded-lg px-2.5 py-2 text-left text-[13px] transition-all duration-[120ms]";
const rowIdleClass =
  "text-text-secondary hover:bg-bg-tertiary/50 hover:text-text";
const rowActiveClass =
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

const ConversationRow = memo(
  function ConversationRow({
    conversationId,
    title,
    depth,
    isActive,
    isEditing,
    isPinned,
    parentFolderId,
    draftTitle,
    savingRename,
    handlers,
  }: ConversationRowProps) {
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
              onBlur={() => handlers.current.submitRenameConversation(conversationId)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handlers.current.submitRenameConversation(conversationId);
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
            onClick={() => handlers.current.selectConversation(conversationId)}
            onDoubleClick={() => handlers.current.beginRenameConversation(conversationId)}
            onContextMenu={(event) => handlers.current.contextMenu(event, conversationId)}
            draggable
            onDragStart={(event) => handlers.current.conversationDragStart(event, conversationId)}
            onDragEnd={() => handlers.current.dragEnd()}
            onDragOver={(event) => handlers.current.conversationDragOver(event, conversationId, parentFolderId)}
            onDrop={(event) => handlers.current.conversationDrop(event, conversationId, parentFolderId)}
            title={title}
            className={`${rowBaseClass} ${isActive ? rowActiveClass : rowIdleClass}`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
          >
            <span className="min-w-0 flex-1 truncate">{title}</span>
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
        prev.draftTitle === next.draftTitle &&
        prev.savingRename === next.savingRename
      );
    }
    return (
      prev.conversationId === next.conversationId &&
      prev.title === next.title &&
      prev.depth === next.depth &&
      prev.isActive === next.isActive &&
      prev.isPinned === next.isPinned &&
      prev.parentFolderId === next.parentFolderId
    );
  },
);

export default ConversationRow;
