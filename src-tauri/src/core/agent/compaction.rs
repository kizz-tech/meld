use serde_json::{json, Value};
use std::collections::HashSet;
use tokio::sync::mpsc;

use crate::core::ports::emitter::EmitterPort;
use crate::core::ports::llm::{ChatMessage, LlmChatRequest, LlmPort, StreamEvent};
use crate::core::ports::store::StorePort;
use crate::core::ports::tools::{ToolExecutionContext, ToolPort};

use super::budget::{approximate_model_context_limit, approximate_token_count};
use super::events::now_iso;
use super::ledger::append_run_event_ledger;

fn message_importance(index: usize, total: usize, message: &ChatMessage) -> i32 {
    let has_tool_calls = message
        .tool_calls
        .as_ref()
        .map(|calls| !calls.is_empty())
        .unwrap_or(false)
        || message.role == "tool";
    let is_recent = index + 6 >= total;
    let is_user = message.role == "user";

    (if has_tool_calls { 3 } else { 0 })
        + (if is_recent { 2 } else { 0 })
        + (if is_user { 1 } else { 0 })
}

fn parse_tool_result(message: &ChatMessage) -> Option<Value> {
    if message.role != "tool" {
        return None;
    }
    serde_json::from_str::<Value>(&message.content).ok()
}

fn has_verified_write_in_messages(messages: &[ChatMessage]) -> bool {
    messages.iter().any(|message| {
        let is_write_tool = matches!(
            message.tool_name.as_deref(),
            Some("kb_create") | Some("kb_update")
        );
        if !is_write_tool {
            return false;
        }
        parse_tool_result(message)
            .and_then(|payload| payload.get("ok").and_then(|v| v.as_bool()))
            .unwrap_or(false)
    })
}

fn needs_pre_compaction_flush(messages: &[ChatMessage]) -> bool {
    let has_human_content = messages.iter().any(|msg| {
        (msg.role == "user" || msg.role == "assistant") && !msg.content.trim().is_empty()
    });
    has_human_content && !has_verified_write_in_messages(messages)
}

fn format_messages_for_summary(messages: &[ChatMessage], max_chars: usize) -> String {
    let mut remaining = max_chars;
    let mut parts = Vec::new();

    for message in messages {
        if remaining == 0 {
            break;
        }
        let role = message.role.to_ascii_uppercase();
        let mut content = message.content.trim().to_string();
        if content.is_empty() {
            continue;
        }
        if content.len() > 1200 {
            content.truncate(1200);
        }
        let chunk = format!("{role}: {content}");
        if chunk.len() >= remaining {
            let mut truncated = chunk;
            truncated.truncate(remaining);
            parts.push(truncated);
            break;
        }
        remaining -= chunk.len();
        parts.push(chunk);
    }

    parts.join("\n\n")
}

async fn summarize_messages_for_compaction(
    llm: &dyn LlmPort,
    api_key: &str,
    provider: &str,
    model: &str,
    messages: &[ChatMessage],
) -> Option<String> {
    let formatted = format_messages_for_summary(messages, 12_000);
    if formatted.trim().is_empty() {
        return None;
    }

    let summary_prompt = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "Summarize the provided chat history in 2-3 sentences. Keep key decisions, unresolved tasks, and factual constraints.".to_string(),
            tool_calls: None,
            tool_call_id: None,
            tool_name: None,
            thought_signatures: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("History to summarize:\n\n{formatted}"),
            tool_calls: None,
            tool_call_id: None,
            tool_name: None,
            thought_signatures: None,
        },
    ];

    let (tx, mut rx) = mpsc::unbounded_channel();
    let reader_handle = tokio::spawn(async move {
        let mut summary = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                StreamEvent::Text(text) => summary.push_str(&text),
                StreamEvent::Done => break,
                StreamEvent::Error(_) => return None,
                StreamEvent::ToolCall(_)
                | StreamEvent::Usage(_)
                | StreamEvent::ThoughtSignature(_)
                | StreamEvent::ThinkingSummary(_)
                | StreamEvent::Recovery(_) => {}
            }
        }
        Some(summary)
    });

    if llm
        .chat_stream(LlmChatRequest {
            api_key,
            provider,
            model,
            messages: &summary_prompt,
            tools: None,
            tx,
        })
        .await
        .is_err()
    {
        return None;
    }
    let summary = reader_handle.await.ok().flatten()?;

    let trimmed = summary.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn pre_compaction_flush(
    tools: &dyn ToolPort,
    tool_ctx: &ToolExecutionContext<'_>,
    summary: &str,
) -> Value {
    let path = "context-compaction-flush";
    let ts = now_iso();
    let read_result = tools
        .execute("kb_read", json!({ "path": path }), tool_ctx)
        .await;
    let existing = read_result
        .pointer("/result/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let content = if existing.trim().is_empty() {
        format!("---\ntags:\n  - zettel\n---\n\n# Context Compaction Flush\n\n## {ts}\n{summary}")
    } else {
        format!("{existing}\n\n## {ts}\n{summary}")
    };

    let write_tool = if read_result.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        "kb_update"
    } else {
        "kb_create"
    };

    tools
        .execute(
            write_tool,
            json!({
                "path": path,
                "content": content
            }),
            tool_ctx,
        )
        .await
}

pub(super) struct CompactionResult {
    pub(super) compacted: bool,
    pub(super) flush_write_executed: bool,
    pub(super) flush_verify_mismatch: bool,
    pub(super) event_payload: Option<Value>,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn maybe_compact_context(
    emitter: &dyn EmitterPort,
    store: &dyn StorePort,
    run_id: &str,
    iteration: usize,
    messages: &mut Vec<ChatMessage>,
    provider: &str,
    model: &str,
    api_key: &str,
    llm: &dyn LlmPort,
    tools: &dyn ToolPort,
    tool_ctx: &ToolExecutionContext<'_>,
) -> CompactionResult {
    let model_limit = approximate_model_context_limit(model);
    let before_tokens = approximate_token_count(messages);
    let trigger_threshold = (model_limit as f64 * 0.80) as u64;

    if before_tokens < trigger_threshold || messages.len() < 4 {
        return CompactionResult {
            compacted: false,
            flush_write_executed: false,
            flush_verify_mismatch: false,
            event_payload: None,
        };
    }

    let total = messages.len();
    let recent_keep = 6usize.min(total.saturating_sub(1));
    let compaction_end = total.saturating_sub(recent_keep);
    if compaction_end <= 1 {
        return CompactionResult {
            compacted: false,
            flush_write_executed: false,
            flush_verify_mismatch: false,
            event_payload: None,
        };
    }

    let mut drop_indices = Vec::new();
    for (idx, msg) in messages.iter().enumerate().take(compaction_end).skip(1) {
        let score = message_importance(idx, total, msg);
        if score <= 2 {
            drop_indices.push(idx);
        }
    }

    if drop_indices.is_empty() {
        for idx in 1..compaction_end {
            drop_indices.push(idx);
            if drop_indices.len() >= 3 {
                break;
            }
        }
    }

    if drop_indices.is_empty() {
        return CompactionResult {
            compacted: false,
            flush_write_executed: false,
            flush_verify_mismatch: false,
            event_payload: None,
        };
    }

    let dropped_messages: Vec<ChatMessage> = drop_indices
        .iter()
        .map(|idx| messages[*idx].clone())
        .collect();

    let summary =
        summarize_messages_for_compaction(llm, api_key, provider, model, &dropped_messages)
        .await
        .unwrap_or_else(|| {
            "Conversation context was compacted. Keep using tool outputs and recent user constraints for subsequent steps."
                .to_string()
        });

    let mut flush_write_executed = false;
    let mut flush_verify_mismatch = false;
    if needs_pre_compaction_flush(&dropped_messages) {
        flush_write_executed = true;
        let flush_result = pre_compaction_flush(tools, tool_ctx, &summary).await;
        flush_verify_mismatch =
            flush_result.pointer("/error/code").and_then(|v| v.as_str()) == Some("verify_mismatch");
    }

    let remove_set: HashSet<usize> = drop_indices.into_iter().collect();
    let mut compacted = Vec::with_capacity(messages.len() - remove_set.len() + 1);
    for (idx, message) in messages.iter().cloned().enumerate() {
        if !remove_set.contains(&idx) {
            compacted.push(message);
        }
    }

    compacted.insert(
        1,
        ChatMessage {
            role: "system".to_string(),
            content: format!("Context compaction summary: {summary}"),
            tool_calls: None,
            tool_call_id: None,
            tool_name: None,
            thought_signatures: None,
        },
    );

    *messages = compacted;
    let after_tokens = approximate_token_count(messages);
    let payload = json!({
        "run_id": run_id,
        "iteration": iteration,
        "event_type": "agent:context_compaction",
        "before_tokens": before_tokens,
        "after_tokens": after_tokens,
        "model_context_limit": model_limit,
        "trigger_threshold": trigger_threshold,
        "removed_messages": remove_set.len(),
        "flush_write_executed": flush_write_executed,
        "summary_chars": summary.len(),
        "ts": now_iso(),
    });
    emitter.emit("agent:context_compaction", &payload);
    append_run_event_ledger(
        store,
        run_id,
        iteration,
        "timeline",
        "agent:context_compaction",
        &payload,
    );

    CompactionResult {
        compacted: true,
        flush_write_executed,
        flush_verify_mismatch,
        event_payload: Some(payload),
    }
}
