import type { AppState } from "@/lib/store";

export const selectChatViewState = (state: AppState) => ({
  messages: state.messages,
  streamingContent: state.streamingContent,
  isStreaming: state.isStreaming,
  agentActivity: state.agentActivity,
  timelineSteps: state.timelineSteps,
  thinkingLog: state.thinkingLog,
});

export const selectMessageInputState = (state: AppState) => ({
  isStreaming: state.isStreaming,
  streamSuppressed: state.streamSuppressed,
  isIndexing: state.isIndexing,
  activeConversationId: state.activeConversationId,
});

export const selectActiveConversationId = (state: AppState) =>
  state.activeConversationId;

export const selectVaultPath = (state: AppState) => state.vaultPath;

export const selectSidebarState = (state: AppState) => ({
  sidebarCollapsed: state.sidebarCollapsed,
  toggleSidebarCollapsed: state.toggleSidebarCollapsed,
  viewMode: state.viewMode,
  setViewMode: state.setViewMode,
});

export const selectNoteNavigation = (state: AppState) => ({
  activeNote: state.activeNote,
  noteHistory: state.noteHistory,
  noteHistoryIndex: state.noteHistoryIndex,
});

export const selectSettingsState = (state: AppState) => ({
  chatProvider: state.chatProvider,
  chatModel: state.chatModel,
  embeddingProvider: state.embeddingProvider,
});
