import { invoke } from "@tauri-apps/api/core";

/* ── Backend payload types (snake_case from Rust) ──────── */

export interface VaultInfo {
  path: string;
  file_count: number;
  total_size_bytes: number;
}

export interface VaultFileEntry {
  path: string;
  relative_path: string;
  updated_at?: number;
}

export interface VaultEntry {
  kind: "file" | "folder";
  path: string;
  relative_path: string;
  updated_at?: number;
}

export interface ConversationPayload {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  message_count?: number;
  archived?: boolean;
  pinned?: boolean;
  sort_order?: number | null;
}

export interface ConversationMessagePayload {
  id: string | number;
  role: string;
  content: string;
  run_id?: string;
  thinking_summary?: string;
  sources?: unknown;
  tool_calls?: unknown;
  timeline?: unknown;
  created_at?: string;
  timestamp?: string;
}

export interface SendMessageResponse {
  conversation_id: string;
}

export interface Config {
  vault_path: string | null;
  user_language: string | null;
  chat_provider: string | null;
  chat_model: string | null;
  chat_model_id: string | null;
  fallback_chat_model_id: string | null;
  embedding_provider: string | null;
  embedding_model_id: string | null;
  api_keys: Record<string, string>;
  auth_modes: Record<string, string>;
  oauth_clients: Record<string, unknown>;
  oauth_tokens: Record<string, unknown>;
  retrieval_rerank_enabled: boolean;
  retrieval_rerank_top_k: number;
  search_provider: string | null;
  searxng_base_url: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  google_api_key: string | null;
  tavily_api_key: string | null;
}

export interface ProviderCatalogEntry {
  id: string;
  display_name: string;
  supports_llm: boolean;
  supports_embeddings: boolean;
  auth_modes: string[];
}

export interface OauthStartResponse {
  flow_id: string;
  auth_url: string;
}

export interface OauthFinishResponse {
  success: boolean;
}

export interface HistoryEntry {
  id: string;
  message: string;
  timestamp: number;
  files_changed: string[];
}

export interface RunSummaryPayload {
  run_id: string;
  conversation_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  policy_version: string | null;
  policy_fingerprint: string | null;
  tool_calls: number;
  write_calls: number;
  verify_failures: number;
  duration_ms: number | null;
  token_usage: unknown;
}

export interface RunEventPayload {
  id: number;
  run_id: string;
  iteration: number;
  channel: string;
  event_type: string;
  payload: unknown;
  ts: string;
}

export type RunTokenUsagePayload = Record<string, unknown>;

/* ── Vault ─────────────────────────────────────────────── */

export async function selectVault(path: string): Promise<VaultInfo> {
  return invoke<VaultInfo>("select_vault", { path });
}

export async function getVaultInfo(): Promise<VaultInfo | null> {
  return invoke<VaultInfo | null>("get_vault_info");
}

export async function reindex(): Promise<void> {
  return invoke("reindex");
}

export async function listVaultFiles(): Promise<VaultFileEntry[]> {
  return invoke<VaultFileEntry[]>("list_vault_files");
}

export async function listVaultEntries(): Promise<VaultEntry[]> {
  return invoke<VaultEntry[]>("list_vault_entries");
}

export async function previewFile(path: string): Promise<string> {
  return invoke<string>("preview_file", { path });
}

export async function resolveOrCreateNote(path: string): Promise<string> {
  return invoke<string>("resolve_or_create_note", { path });
}

export async function createNote(path: string): Promise<string> {
  return invoke<string>("create_note", { path });
}

export async function createFolder(path: string): Promise<string> {
  return invoke<string>("create_folder", { path });
}

export async function archiveVaultEntry(path: string): Promise<void> {
  return invoke("archive_vault_entry", { path });
}

export async function moveVaultEntry(
  fromPath: string,
  toPath: string,
): Promise<string> {
  return invoke<string>("move_vault_entry", { fromPath, toPath });
}

/* ── Conversations ─────────────────────────────────────── */

export async function createConversation(
  title?: string,
): Promise<string> {
  return invoke<string>("create_conversation", { title: title ?? null });
}

export async function listConversations(): Promise<ConversationPayload[]> {
  return invoke<ConversationPayload[]>("list_conversations");
}

export async function listArchivedConversations(): Promise<
  ConversationPayload[]
> {
  return invoke<ConversationPayload[]>("list_archived_conversations");
}

export async function getConversationMessages(
  conversationId: string,
): Promise<ConversationMessagePayload[]> {
  return invoke<ConversationMessagePayload[]>("get_conversation_messages", {
    conversationId,
  });
}

export async function deleteMessage(messageId: string): Promise<void> {
  return invoke("delete_message", { messageId });
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<void> {
  return invoke("rename_conversation", { conversationId, title });
}

export async function archiveConversation(
  conversationId: string,
): Promise<void> {
  return invoke("archive_conversation", { conversationId });
}

export async function unarchiveConversation(
  conversationId: string,
): Promise<void> {
  return invoke("unarchive_conversation", { conversationId });
}

export async function pinConversation(
  conversationId: string,
): Promise<void> {
  return invoke("pin_conversation", { conversationId });
}

export async function unpinConversation(
  conversationId: string,
): Promise<void> {
  return invoke("unpin_conversation", { conversationId });
}

export async function reorderConversations(
  conversationIds: string[],
): Promise<void> {
  return invoke("reorder_conversations", { conversationIds });
}

export async function cancelActiveRun(
  conversationId: string,
): Promise<boolean> {
  return invoke<boolean>("cancel_active_run", { conversationId });
}

export async function exportConversation(
  conversationId: string,
  filePath: string,
  title?: string,
): Promise<void> {
  return invoke("export_conversation", {
    conversationId,
    filePath,
    title: title ?? null,
  });
}

/* ── Chat / Agent ──────────────────────────────────────── */

export async function sendMessage(
  message: string,
  conversationId?: string | null,
): Promise<SendMessageResponse> {
  return invoke<SendMessageResponse>("send_message", {
    message,
    conversationId: conversationId ?? null,
  });
}

export async function regenerateLastResponse(
  conversationId: string,
  assistantMessageId?: string | null,
): Promise<SendMessageResponse> {
  return invoke<SendMessageResponse>("regenerate_last_response", {
    conversationId,
    assistantMessageId: assistantMessageId ?? null,
  });
}

export async function editUserMessage(
  messageId: string,
  content: string,
): Promise<SendMessageResponse> {
  return invoke<SendMessageResponse>("edit_user_message", {
    messageId,
    content,
  });
}

/* ── Runs ──────────────────────────────────────────────── */

export async function listRuns(
  conversationId?: string | null,
  limit?: number | null,
): Promise<RunSummaryPayload[]> {
  return invoke<RunSummaryPayload[]>("list_runs", {
    conversationId: conversationId ?? null,
    limit: limit ?? null,
  });
}

export async function getRunEvents(
  runId: string,
): Promise<RunEventPayload[]> {
  return invoke<RunEventPayload[]>("get_run_events", { runId });
}

/* ── Settings ──────────────────────────────────────────── */

export async function getConfig(): Promise<Config> {
  return invoke<Config>("get_config");
}

export async function getProviderCatalog(): Promise<ProviderCatalogEntry[]> {
  return invoke<ProviderCatalogEntry[]>("get_provider_catalog");
}

export async function setApiKey(
  provider: string,
  key: string,
): Promise<void> {
  return invoke("set_api_key", { provider, key });
}

export async function setAuthMode(
  provider: string,
  mode: string,
): Promise<void> {
  return invoke("set_auth_mode", { provider, mode });
}

export async function setOauthClient(
  provider: string,
  clientId: string,
): Promise<void> {
  return invoke("set_oauth_client", { provider, clientId });
}

export async function startOauth(
  provider: string,
): Promise<OauthStartResponse> {
  return invoke<OauthStartResponse>("start_oauth", { provider });
}

export async function finishOauth(
  provider: string,
  flowId: string,
  timeoutMs?: number,
): Promise<OauthFinishResponse> {
  return invoke<OauthFinishResponse>("finish_oauth", {
    provider,
    flowId,
    timeoutMs: timeoutMs ?? null,
  });
}

export async function disconnectOauth(provider: string): Promise<void> {
  return invoke("disconnect_oauth", { provider });
}

export async function setModel(
  provider: string,
  model: string,
): Promise<void> {
  return invoke("set_model", { provider, model });
}

export async function setEmbeddingModel(
  provider: string,
  model: string,
): Promise<void> {
  return invoke("set_embedding_model", { provider, model });
}

export async function setFallbackModel(
  modelId?: string | null,
): Promise<void> {
  return invoke("set_fallback_model", { modelId: modelId ?? null });
}

export async function setUserLanguage(language: string): Promise<void> {
  return invoke("set_user_language", { language });
}

export async function setSearchProvider(provider: string): Promise<void> {
  return invoke("set_search_provider", { provider });
}

export async function setSearxngBaseUrl(url: string): Promise<void> {
  return invoke("set_searxng_base_url", { url });
}

/* ── History ───────────────────────────────────────────── */

export async function getHistory(): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("get_history");
}

export async function revertCommit(commitId: string): Promise<void> {
  return invoke("revert_commit", { commitId });
}

/* ── Misc ──────────────────────────────────────────────── */

export async function openFileExternal(path: string): Promise<void> {
  return invoke("open_file_external", { path });
}

/* ── Dev ───────────────────────────────────────────────── */

export async function openDevtools(): Promise<void> {
  return invoke("open_devtools");
}
