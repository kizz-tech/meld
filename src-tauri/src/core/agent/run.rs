use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use crate::adapters::llm::{TokenUsage, ToolCall};
use crate::core::ports::emitter::EmitterPort;
use crate::core::ports::llm::{ChatMessage, DynError, LlmChatRequest, RecoveryEvent, StreamEvent};
use crate::core::ports::store::StorePort;
use crate::core::ports::tools::ToolExecutionContext;

use super::budget::{budget_timeout_reason, RunBudget};
use super::compaction::maybe_compact_context;
use super::events::{emit_run_state, emit_timeline_done, emit_timeline_step, now_iso};
use super::ledger::{append_run_event_ledger, finish_run_ledger, start_run_ledger};
use super::state::{is_indexing_active, AgentState};
use super::verification::{
    args_preview, build_verification_event, build_verify_summary, extract_file_changes,
    extract_result_preview,
};
use super::Agent;

pub struct RunRequest<'a> {
    pub conversation_id: i64,
    pub user_message: &'a str,
    pub instructions: String,
    pub policy_version: String,
    pub policy_fingerprint: String,
    pub api_key: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub is_regeneration: bool,
    pub vault_path: &'a Path,
    pub db_path: &'a Path,
    pub embedding_key: &'a str,
    pub embedding_model_id: &'a str,
    pub tavily_api_key: &'a str,
    pub search_provider: &'a str,
    pub searxng_base_url: &'a str,
    pub brave_api_key: &'a str,
    pub note_count: usize,
    pub indexed_files: usize,
    pub indexed_chunks: usize,
    pub budget: RunBudget,
}

#[derive(Debug, Clone)]
pub struct RunResult {
    pub run_id: String,
    pub status: AgentState,
    pub tool_calls: u32,
    pub write_calls: u32,
    pub verify_failures: u32,
    pub duration_ms: u64,
    #[allow(dead_code)]
    pub token_usage: Option<TokenUsage>,
}

#[allow(clippy::too_many_arguments)]
fn emit_state_and_finish(
    emitter: &dyn EmitterPort,
    store: &dyn StorePort,
    run_id: &str,
    iteration: usize,
    status: AgentState,
    reason: Option<&str>,
    tool_calls: u32,
    write_calls: u32,
    verify_failures: u32,
    run_started: Instant,
    token_usage: &TokenUsage,
) -> RunResult {
    let payload = emit_run_state(emitter, run_id, status, iteration, reason);
    append_run_event_ledger(
        store,
        run_id,
        iteration,
        "lifecycle",
        "agent:run_state",
        &payload,
    );
    let duration_ms = run_started.elapsed().as_millis() as u64;
    let token_usage = (!token_usage.is_empty()).then_some(token_usage.clone());
    finish_run_ledger(
        store,
        run_id,
        status,
        tool_calls,
        write_calls,
        verify_failures,
        duration_ms,
        token_usage.as_ref(),
    );

    RunResult {
        run_id: run_id.to_string(),
        status,
        tool_calls,
        write_calls,
        verify_failures,
        duration_ms,
        token_usage,
    }
}

fn normalize_thinking_summary(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn append_thinking_chunk(buffer: &mut String, chunk: &str) {
    // Concatenate raw chunks without trimming or inserting spaces.
    // Model tokens (including sub-word fragments for non-Latin scripts)
    // must be joined as-is to preserve correct text.
    buffer.push_str(chunk);
}

fn is_write_tool(name: &str) -> bool {
    matches!(name, "kb_create" | "kb_update")
}

struct ToolExecOutcome {
    index: usize,
    tool_call_id: String,
    tool_name: String,
    result_str: String,
    is_write: bool,
    verify_failed: bool,
    tool_ok: bool,
    invalid_args: bool,
}

impl Agent {
    async fn execute_one_tool(
        &self,
        tc: &ToolCall,
        index: usize,
        iteration: usize,
        run_id: &str,
        tool_ctx: &ToolExecutionContext<'_>,
    ) -> ToolExecOutcome {
        let is_write = is_write_tool(&tc.function.name);
        let args: Value =
            serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| json!({}));

        let tool_calling_payload = emit_run_state(
            self.emitter.as_ref(),
            run_id,
            AgentState::ToolCalling,
            iteration,
            Some(&tc.function.name),
        );
        append_run_event_ledger(
            self.store.as_ref(),
            run_id,
            iteration,
            "lifecycle",
            "agent:run_state",
            &tool_calling_payload,
        );

        let tool_start_payload = json!({
            "run_id": run_id,
            "id": tc.id,
            "iteration": iteration,
            "tool": tc.function.name,
            "args": args,
            "ts": now_iso(),
        });
        self.emitter.emit("agent:tool_start", &tool_start_payload);
        append_run_event_ledger(
            self.store.as_ref(),
            run_id,
            iteration,
            "tool",
            "agent:tool_start",
            &tool_start_payload,
        );

        emit_timeline_step(
            self.emitter.as_ref(),
            run_id,
            iteration,
            "tool_start",
            Some(&tc.function.name),
            args_preview(&args),
            None,
            None,
        );

        let result = self
            .tools
            .execute(&tc.function.name, args.clone(), tool_ctx)
            .await;
        let result_str = serde_json::to_string(&result).unwrap_or_else(|_| {
            json!({
                "ok": false,
                "action": "mcp.serialization",
                "error": {
                    "code": "serialize_failed",
                    "message": "Failed to serialize MCP tool result",
                    "retriable": false
                }
            })
            .to_string()
        });

        let verify_failed =
            result.pointer("/error/code").and_then(|v| v.as_str()) == Some("verify_mismatch");
        let tool_ok = result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        let invalid_args = !tool_ok
            && result.pointer("/error/code").and_then(|v| v.as_str()) == Some("invalid_arguments");

        let tool_result_payload = json!({
            "run_id": run_id,
            "id": tc.id,
            "iteration": iteration,
            "tool": tc.function.name,
            "result": result_str
        });
        self.emitter.emit("agent:tool_result", &tool_result_payload);
        let tool_result_ledger_payload = json!({
            "run_id": run_id,
            "id": tc.id,
            "iteration": iteration,
            "tool": tc.function.name,
            "result": result
        });
        append_run_event_ledger(
            self.store.as_ref(),
            run_id,
            iteration,
            "tool",
            "agent:tool_result",
            &tool_result_ledger_payload,
        );

        emit_timeline_step(
            self.emitter.as_ref(),
            run_id,
            iteration,
            "tool_result",
            Some(&tc.function.name),
            None,
            Some(extract_result_preview(
                &tool_result_ledger_payload["result"],
            )),
            extract_file_changes(&tool_result_ledger_payload["result"]),
        );

        let verifying_payload = emit_run_state(
            self.emitter.as_ref(),
            run_id,
            AgentState::Verifying,
            iteration,
            Some(&tc.function.name),
        );
        append_run_event_ledger(
            self.store.as_ref(),
            run_id,
            iteration,
            "lifecycle",
            "agent:run_state",
            &verifying_payload,
        );

        let verification_event = build_verification_event(
            run_id,
            iteration,
            &tc.function.name,
            &tool_result_ledger_payload["result"],
        );
        self.emitter.emit("agent:verification", &verification_event);
        append_run_event_ledger(
            self.store.as_ref(),
            run_id,
            iteration,
            "verification",
            "agent:verification",
            &verification_event,
        );

        emit_timeline_step(
            self.emitter.as_ref(),
            run_id,
            iteration,
            "verify",
            Some(&tc.function.name),
            None,
            Some(build_verify_summary(&tool_result_ledger_payload["result"])),
            extract_file_changes(&tool_result_ledger_payload["result"]),
        );

        ToolExecOutcome {
            index,
            tool_call_id: tc.id.clone(),
            tool_name: tc.function.name.clone(),
            result_str,
            is_write,
            verify_failed,
            tool_ok,
            invalid_args,
        }
    }

    pub async fn run(&self, request: RunRequest<'_>) -> Result<RunResult, DynError> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let run_budget = request.budget.clone();
        let run_started = Instant::now();
        let mut total_write_calls = 0u32;
        let mut verify_failures = 0u32;
        let mut total_tool_calls = 0u32;
        let mut total_token_usage = TokenUsage::default();

        start_run_ledger(
            self.store.as_ref(),
            &run_id,
            request.conversation_id,
            request.provider,
            request.model,
            &request.policy_version,
            &request.policy_fingerprint,
        );

        let mut messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: request.instructions,
                tool_calls: None,
                tool_call_id: None,
                tool_name: None,
                thought_signatures: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: request.user_message.to_string(),
                tool_calls: None,
                tool_call_id: None,
                tool_name: None,
                thought_signatures: None,
            },
        ];

        let accepted_payload = emit_run_state(
            self.emitter.as_ref(),
            &run_id,
            AgentState::Accepted,
            0,
            if request.is_regeneration {
                Some("regeneration")
            } else {
                Some("new_run")
            },
        );
        append_run_event_ledger(
            self.store.as_ref(),
            &run_id,
            0,
            "lifecycle",
            "agent:run_state",
            &accepted_payload,
        );

        let mut timeline_steps = 0usize;
        let is_cold_start = request.note_count == 0;
        let indexing_active = is_indexing_active();
        if !is_cold_start && request.indexed_chunks == 0 {
            let reason = format!(
                "index_not_ready:indexed_chunks=0,indexed_files={},note_count={},indexing_active={}",
                request.indexed_files,
                request.note_count,
                indexing_active,
            );
            let user_message = if indexing_active {
                "Index is updating. Wait for reindex to finish before chat.".to_string()
            } else {
                "Index is empty. Run reindex before chatting.".to_string()
            };
            emit_timeline_step(
                self.emitter.as_ref(),
                &run_id,
                0,
                "done",
                None,
                None,
                Some(user_message.clone()),
                None,
            );
            timeline_steps += 1;
            emit_timeline_done(self.emitter.as_ref(), &run_id, 0, timeline_steps);
            emit_state_and_finish(
                self.emitter.as_ref(),
                self.store.as_ref(),
                &run_id,
                0,
                AgentState::Failed,
                Some(&reason),
                total_tool_calls,
                total_write_calls,
                verify_failures,
                run_started,
                &total_token_usage,
            );
            return Err(user_message.into());
        }

        let tools = self.tools.tool_definitions_for_llm();
        let tool_ctx = ToolExecutionContext {
            vault_path: request.vault_path,
            db_path: request.db_path,
            embedding_key: request.embedding_key,
            embedding_model_id: request.embedding_model_id,
            tavily_api_key: request.tavily_api_key,
            search_provider: request.search_provider,
            searxng_base_url: request.searxng_base_url,
            brave_api_key: request.brave_api_key,
        };

        for iteration in 0..run_budget.max_iterations as usize {
            if let Some(reason) = budget_timeout_reason(
                &run_budget,
                run_started,
                iteration,
                total_tool_calls,
                &messages,
            ) {
                emit_timeline_step(
                    self.emitter.as_ref(),
                    &run_id,
                    iteration,
                    "done",
                    None,
                    None,
                    Some(format!("Agent timed out: {reason}")),
                    None,
                );
                timeline_steps += 1;
                emit_timeline_done(self.emitter.as_ref(), &run_id, iteration, timeline_steps);
                let result = emit_state_and_finish(
                    self.emitter.as_ref(),
                    self.store.as_ref(),
                    &run_id,
                    iteration,
                    AgentState::Timeout,
                    Some(&reason),
                    total_tool_calls,
                    total_write_calls,
                    verify_failures,
                    run_started,
                    &total_token_usage,
                );
                return Ok(result);
            }

            let planning_payload = emit_run_state(
                self.emitter.as_ref(),
                &run_id,
                AgentState::Planning,
                iteration,
                None,
            );
            append_run_event_ledger(
                self.store.as_ref(),
                &run_id,
                iteration,
                "lifecycle",
                "agent:run_state",
                &planning_payload,
            );
            emit_timeline_step(
                self.emitter.as_ref(),
                &run_id,
                iteration,
                "plan",
                None,
                None,
                Some(if request.is_regeneration && iteration == 0 {
                    "Regeneration run".to_string()
                } else {
                    "Planning next action".to_string()
                }),
                None,
            );
            timeline_steps += 1;

            let (tx, mut rx) = mpsc::unbounded_channel();

            let api_key_for_llm = request.api_key.to_string();
            let provider_for_llm = request.provider.to_string();
            let model_for_llm = request.model.to_string();
            let msgs = messages.clone();
            let tools_clone = tools.clone();
            let llm = self.llm.clone();

            let thinking_budget = if iteration == 0 {
                Some(4096)
            } else {
                Some(1024)
            };
            let llm_handle = tokio::spawn(async move {
                llm.chat_stream(LlmChatRequest {
                    api_key: &api_key_for_llm,
                    provider: &provider_for_llm,
                    model: &model_for_llm,
                    messages: &msgs,
                    tools: Some(&tools_clone),
                    tx,
                    thinking_budget,
                })
                .await
            });

            let mut text_response = String::new();
            let mut tool_calls = Vec::new();
            let mut thought_sigs: Vec<String> = Vec::new();
            let mut thinking_state_emitted = false;
            let mut thinking_summary_buffer = String::new();
            let mut last_thinking_summary_sent = String::new();
            let mut last_thinking_summary_emit = Instant::now() - Duration::from_secs(5);
            let llm_response_timeout = Duration::from_millis(run_budget.llm_response_timeout_ms);

            loop {
                let event = match tokio::time::timeout(llm_response_timeout, rx.recv()).await {
                    Ok(Some(event)) => event,
                    Ok(None) => break,
                    Err(_) => {
                        let reason = format!(
                            "llm_response_timeout:{}ms",
                            run_budget.llm_response_timeout_ms
                        );
                        emit_timeline_step(
                            self.emitter.as_ref(),
                            &run_id,
                            iteration,
                            "done",
                            None,
                            None,
                            Some("LLM response timeout".to_string()),
                            None,
                        );
                        timeline_steps += 1;
                        emit_timeline_done(
                            self.emitter.as_ref(),
                            &run_id,
                            iteration,
                            timeline_steps,
                        );
                        emit_state_and_finish(
                            self.emitter.as_ref(),
                            self.store.as_ref(),
                            &run_id,
                            iteration,
                            AgentState::Failed,
                            Some(&reason),
                            total_tool_calls,
                            total_write_calls,
                            verify_failures,
                            run_started,
                            &total_token_usage,
                        );
                        llm_handle.abort();
                        return Err("LLM response timeout".into());
                    }
                };

                match event {
                    StreamEvent::Text(text) => {
                        self.emitter.emit("chat:chunk", &json!(text));
                        self.emitter.emit(
                            "agent:stream_delta",
                            &json!({
                                "run_id": run_id,
                                "iteration": iteration,
                                "channel": "assistant",
                                "text_delta": text.clone(),
                                "ts": now_iso(),
                            }),
                        );
                        text_response.push_str(&text);
                    }
                    StreamEvent::ThinkingSummary(text) => {
                        if text.trim().is_empty() {
                            continue;
                        }

                        if !thinking_state_emitted {
                            let run_state_payload = emit_run_state(
                                self.emitter.as_ref(),
                                &run_id,
                                AgentState::Thinking,
                                iteration,
                                None,
                            );
                            append_run_event_ledger(
                                self.store.as_ref(),
                                &run_id,
                                iteration,
                                "lifecycle",
                                "agent:run_state",
                                &run_state_payload,
                            );
                            thinking_state_emitted = true;
                        }

                        append_thinking_chunk(&mut thinking_summary_buffer, &text);

                        let now = Instant::now();
                        let sentence_boundary =
                            text.ends_with('.') || text.ends_with('!') || text.ends_with('?');
                        let interval_elapsed = now.duration_since(last_thinking_summary_emit)
                            >= Duration::from_millis(650);
                        let buffer_is_large = thinking_summary_buffer.len() >= 180;

                        if sentence_boundary || interval_elapsed || buffer_is_large {
                            let summary = normalize_thinking_summary(&thinking_summary_buffer);
                            if !summary.is_empty() && summary != last_thinking_summary_sent {
                                let thinking_payload = json!({
                                    "run_id": run_id,
                                    "iteration": iteration,
                                    "text": summary,
                                    "ts": now_iso(),
                                });
                                self.emitter
                                    .emit("agent:thinking_summary", &thinking_payload);
                                last_thinking_summary_sent = summary;
                                last_thinking_summary_emit = now;
                            }
                        }
                    }
                    StreamEvent::ToolCall(tc) => {
                        self.emitter.emit(
                            "agent:tool_call",
                            &json!({
                                "run_id": run_id,
                                "id": tc.id.clone(),
                                "iteration": iteration,
                                "tool": tc.function.name.clone(),
                                "args": tc.function.arguments.clone()
                            }),
                        );
                        tool_calls.push(tc);
                    }
                    StreamEvent::ThoughtSignature(sig) => thought_sigs.push(sig),
                    StreamEvent::Usage(usage) => {
                        let usage_delta =
                            serde_json::to_value(&usage).unwrap_or_else(|_| json!({}));
                        total_token_usage.saturating_add_assign(&usage);
                        let cumulative_usage =
                            serde_json::to_value(&total_token_usage).unwrap_or_else(|_| json!({}));
                        let payload = json!({
                            "run_id": run_id,
                            "iteration": iteration,
                            "usage": usage_delta,
                            "cumulative_usage": cumulative_usage,
                            "ts": now_iso(),
                        });
                        self.emitter.emit("agent:token_usage", &payload);
                        append_run_event_ledger(
                            self.store.as_ref(),
                            &run_id,
                            iteration,
                            "metrics",
                            "agent:token_usage",
                            &payload,
                        );
                    }
                    StreamEvent::Recovery(recovery) => {
                        let (event_type, payload, summary) = match recovery {
                            RecoveryEvent::Retry {
                                provider,
                                model,
                                attempt,
                                max_attempts,
                                retry_in_ms,
                                error,
                            } => {
                                let summary = format!(
                                    "Retrying {provider}:{model} ({attempt}/{max_attempts}) in {retry_in_ms}ms"
                                );
                                let payload = json!({
                                    "run_id": run_id,
                                    "iteration": iteration,
                                    "provider": provider,
                                    "model": model,
                                    "attempt": attempt,
                                    "max_attempts": max_attempts,
                                    "retry_in_ms": retry_in_ms,
                                    "error": error,
                                    "ts": now_iso(),
                                });
                                ("agent:provider_retry", payload, summary)
                            }
                            RecoveryEvent::Fallback {
                                from_model_id,
                                to_model_id,
                                reason,
                            } => {
                                let summary =
                                    format!("Fallback switch: {from_model_id} -> {to_model_id}");
                                let payload = json!({
                                    "run_id": run_id,
                                    "iteration": iteration,
                                    "from_model_id": from_model_id,
                                    "to_model_id": to_model_id,
                                    "reason": reason,
                                    "ts": now_iso(),
                                });
                                ("agent:provider_fallback", payload, summary)
                            }
                        };

                        self.emitter.emit(event_type, &payload);
                        append_run_event_ledger(
                            self.store.as_ref(),
                            &run_id,
                            iteration,
                            "lifecycle",
                            event_type,
                            &payload,
                        );

                        emit_timeline_step(
                            self.emitter.as_ref(),
                            &run_id,
                            iteration,
                            event_type,
                            None,
                            None,
                            Some(summary),
                            None,
                        );
                        timeline_steps += 1;
                    }
                    StreamEvent::Done => break,
                    StreamEvent::Error(e) => {
                        emit_state_and_finish(
                            self.emitter.as_ref(),
                            self.store.as_ref(),
                            &run_id,
                            iteration,
                            AgentState::Failed,
                            Some(&e),
                            total_tool_calls,
                            total_write_calls,
                            verify_failures,
                            run_started,
                            &total_token_usage,
                        );
                        return Err(e.into());
                    }
                }
            }

            if !thinking_summary_buffer.is_empty() {
                let summary = normalize_thinking_summary(&thinking_summary_buffer);
                if !summary.is_empty() && summary != last_thinking_summary_sent {
                    let thinking_payload = json!({
                        "run_id": run_id,
                        "iteration": iteration,
                        "text": summary,
                        "ts": now_iso(),
                    });
                    self.emitter
                        .emit("agent:thinking_summary", &thinking_payload);
                }
            }

            match llm_handle.await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    let reason = e.to_string();
                    emit_state_and_finish(
                        self.emitter.as_ref(),
                        self.store.as_ref(),
                        &run_id,
                        iteration,
                        AgentState::Failed,
                        Some(&reason),
                        total_tool_calls,
                        total_write_calls,
                        verify_failures,
                        run_started,
                        &total_token_usage,
                    );
                    return Err(e);
                }
                Err(join_err) => {
                    let reason = format!("llm_task_join_failed:{join_err}");
                    emit_state_and_finish(
                        self.emitter.as_ref(),
                        self.store.as_ref(),
                        &run_id,
                        iteration,
                        AgentState::Failed,
                        Some(&reason),
                        total_tool_calls,
                        total_write_calls,
                        verify_failures,
                        run_started,
                        &total_token_usage,
                    );
                    return Err(format!("LLM task failed: {join_err}").into());
                }
            }

            if tool_calls.is_empty() {
                if text_response.trim().is_empty() {
                    let reason = "Model returned an empty response".to_string();
                    emit_timeline_step(
                        self.emitter.as_ref(),
                        &run_id,
                        iteration,
                        "done",
                        None,
                        None,
                        Some(reason.clone()),
                        None,
                    );
                    timeline_steps += 1;
                    emit_timeline_done(self.emitter.as_ref(), &run_id, iteration, timeline_steps);
                    emit_state_and_finish(
                        self.emitter.as_ref(),
                        self.store.as_ref(),
                        &run_id,
                        iteration,
                        AgentState::Failed,
                        Some(&reason),
                        total_tool_calls,
                        total_write_calls,
                        verify_failures,
                        run_started,
                        &total_token_usage,
                    );
                    return Err(reason.into());
                }

                let responding_payload = emit_run_state(
                    self.emitter.as_ref(),
                    &run_id,
                    AgentState::Responding,
                    iteration,
                    None,
                );
                append_run_event_ledger(
                    self.store.as_ref(),
                    &run_id,
                    iteration,
                    "lifecycle",
                    "agent:run_state",
                    &responding_payload,
                );
                emit_timeline_step(
                    self.emitter.as_ref(),
                    &run_id,
                    iteration,
                    "done",
                    None,
                    None,
                    Some("Assistant response completed".to_string()),
                    None,
                );
                timeline_steps += 1;
                emit_timeline_done(self.emitter.as_ref(), &run_id, iteration, timeline_steps);
                let result = emit_state_and_finish(
                    self.emitter.as_ref(),
                    self.store.as_ref(),
                    &run_id,
                    iteration,
                    AgentState::Completed,
                    None,
                    total_tool_calls,
                    total_write_calls,
                    verify_failures,
                    run_started,
                    &total_token_usage,
                );
                return Ok(result);
            }

            let assistant_text_is_empty = text_response.trim().is_empty();
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: text_response,
                tool_calls: Some(tool_calls.clone()),
                tool_call_id: None,
                tool_name: None,
                thought_signatures: if thought_sigs.is_empty() {
                    None
                } else {
                    Some(thought_sigs)
                },
            });

            // Budget check once before batch
            if let Some(reason) = budget_timeout_reason(
                &run_budget,
                run_started,
                iteration,
                total_tool_calls,
                &messages,
            ) {
                emit_timeline_step(
                    self.emitter.as_ref(),
                    &run_id,
                    iteration,
                    "done",
                    None,
                    None,
                    Some(format!("Agent timed out: {reason}")),
                    None,
                );
                timeline_steps += 1;
                emit_timeline_done(self.emitter.as_ref(), &run_id, iteration, timeline_steps);
                let result = emit_state_and_finish(
                    self.emitter.as_ref(),
                    self.store.as_ref(),
                    &run_id,
                    iteration,
                    AgentState::Timeout,
                    Some(&reason),
                    total_tool_calls,
                    total_write_calls,
                    verify_failures,
                    run_started,
                    &total_token_usage,
                );
                return Ok(result);
            }

            // Partition into reads (parallel) and writes (sequential)
            let (reads, writes): (Vec<_>, Vec<_>) = tool_calls
                .iter()
                .enumerate()
                .partition(|(_, tc)| !is_write_tool(&tc.function.name));

            // Parallel reads via join_all (no 'static needed — borrows &self, &tool_ctx)
            let read_futures = reads
                .iter()
                .map(|(idx, tc)| self.execute_one_tool(tc, *idx, iteration, &run_id, &tool_ctx));
            let read_outcomes = futures::future::join_all(read_futures).await;

            // Sequential writes
            let mut write_outcomes = Vec::new();
            for (idx, tc) in &writes {
                let outcome = self
                    .execute_one_tool(tc, *idx, iteration, &run_id, &tool_ctx)
                    .await;
                write_outcomes.push(outcome);
            }

            // Merge, sort by original index, update counters, append messages
            let mut all_outcomes: Vec<ToolExecOutcome> =
                read_outcomes.into_iter().chain(write_outcomes).collect();
            all_outcomes.sort_by_key(|o| o.index);

            let mut invalid_argument_tools: HashSet<String> = HashSet::new();
            let mut failed_tool_calls = 0usize;

            for outcome in &all_outcomes {
                total_tool_calls += 1;
                if outcome.is_write {
                    total_write_calls += 1;
                }
                if outcome.verify_failed {
                    verify_failures += 1;
                }
                if !outcome.tool_ok {
                    failed_tool_calls += 1;
                    if outcome.invalid_args {
                        invalid_argument_tools.insert(outcome.tool_name.clone());
                    }
                }
                // 3 timeline steps per tool: tool_start, tool_result, verify
                timeline_steps += 3;

                messages.push(ChatMessage {
                    role: "tool".to_string(),
                    content: outcome.result_str.clone(),
                    tool_calls: None,
                    tool_call_id: Some(outcome.tool_call_id.clone()),
                    tool_name: Some(outcome.tool_name.clone()),
                    thought_signatures: None,
                });
            }
            if iteration == 0
                && !invalid_argument_tools.is_empty()
                && failed_tool_calls == tool_calls.len()
                && assistant_text_is_empty
            {
                let failed_list = invalid_argument_tools
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join(", ");
                let recovery_hint = format!(
                    "Tool validation failed on first attempt ({failed_list}). Retry with complete required arguments from each tool schema and apply fork heuristics: kb_update + not_found => kb_create(path, content); kb_create + file_exists => kb_read then kb_update(path, content); kb_update + noop=true => stop writing; verify_mismatch => kb_read and retry once with full file content."
                );
                messages.push(ChatMessage {
                    role: "system".to_string(),
                    content: recovery_hint.clone(),
                    tool_calls: None,
                    tool_call_id: None,
                    tool_name: None,
                    thought_signatures: None,
                });
                emit_timeline_step(
                    self.emitter.as_ref(),
                    &run_id,
                    iteration,
                    "recovery_hint",
                    None,
                    None,
                    Some(recovery_hint),
                    None,
                );
                timeline_steps += 1;
            }

            let compaction = maybe_compact_context(
                self.emitter.as_ref(),
                self.store.as_ref(),
                &run_id,
                iteration,
                &mut messages,
                request.provider,
                request.model,
                request.api_key,
                self.llm.as_ref(),
                self.tools.as_ref(),
                &tool_ctx,
            )
            .await;
            if compaction.compacted {
                if compaction.flush_write_executed {
                    total_tool_calls += 1;
                    total_write_calls += 1;
                }
                if compaction.flush_verify_mismatch {
                    verify_failures += 1;
                }
                if let Some(payload) = compaction.event_payload {
                    let before_tokens = payload
                        .get("before_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or_default();
                    let after_tokens = payload
                        .get("after_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or_default();
                    let removed_messages = payload
                        .get("removed_messages")
                        .and_then(|v| v.as_u64())
                        .unwrap_or_default();
                    emit_timeline_step(
                        self.emitter.as_ref(),
                        &run_id,
                        iteration,
                        "context_compaction",
                        None,
                        None,
                        Some(format!(
                            "Compacted context: {before_tokens}→{after_tokens} tokens, removed {removed_messages} messages"
                        )),
                        None,
                    );
                    timeline_steps += 1;
                }
            }
        }

        emit_timeline_step(
            self.emitter.as_ref(),
            &run_id,
            run_budget.max_iterations as usize,
            "done",
            None,
            None,
            Some("Agent timed out: max_iterations_reached".to_string()),
            None,
        );
        timeline_steps += 1;
        emit_timeline_done(
            self.emitter.as_ref(),
            &run_id,
            run_budget.max_iterations as usize,
            timeline_steps,
        );

        let result = emit_state_and_finish(
            self.emitter.as_ref(),
            self.store.as_ref(),
            &run_id,
            run_budget.max_iterations as usize,
            AgentState::Timeout,
            Some("max_iterations_reached"),
            total_tool_calls,
            total_write_calls,
            verify_failures,
            run_started,
            &total_token_usage,
        );

        Ok(result)
    }
}
