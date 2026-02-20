import { create } from "zustand";

/* ── Types ─────────────────────────────────────────────── */

export interface ToolCallEvent {
  run_id?: string;
  id?: string;
  iteration?: number;
  tool: string;
  args: string;
}

export interface ToolResultEvent {
  run_id?: string;
  id?: string;
  iteration?: number;
  tool: string;
  result: string;
}

export interface TimelineStep {
  run_id?: string;
  id: string;
  ts: string;
  phase: string;
  iteration: number;
  tool?: string;
  args_preview?: Record<string, unknown>;
  result_preview?: string;
  file_changes?: {
    path: string;
    action: "create" | "edit";
    bytes?: number;
    hash_after?: string;
  }[];
}

export interface ThinkingEntry {
  summary: string;
  iteration?: number;
  ts?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: number;
  runId?: string;
  thinkingSummary?: string;
  thinkingEntries?: ThinkingEntry[];
  sources?: string[];
  toolCalls?: ToolCallEvent[];
  timelineSteps?: TimelineStep[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  archived: boolean;
  pinned: boolean;
  sortOrder: number | null;
  folderId: string | null;
}

export interface Folder {
  id: string;
  name: string;
  icon: string | null;
  customInstruction: string | null;
  defaultModelId: string | null;
  parentId: string | null;
  pinned: boolean;
  archived: boolean;
  sortOrder: number | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentActivity =
  | { type: "planning"; iteration?: number }
  | { type: "thinking"; thinkingSummary?: string; iteration?: number }
  | { type: "tool"; tool?: string; iteration?: number }
  | { type: "verifying"; tool?: string; iteration?: number }
  | { type: "responding" };

export interface HistoryEntry {
  id: string;
  message: string;
  timestamp: number;
  files_changed: string[];
}

export type ToastAction = "open_settings";

export interface ToastOptions {
  action?: ToastAction;
  durationMs?: number;
}

/* ── State ─────────────────────────────────────────────── */

export interface AppState {
  // Vault
  vaultPath: string | null;
  isOnboarded: boolean;
  fileCount: number;

  // UI panels
  showSettings: boolean;
  showHistory: boolean;
  showVaultSwitcher: boolean;
  viewMode: "chats" | "files";
  sidebarCollapsed: boolean;

  // Note navigation
  activeNote: string | null;
  noteHistory: string[];
  noteHistoryIndex: number;

  // Conversations
  activeConversationId: string | null;
  conversations: Conversation[];

  // Folders
  folders: Folder[];
  activeFolderId: string | null;
  showFolderSettings: boolean;

  // Chat
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  streamSuppressed: boolean;

  // Agent
  agentActivity: AgentActivity | null;
  latestThinkingSummary: string | null;
  thinkingLog: ThinkingEntry[];
  toolCallLog: ToolCallEvent[];
  toolResultsLog: ToolResultEvent[];
  timelineSteps: TimelineStep[];

  // Indexing
  isIndexing: boolean;
  indexProgress: { current: number; total: number; file: string } | null;

  // Config
  chatProvider: string;
  chatModel: string;
  embeddingProvider: string;

  // Actions — vault
  setVaultPath: (path: string, fileCount: number) => void;
  setOnboarded: (v: boolean) => void;

  // Actions — UI
  openSettings: () => void;
  toggleSettings: () => void;
  toggleHistory: () => void;
  openVaultSwitcher: () => void;
  closeVaultSwitcher: () => void;
  setViewMode: (mode: "chats" | "files") => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebarCollapsed: () => void;

  // Actions — notes
  openNote: (path: string) => void;
  goToPreviousNote: () => void;
  goToNextNote: () => void;

  // Actions — conversations
  setConversations: (conversations: Conversation[]) => void;
  setActiveConversation: (id: string | null) => void;
  upsertConversation: (conversation: Conversation) => void;

  // Actions — folders
  setFolders: (folders: Folder[]) => void;
  openFolderSettings: (folderId: string) => void;
  closeFolderSettings: () => void;

  // Actions — chat
  addMessage: (msg: Message) => void;
  setMessages: (msgs: Message[]) => void;
  clearChat: () => void;
  newChat: () => void;
  setStreaming: (v: boolean) => void;
  setStreamSuppressed: (v: boolean) => void;
  appendStreamingContent: (chunk: string) => void;
  clearStreamingContent: () => void;

  // Actions — agent
  setAgentActivity: (activity: AgentActivity | null) => void;
  setLatestThinkingSummary: (summary: string | null) => void;
  addThinkingLog: (entry: ThinkingEntry) => void;
  clearThinkingLog: () => void;
  addToolCallLog: (entry: ToolCallEvent) => void;
  clearToolCallLog: () => void;
  addToolResultLog: (entry: ToolResultEvent) => void;
  clearToolResultLog: () => void;
  addTimelineStep: (step: TimelineStep) => void;
  clearTimeline: () => void;

  // Actions — indexing
  setIndexing: (v: boolean) => void;
  setIndexProgress: (
    p: { current: number; total: number; file: string } | null,
  ) => void;

  // Toast
  toastMessage: string | null;
  toastAction: ToastAction | null;
  toastDurationMs: number | null;
  showToast: (message: string, options?: ToastOptions) => void;
  clearToast: () => void;

  // Actions — config
  setChatProvider: (provider: string) => void;
  setChatModel: (model: string) => void;
  setEmbeddingProvider: (provider: string) => void;
}

/* ── Streaming batch buffer ────────────────────────────── */

let pendingChunks = "";
let flushScheduled = false;

/* ── Store ─────────────────────────────────────────────── */

export const useAppStore = create<AppState>((set) => ({
  vaultPath: null,
  isOnboarded: false,
  fileCount: 0,
  showSettings: false,
  showHistory: false,
  showVaultSwitcher: false,
  viewMode: "chats",
  sidebarCollapsed: false,
  activeNote: null,
  noteHistory: [],
  noteHistoryIndex: -1,
  activeConversationId: null,
  conversations: [],
  folders: [],
  activeFolderId: null,
  showFolderSettings: false,
  messages: [],
  isStreaming: false,
  streamingContent: "",
  streamSuppressed: false,
  agentActivity: null,
  latestThinkingSummary: null,
  thinkingLog: [],
  toolCallLog: [],
  toolResultsLog: [],
  timelineSteps: [],
  isIndexing: false,
  indexProgress: null,
  chatProvider: "openai",
  chatModel: "gpt-4o",
  embeddingProvider: "openai",

  // Vault
  setVaultPath: (path, fileCount) => set({ vaultPath: path, fileCount }),
  setOnboarded: (v) => set({ isOnboarded: v, showVaultSwitcher: false }),

  // UI
  openSettings: () =>
    set({
      showSettings: true,
      showHistory: false,
      showVaultSwitcher: false,
      showFolderSettings: false,
    }),
  toggleSettings: () =>
    set((s) => ({
      showSettings: !s.showSettings,
      showHistory: false,
      showVaultSwitcher: false,
      showFolderSettings: false,
    })),
  toggleHistory: () =>
    set((s) => ({
      showHistory: !s.showHistory,
      showSettings: false,
      showVaultSwitcher: false,
      showFolderSettings: false,
    })),
  openVaultSwitcher: () =>
    set({
      showVaultSwitcher: true,
      showSettings: false,
      showHistory: false,
      showFolderSettings: false,
    }),
  closeVaultSwitcher: () => set({ showVaultSwitcher: false }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebarCollapsed: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  // Notes
  openNote: (path) =>
    set((s) => {
      const trimmed = s.noteHistory.slice(0, s.noteHistoryIndex + 1);
      return {
        activeNote: path,
        noteHistory: [...trimmed, path],
        noteHistoryIndex: trimmed.length,
      };
    }),
  goToPreviousNote: () =>
    set((s) => {
      if (s.noteHistoryIndex <= 0) return {};
      const idx = s.noteHistoryIndex - 1;
      return { noteHistoryIndex: idx, activeNote: s.noteHistory[idx] ?? null };
    }),
  goToNextNote: () =>
    set((s) => {
      if (s.noteHistoryIndex >= s.noteHistory.length - 1) return {};
      const idx = s.noteHistoryIndex + 1;
      return { noteHistoryIndex: idx, activeNote: s.noteHistory[idx] ?? null };
    }),

  // Folders
  setFolders: (folders) => set({ folders }),
  openFolderSettings: (folderId) =>
    set({
      activeFolderId: folderId,
      showFolderSettings: true,
      showSettings: false,
      showHistory: false,
      showVaultSwitcher: false,
    }),
  closeFolderSettings: () =>
    set({ showFolderSettings: false, activeFolderId: null }),

  // Conversations
  setConversations: (conversations) => set({ conversations }),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  upsertConversation: (conversation) =>
    set((s) => {
      const idx = s.conversations.findIndex((c) => c.id === conversation.id);
      if (idx >= 0) {
        const updated = [...s.conversations];
        updated[idx] = conversation;
        return { conversations: updated };
      }
      return { conversations: [conversation, ...s.conversations] };
    }),

  // Chat
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setMessages: (msgs) => set({ messages: msgs }),
  clearChat: () =>
    set({
      messages: [],
      streamingContent: "",
      streamSuppressed: false,
      agentActivity: null,
      latestThinkingSummary: null,
      thinkingLog: [],
      toolCallLog: [],
      toolResultsLog: [],
      timelineSteps: [],
    }),
  newChat: () =>
    set({
      activeConversationId: null,
      messages: [],
      streamingContent: "",
      streamSuppressed: false,
      agentActivity: null,
      latestThinkingSummary: null,
      thinkingLog: [],
      toolCallLog: [],
      toolResultsLog: [],
      timelineSteps: [],
    }),
  setStreaming: (v) => set({ isStreaming: v }),
  setStreamSuppressed: (v) => set({ streamSuppressed: v }),
  appendStreamingContent: (chunk) => {
    pendingChunks += chunk;
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(() => {
        const flushed = pendingChunks;
        pendingChunks = "";
        flushScheduled = false;
        set((s) => ({ streamingContent: s.streamingContent + flushed }));
      });
    }
  },
  clearStreamingContent: () => set({ streamingContent: "" }),

  // Agent
  setAgentActivity: (activity) => set({ agentActivity: activity }),
  setLatestThinkingSummary: (summary) => set({ latestThinkingSummary: summary }),
  addThinkingLog: (entry) =>
    set((s) => {
      const summary = entry.summary.trim();
      if (!summary) return {};
      const last = s.thinkingLog[s.thinkingLog.length - 1];
      if (last && last.iteration === entry.iteration) {
        // Same iteration: cumulative streaming — replace last entry
        if (summary === last.summary) return {};
        const updated = s.thinkingLog.slice(0, -1);
        updated.push({ ...entry, summary });
        return { thinkingLog: updated };
      }
      return {
        thinkingLog: [...s.thinkingLog, { ...entry, summary }],
      };
    }),
  clearThinkingLog: () => set({ thinkingLog: [] }),
  addToolCallLog: (entry) =>
    set((s) => ({ toolCallLog: [...s.toolCallLog, entry] })),
  clearToolCallLog: () => set({ toolCallLog: [] }),
  addToolResultLog: (entry) =>
    set((s) => ({ toolResultsLog: [...s.toolResultsLog, entry] })),
  clearToolResultLog: () => set({ toolResultsLog: [] }),
  addTimelineStep: (step) =>
    set((s) => ({ timelineSteps: [...s.timelineSteps, step] })),
  clearTimeline: () => set({ timelineSteps: [] }),

  // Indexing
  setIndexing: (v) => set({ isIndexing: v }),
  setIndexProgress: (p) => set({ indexProgress: p }),

  // Toast
  toastMessage: null,
  toastAction: null,
  toastDurationMs: null,
  showToast: (message, options) =>
    set({
      toastMessage: message,
      toastAction: options?.action ?? null,
      toastDurationMs: options?.durationMs ?? null,
    }),
  clearToast: () =>
    set({ toastMessage: null, toastAction: null, toastDurationMs: null }),

  // Config
  setChatProvider: (provider) => set({ chatProvider: provider }),
  setChatModel: (model) => set({ chatModel: model }),
  setEmbeddingProvider: (provider) => set({ embeddingProvider: provider }),
}));
