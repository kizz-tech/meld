"use client";

import { useEffect } from "react";
import { useHomeController } from "@/features/layout/controllers/useHomeController";
import ChatView from "@/components/chat/ChatView";
import Sidebar from "@/components/sidebar/Sidebar";
import NotePreview from "@/components/vault/NotePreview";
import VaultQuickSwitcher from "@/components/vault/VaultQuickSwitcher";
import VaultSwitcherScreen from "@/components/vault/VaultSwitcherScreen";
import SettingsPanel from "@/components/settings/SettingsPanel";
import HistoryPanel from "@/components/history/HistoryPanel";
import FolderSettingsPanel from "@/components/folders/FolderSettingsPanel";
import StatusBar from "@/components/ui/StatusBar";
import MeldMark from "@/components/ui/MeldMark";
import { useAppStore } from "@/lib/store";
import WindowControls from "@/components/ui/WindowControls";
import { History, Settings } from "lucide-react";

export default function Home() {
  const { state, actions } = useHomeController();
  const toastMessage = useAppStore((s) => s.toastMessage);
  const toastAction = useAppStore((s) => s.toastAction);
  const toastDurationMs = useAppStore((s) => s.toastDurationMs);
  const clearToast = useAppStore((s) => s.clearToast);
  const openSettings = useAppStore((s) => s.openSettings);

  // Block devtools shortcuts & native context menu
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey && e.altKey && (e.key === "i" || e.key === "I")) ||
        (e.ctrlKey && e.shiftKey && (e.key === "i" || e.key === "I")) ||
        e.key === "F12"
      ) {
        e.preventDefault();
      }
    };
    const onContext = (e: MouseEvent) => {
      // Allow native context menu only inside text inputs/textareas
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", onContext, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onContext, true);
    };
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const timeout =
      toastDurationMs ?? (toastAction === "open_settings" ? 9000 : 2500);
    const timer = setTimeout(clearToast, timeout);
    return () => clearTimeout(timer);
  }, [toastMessage, toastAction, toastDurationMs, clearToast]);

  if (state.loading) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-[28px] bg-bg border border-overlay-6">
        <div className="w-8 h-8 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!state.isOnboarded || state.showVaultSwitcher) {
    return (
      <VaultSwitcherScreen
        onClose={actions.closeVaultSwitcher}
        canClose={state.isOnboarded && Boolean(state.vaultPath)}
      />
    );
  }

  const modelId = state.activeModelId;
  const paneToast = toastMessage ? (
    <div className="animate-fade-in pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-[min(92%,680px)] items-center gap-3 rounded-2xl border border-warning/25 bg-warning/10 px-4 py-3 text-xs text-warning shadow-lg shadow-warning/10 backdrop-blur-md">
        <span className="leading-relaxed">{toastMessage}</span>
        {toastAction === "open_settings" && (
          <button
            type="button"
            onClick={() => {
              openSettings();
              clearToast();
            }}
            className="shrink-0 rounded-lg border border-warning/40 bg-warning/15 px-2.5 py-1 text-[11px] font-medium text-warning transition-colors hover:bg-warning/25"
          >
            Open Settings
          </button>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="relative flex h-full w-full rounded-[28px] bg-bg border border-overlay-6 overflow-hidden">
      {/* Sidebar Wrapper */}
      <div className="relative flex h-full shrink-0 flex-col border-r border-overlay-5">
        <Sidebar
          conversations={state.conversations}
          folders={state.folders}
          activeConversationId={state.activeConversationId}
          vaultEntries={state.vaultEntries}
          loadingVaultFiles={state.loadingVaultFiles}
          activeNotePath={state.activeNote}
          onSelectConversation={actions.handleSelectConversation}
          onSelectNote={actions.handleSelectNote}
          onNewChat={actions.handleNewChat}
          onRenameConversation={actions.handleRenameConversation}
          onReorderConversations={actions.handleReorderConversations}
          onArchiveConversation={actions.handleArchiveConversation}
          onUnarchiveConversation={actions.handleUnarchiveConversation}
          onPinConversation={actions.handlePinConversation}
          onUnpinConversation={actions.handleUnpinConversation}
          onCreateChatFolder={actions.handleCreateChatFolder}
          onRenameChatFolder={actions.handleRenameChatFolder}
          onArchiveChatFolder={actions.handleArchiveChatFolder}
          onPinChatFolder={actions.handlePinChatFolder}
          onUnpinChatFolder={actions.handleUnpinChatFolder}
          onMoveChatFolder={actions.handleMoveChatFolder}
          onSetConversationFolder={actions.handleSetConversationFolder}
          onOpenFolderSettings={actions.handleOpenFolderSettings}
          onCreateKbNote={actions.handleCreateKbNote}
          onCreateKbFolder={actions.handleCreateKbFolder}
          onArchiveKbEntry={actions.handleArchiveKbEntry}
          onMoveKbEntry={actions.handleMoveKbEntry}
        />
      </div>

      {/* Main area Wrapper */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-scrim-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(52%_44%_at_50%_18%,var(--color-glow)_0%,transparent_75%)]"
        />

        {/* Header */}
        <header
          className="relative z-30 flex h-[44px] items-center justify-between border-b border-overlay-5 px-4 select-none"
        >
          <div className="relative z-10 flex items-center gap-2 shrink-0">
            <MeldMark className="h-4 w-4" />
            <VaultQuickSwitcher
              vaultName={state.vaultName || "No Vault"}
              onManageVaults={actions.openVaultSwitcher}
            />
          </div>
          <div className="h-full flex-1 min-w-0" />
          <div className="relative z-10 flex items-center gap-2 shrink-0 pl-2">
            <button
              onClick={actions.toggleHistory}
              className={`flex h-7 w-7 items-center justify-center rounded-xl transition-colors ${state.showHistory
                ? "bg-bg-tertiary text-text"
                : "text-text-muted hover:bg-overlay-5 hover:text-text"
                }`}
              title="History"
            >
              <History className="h-4 w-4" />
            </button>
            <button
              onClick={actions.toggleSettings}
              className={`flex h-7 w-7 items-center justify-center rounded-xl transition-colors ${state.showSettings
                ? "bg-bg-tertiary text-text"
                : "text-text-muted hover:bg-overlay-5 hover:text-text"
                }`}
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
            {/* Windows / Linux controls on the right */}
            <div className="ml-2 border-l border-overlay-5 pl-2 h-full hidden sm:flex items-center">
              <WindowControls placement="right" />
            </div>
          </div>
        </header>

        {/* Content */}
        <div className="relative z-0 flex min-h-0 flex-1">
          {state.showSettings ? (
            <div className="relative flex-1 overflow-y-auto">
              <SettingsPanel />
              {paneToast}
            </div>
          ) : state.showHistory ? (
            <div className="relative flex-1 overflow-y-auto">
              <HistoryPanel />
              {paneToast}
            </div>
          ) : state.showFolderSettings && state.activeFolderId ? (
            <div className="relative flex-1 overflow-y-auto">
              <FolderSettingsPanel
                folderId={state.activeFolderId}
                onClose={actions.handleCloseFolderSettings}
                onFolderArchived={actions.handleFolderArchived}
                onFolderUpdated={actions.handleFolderUpdated}
              />
              {paneToast}
            </div>
          ) : (
            <>
              <div className="relative flex-1 min-w-0">
                <ChatView
                  onSendMessage={actions.handleSendMessage}
                  onRegenerateLastResponse={actions.handleRegenerateLastResponse}
                  onEditMessage={actions.handleEditMessage}
                  onDeleteMessage={actions.handleDeleteMessage}
                  onOpenNote={actions.handleOpenNoteFromChat}
                  chatScopeLabel={state.chatScopeLabel}
                  isChatScopedToFolder={state.isChatScopedToFolder}
                />
                {paneToast}
              </div>
              <aside
                className={`shrink-0 overflow-hidden bg-scrim-20 transition-[width,border-color] duration-[280ms] ease-out ${
                  state.activeNote
                    ? "w-[420px] border-l border-overlay-5"
                    : "w-0 border-l border-transparent"
                }`}
              >
                <div
                  className={`h-full w-[420px] overflow-y-auto transition-opacity duration-200 ${
                    state.activeNote ? "opacity-100 delay-100" : "opacity-0"
                  }`}
                >
                  <NotePreview
                    notePath={state.activeNote}
                    content={state.noteContent}
                    loading={state.loadingNotePreview}
                    canGoBack={state.noteHistoryIndex > 0}
                    canGoForward={state.noteHistoryIndex < state.noteHistory.length - 1}
                    onGoBack={actions.goToPreviousNote}
                    onGoForward={actions.goToNextNote}
                    onOpenNote={actions.handleOpenNoteFromChat}
                    onOpenInEditor={actions.handleOpenNoteInEditor}
                  />
                </div>
              </aside>
            </>
          )}
        </div>

        {/* Status bar */}
        <StatusBar
          vaultPath={state.vaultPath}
          fileCount={state.fileCount}
          modelId={modelId}
          isIndexing={state.isIndexing}
          indexProgress={state.indexProgress}
          onReindex={actions.handleReindex}
        />
      </div>
    </div>
  );
}
