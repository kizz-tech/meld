"use client";

import { useHomeController } from "@/features/layout/controllers/useHomeController";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import ChatView from "@/components/chat/ChatView";
import Sidebar from "@/components/sidebar/Sidebar";
import NotePreview from "@/components/vault/NotePreview";
import SettingsPanel from "@/components/settings/SettingsPanel";
import HistoryPanel from "@/components/history/HistoryPanel";
import StatusBar from "@/components/ui/StatusBar";

export default function Home() {
  const { state, actions } = useHomeController();

  if (!state.isOnboarded) {
    return <OnboardingFlow />;
  }

  if (state.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="w-8 h-8 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const modelId = state.chatModel
    ? `${state.chatProvider}:${state.chatModel}`
    : state.chatProvider || "—";

  return (
    <div className="relative flex h-screen bg-bg">
      {/* Sidebar */}
      <Sidebar
        conversations={state.conversations}
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
        onCreateKbNote={actions.handleCreateKbNote}
        onCreateKbFolder={actions.handleCreateKbFolder}
        onArchiveKbEntry={actions.handleArchiveKbEntry}
        onMoveKbEntry={actions.handleMoveKbEntry}
      />

      {/* Main area */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(52%_44%_at_50%_18%,rgba(232,228,220,0.04)_0%,rgba(232,228,220,0)_75%)]"
        />

        {/* Header */}
        <header className="relative z-10 flex items-center justify-between border-b border-border/15 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-accent/12 text-xs font-semibold text-accent">
              M
            </span>
            <h1 className="font-display text-[15px] italic tracking-tight text-text">
              meld
            </h1>
            {state.vaultPath && (
              <span className="max-w-[220px] truncate text-xs text-text-muted">
                {state.vaultName}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={actions.toggleHistory}
              className={`flex h-8 w-8 items-center justify-center rounded-md border transition-all duration-[120ms] ${
                state.showHistory
                  ? "border-transparent bg-bg-tertiary text-text"
                  : "border-transparent text-text-muted hover:bg-bg-tertiary/70 hover:text-text-secondary"
              }`}
              title="History"
              aria-label="History"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v4h4" />
                <path d="M12 7v5l3 2" />
              </svg>
            </button>
            <button
              onClick={actions.toggleSettings}
              className={`flex h-8 w-8 items-center justify-center rounded-md border transition-all duration-[120ms] ${
                state.showSettings
                  ? "border-transparent bg-bg-tertiary text-text"
                  : "border-transparent text-text-muted hover:bg-bg-tertiary/70 hover:text-text-secondary"
              }`}
              title="Settings"
              aria-label="Settings"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.54-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.54V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.54h.01a1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.54 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.54 1z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="relative z-10 flex min-h-0 flex-1">
          {state.showSettings ? (
            <div className="flex-1 overflow-y-auto">
              <SettingsPanel />
            </div>
          ) : state.showHistory ? (
            <div className="flex-1 overflow-y-auto">
              <HistoryPanel />
            </div>
          ) : (
            <>
              <div className="flex-1 min-w-0">
                <ChatView
                  onSendMessage={actions.handleSendMessage}
                  onRegenerateLastResponse={actions.handleRegenerateLastResponse}
                  onEditMessage={actions.handleEditMessage}
                  onDeleteMessage={actions.handleDeleteMessage}
                  onOpenNote={actions.handleOpenNoteFromChat}
                />
              </div>
              {state.activeNote && (
                <aside className="w-[420px] border-l border-border/20 overflow-y-auto bg-bg-secondary/50">
                  <NotePreview
                    notePath={state.activeNote}
                    content={state.noteContent}
                    loading={state.loadingNotePreview}
                    canGoBack={state.noteHistoryIndex > 0}
                    canGoForward={
                      state.noteHistoryIndex < state.noteHistory.length - 1
                    }
                    onGoBack={actions.goToPreviousNote}
                    onGoForward={actions.goToNextNote}
                    onOpenNote={actions.handleOpenNoteFromChat}
                    onOpenInEditor={actions.handleOpenNoteInEditor}
                  />
                </aside>
              )}
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
