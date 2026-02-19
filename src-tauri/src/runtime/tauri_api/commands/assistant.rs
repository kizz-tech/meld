use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Listener};

use crate::core::ports::tools::ToolPort;

use super::shared::{TimelineStepEvent, ToolCallEvent, ToolResultEvent};

#[derive(Debug, Default, Clone)]
struct AssistantCapture {
    content: String,
    tool_calls: Vec<ToolCallEvent>,
    sources: Vec<String>,
    timeline_steps: Vec<TimelineStepEvent>,
}

#[derive(Debug)]
struct ActiveAssistantRun {
    token: u64,
    cancel_tx: tokio::sync::oneshot::Sender<()>,
}

static ACTIVE_ASSISTANT_RUNS: std::sync::OnceLock<Mutex<HashMap<i64, ActiveAssistantRun>>> =
    std::sync::OnceLock::new();
static NEXT_ASSISTANT_RUN_TOKEN: AtomicU64 = AtomicU64::new(1);

fn active_assistant_runs() -> &'static Mutex<HashMap<i64, ActiveAssistantRun>> {
    ACTIVE_ASSISTANT_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_assistant_run(conversation_id: i64, run: ActiveAssistantRun) {
    if let Ok(mut active_runs) = active_assistant_runs().lock() {
        if let Some(previous_run) = active_runs.remove(&conversation_id) {
            let _ = previous_run.cancel_tx.send(());
        }
        active_runs.insert(conversation_id, run);
    }
}

fn finish_assistant_run(conversation_id: i64, token: u64) {
    if let Ok(mut active_runs) = active_assistant_runs().lock() {
        let should_remove = active_runs
            .get(&conversation_id)
            .map(|run| run.token == token)
            .unwrap_or(false);
        if should_remove {
            active_runs.remove(&conversation_id);
        }
    }
}

pub(crate) fn cancel_active_run(conversation_id: i64) -> bool {
    if let Ok(mut active_runs) = active_assistant_runs().lock() {
        if let Some(active_run) = active_runs.remove(&conversation_id) {
            let _ = active_run.cancel_tx.send(());
            return true;
        }
    }
    false
}

fn default_empty_assistant_message() -> String {
    "I could not generate a response from the model. Please retry or switch to another model."
        .to_string()
}

fn decode_event_payload<T: DeserializeOwned>(payload: &str) -> Option<T> {
    serde_json::from_str::<T>(payload).ok()
}

fn parse_tool_result_value(value: &serde_json::Value) -> Option<serde_json::Value> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(raw) => serde_json::from_str::<serde_json::Value>(raw).ok(),
        other => Some(other.clone()),
    }
}

fn push_unique_source(sources: &mut Vec<String>, source: String) {
    if !sources.iter().any(|existing| existing == &source) {
        sources.push(source);
    }
}

fn extract_sources_from_tool_result(tool: &str, value: &serde_json::Value) -> Vec<String> {
    let mut sources = Vec::new();

    match tool {
        "kb_search" => {
            let chunks = value
                .pointer("/result/chunks")
                .and_then(|v| v.as_array())
                .or_else(|| value.get("chunks").and_then(|v| v.as_array()))
                .or_else(|| value.as_array());
            if let Some(items) = chunks {
                for item in items {
                    if let Some(file_path) = item.get("file_path").and_then(|v| v.as_str()) {
                        push_unique_source(&mut sources, file_path.to_string());
                    }
                }
            }
        }
        "kb_read" | "kb_create" | "kb_update" => {
            if let Some(path) = value
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str())
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
            {
                push_unique_source(&mut sources, path.to_string());
            }
            for key in ["path", "created", "edited"] {
                if let Some(path) = value.get(key).and_then(|v| v.as_str()) {
                    push_unique_source(&mut sources, path.to_string());
                }
            }
        }
        "web_search" => {
            let items = value
                .pointer("/result/results")
                .and_then(|v| v.as_array())
                .or_else(|| value.get("results").and_then(|v| v.as_array()));
            if let Some(items) = items {
                for item in items {
                    if item.get("type").and_then(|v| v.as_str()) == Some("result") {
                        if let Some(url) = item
                            .get("url")
                            .and_then(|v| v.as_str())
                            .map(|url| url.trim())
                            .filter(|url| !url.is_empty())
                        {
                            push_unique_source(&mut sources, url.to_string());
                        }
                    }
                }
            }
        }
        _ => {}
    }

    sources
}

fn register_capture_listeners(
    app: &AppHandle,
    capture: Arc<Mutex<AssistantCapture>>,
) -> Vec<tauri::EventId> {
    let mut listeners = Vec::new();

    let capture_for_chunks = capture.clone();
    listeners.push(app.listen_any("chat:chunk", move |event| {
        if let Some(chunk) = decode_event_payload::<String>(event.payload()) {
            if let Ok(mut state) = capture_for_chunks.lock() {
                state.content.push_str(&chunk);
            }
        }
    }));

    let capture_for_calls = capture.clone();
    listeners.push(app.listen_any("agent:tool_call", move |event| {
        if let Some(tool_call) = decode_event_payload::<ToolCallEvent>(event.payload()) {
            if let Ok(mut state) = capture_for_calls.lock() {
                state.tool_calls.push(tool_call);
            }
        }
    }));

    let capture_for_results = capture.clone();
    listeners.push(app.listen_any("agent:tool_result", move |event| {
        if let Some(tool_result) = decode_event_payload::<ToolResultEvent>(event.payload()) {
            if let Some(parsed_result) = parse_tool_result_value(&tool_result.result) {
                let extracted = extract_sources_from_tool_result(&tool_result.tool, &parsed_result);
                if let Ok(mut state) = capture_for_results.lock() {
                    for source in extracted {
                        push_unique_source(&mut state.sources, source);
                    }
                }
            }
        }
    }));

    listeners.push(app.listen_any("agent:timeline_step", move |event| {
        if let Some(timeline_step) = decode_event_payload::<TimelineStepEvent>(event.payload()) {
            if let Ok(mut state) = capture.lock() {
                state.timeline_steps.push(timeline_step);
            }
        }
    }));

    listeners
}

fn merge_instruction_texts(global: Option<String>, local: Option<String>) -> Option<String> {
    match (global, local) {
        (Some(g), Some(l)) => Some(format!("{g}\n\n{l}")),
        (Some(g), None) => Some(g),
        (None, Some(l)) => Some(l),
        (None, None) => None,
    }
}

fn load_instruction_sources(vault: &Path) -> crate::core::agent::instructions::InstructionSources {
    match crate::adapters::vault::ensure_vault_initialized(vault) {
        Ok(()) => {}
        Err(error) => {
            log::warn!("failed to initialize vault instructions: {}", error);
        }
    }

    let agents_md = crate::adapters::vault::read_agents_md(vault);

    let global_rules = crate::adapters::vault::read_global_rules();
    let local_rules = crate::adapters::vault::read_meld_rules(vault);
    let rules = merge_instruction_texts(global_rules, local_rules);

    let global_hints = crate::adapters::vault::read_global_hints();
    let local_hints = crate::adapters::vault::read_meld_hints(vault);
    let hints = merge_instruction_texts(global_hints, local_hints);

    crate::core::agent::instructions::InstructionSources {
        agents_md,
        rules,
        hints,
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_assistant_run(
    app: &AppHandle,
    capture: Arc<Mutex<AssistantCapture>>,
    conversation_id: i64,
    vault_path: String,
    user_prompt: String,
    api_key: String,
    provider: String,
    model: String,
    db_path: PathBuf,
    is_regeneration: bool,
) -> Result<(), String> {
    let vault = Path::new(&vault_path);
    let note_count = crate::adapters::vault::list_md_files(vault)
        .map(|files| files.len())
        .unwrap_or(0);
    let (indexed_files, indexed_chunks) = crate::adapters::vectordb::VectorDb::open(&db_path)
        .ok()
        .and_then(|db| db.index_stats().ok())
        .unwrap_or((0, 0));

    let global_settings = crate::adapters::config::Settings::load_global();
    let vault_config = crate::adapters::config::VaultConfig::load(vault);
    let mut settings = global_settings.merged_with_vault(&vault_config);
    let user_language = settings.user_language();
    let embedding_provider = settings.embedding_provider();
    let embedding_key =
        crate::adapters::oauth::resolve_provider_credential(&mut settings, &embedding_provider)
            .await
            .unwrap_or_default();
    let embedding_model_id = settings.embedding_model_id();
    let tavily_api_key = settings.tavily_api_key();
    let search_provider = settings.search_provider();
    let searxng_base_url = settings.searxng_base_url();
    let brave_api_key = settings.api_key_for_provider("brave").unwrap_or_default();
    let has_web_search = match search_provider.as_str() {
        "searxng" => true,
        "brave" => !brave_api_key.is_empty(),
        _ => !tavily_api_key.is_empty(),
    };

    let tool_registry = crate::adapters::mcp::ToolRegistry::new(has_web_search);
    let tool_prompt_lines = ToolPort::prompt_tool_lines(&tool_registry);
    let instruction_sources = load_instruction_sources(vault);
    let composed_prompt = crate::core::agent::instructions::compose_system_prompt_with_metadata(
        &vault_path,
        note_count,
        user_language.as_deref(),
        &provider,
        &model,
        &tool_prompt_lines,
        instruction_sources,
    );

    let agent = crate::core::agent::Agent::new(
        Arc::new(tool_registry),
        Arc::new(crate::adapters::llm::ChatLlmAdapter::new()),
        Arc::new(crate::adapters::vectordb::SqliteRunStore::new(
            db_path.clone(),
        )),
        Arc::new(crate::adapters::emitter::TauriEmitter::new(app.clone())),
    );

    let run_result: Result<crate::core::agent::RunResult, _> = agent
        .run(crate::core::agent::RunRequest {
            conversation_id,
            user_message: &user_prompt,
            instructions: composed_prompt.prompt,
            policy_version: composed_prompt.policy_version,
            policy_fingerprint: composed_prompt.policy_fingerprint,
            api_key: &api_key,
            provider: &provider,
            model: &model,
            is_regeneration,
            vault_path: vault,
            db_path: &db_path,
            embedding_key: &embedding_key,
            embedding_model_id: &embedding_model_id,
            tavily_api_key: &tavily_api_key,
            search_provider: &search_provider,
            searxng_base_url: &searxng_base_url,
            brave_api_key: &brave_api_key,
            note_count,
            indexed_files: indexed_files.max(0) as usize,
            indexed_chunks: indexed_chunks.max(0) as usize,
            budget: crate::core::agent::RunBudget::default(),
        })
        .await;
    if let Ok(run) = &run_result {
        log::debug!(
            "agent run completed: id={}, status={}, tools={}, writes={}, verify_failures={}, duration_ms={}",
            run.run_id,
            run.status.as_str(),
            run.tool_calls,
            run.write_calls,
            run.verify_failures,
            run.duration_ms
        );
    }

    match run_result {
        Ok(_) => {
            let captured = capture.lock().map(|data| data.clone()).unwrap_or_default();
            let assistant_content = if captured.content.trim().is_empty() {
                default_empty_assistant_message()
            } else {
                captured.content
            };

            let tool_calls = if captured.tool_calls.is_empty() {
                None
            } else {
                serde_json::to_string(&captured.tool_calls).ok()
            };
            let sources = if captured.sources.is_empty() {
                None
            } else {
                serde_json::to_string(&captured.sources).ok()
            };
            let timeline = if captured.timeline_steps.is_empty() {
                None
            } else {
                serde_json::to_string(&captured.timeline_steps).ok()
            };

            let persist_result =
                crate::adapters::vectordb::VectorDb::open(&db_path).and_then(|mut db| {
                    db.save_message(
                        conversation_id,
                        "assistant",
                        &assistant_content,
                        sources.as_deref(),
                        tool_calls.as_deref(),
                        timeline.as_deref(),
                    )
                    .map(|_| ())
                });

            match persist_result {
                Ok(_) => {
                    let done_payload = serde_json::json!({
                        "content": assistant_content,
                        "sources": sources,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });
                    if let Err(error) = app.emit("chat:done", done_payload) {
                        log::warn!("failed to emit chat:done: {}", error);
                    }
                    Ok(())
                }
                Err(error) => {
                    let message = error.to_string();
                    let _ = app.emit("chat:error", message.clone());
                    Err(message)
                }
            }
        }
        Err(error) => {
            let message = error.to_string();
            let _ = app.emit("chat:error", message.clone());
            Err(message)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_assistant_task(
    app: AppHandle,
    conversation_id: i64,
    vault_path: String,
    user_prompt: String,
    api_key: String,
    provider: String,
    model: String,
    db_path: PathBuf,
    is_regeneration: bool,
) {
    let run_token = NEXT_ASSISTANT_RUN_TOKEN.fetch_add(1, Ordering::Relaxed);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    register_assistant_run(
        conversation_id,
        ActiveAssistantRun {
            token: run_token,
            cancel_tx,
        },
    );

    tokio::spawn(async move {
        let capture = Arc::new(Mutex::new(AssistantCapture::default()));
        let listener_ids = register_capture_listeners(&app, capture.clone());
        let cancelled = tokio::select! {
            _ = &mut cancel_rx => true,
            run_outcome = execute_assistant_run(
                &app,
                capture.clone(),
                conversation_id,
                vault_path,
                user_prompt,
                api_key,
                provider,
                model,
                db_path,
                is_regeneration,
            ) => {
                if let Err(error) = run_outcome {
                    log::warn!("assistant run failed: {}", error);
                }
                false
            },
        };

        for listener_id in listener_ids {
            app.unlisten(listener_id);
        }

        if cancelled {
            let _ = app.emit(
                "chat:cancelled",
                serde_json::json!({
                    "conversation_id": conversation_id.to_string(),
                }),
            );
        }

        finish_assistant_run(conversation_id, run_token);
    });
}
