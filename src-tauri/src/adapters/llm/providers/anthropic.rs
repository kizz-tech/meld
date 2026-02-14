use crate::adapters::llm::{
    ChatMessage, FunctionCall, StreamEvent, TokenUsage, ToolCall, ToolDefinition,
};
use futures::StreamExt;
use serde::Serialize;
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Debug, Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<serde_json::Value>,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct AnthropicMessage {
    role: String,
    content: serde_json::Value,
}

/// Build Anthropic messages from ChatMessage list.
/// Merges consecutive tool responses into a single user message with multiple tool_result blocks.
/// Formats assistant messages with tool_use content blocks when tool_calls are present.
fn build_messages(messages: &[ChatMessage]) -> Vec<AnthropicMessage> {
    let mut result: Vec<AnthropicMessage> = Vec::new();
    let mut pending_tool_results: Vec<serde_json::Value> = Vec::new();

    for m in messages.iter().filter(|m| m.role != "system") {
        match m.role.as_str() {
            "tool" => {
                // Accumulate tool results — will be merged into one user message
                pending_tool_results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.as_deref().unwrap_or(""),
                    "content": m.content
                }));
            }
            _ => {
                // Flush pending tool results before any non-tool message
                if !pending_tool_results.is_empty() {
                    result.push(AnthropicMessage {
                        role: "user".to_string(),
                        content: json!(std::mem::take(&mut pending_tool_results)),
                    });
                }

                match m.role.as_str() {
                    "assistant" => {
                        let content = if let Some(tool_calls) = &m.tool_calls {
                            // Assistant message with tool_use blocks
                            let mut blocks: Vec<serde_json::Value> = Vec::new();
                            if !m.content.is_empty() {
                                blocks.push(json!({"type": "text", "text": m.content}));
                            }
                            for tc in tool_calls {
                                let input: serde_json::Value =
                                    serde_json::from_str(&tc.function.arguments)
                                        .unwrap_or(json!({}));
                                blocks.push(json!({
                                    "type": "tool_use",
                                    "id": tc.id,
                                    "name": tc.function.name,
                                    "input": input
                                }));
                            }
                            json!(blocks)
                        } else {
                            json!(m.content)
                        };

                        result.push(AnthropicMessage {
                            role: "assistant".to_string(),
                            content,
                        });
                    }
                    _ => {
                        // User message
                        result.push(AnthropicMessage {
                            role: m.role.clone(),
                            content: json!(m.content),
                        });
                    }
                }
            }
        }
    }

    // Flush remaining tool results
    if !pending_tool_results.is_empty() {
        result.push(AnthropicMessage {
            role: "user".to_string(),
            content: json!(pending_tool_results),
        });
    }

    result
}

pub async fn chat_stream(
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    tx: mpsc::UnboundedSender<StreamEvent>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();

    let system = messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone());

    let anthropic_messages = build_messages(messages);

    let anthropic_tools = tools.map(|t| {
        t.iter()
            .map(|tool| {
                json!({
                    "name": tool.function.name,
                    "description": tool.function.description,
                    "input_schema": tool.function.parameters
                })
            })
            .collect::<Vec<_>>()
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2025-04-14")
        .header("content-type", "application/json")
        .json(&AnthropicRequest {
            model: model.to_string(),
            max_tokens: 8192,
            system,
            messages: anthropic_messages,
            tools: anthropic_tools,
            thinking: thinking_config_for_model(model),
            stream: true,
        })
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error ({}): {}", status, body).into());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    // Track current tool call being built
    let mut current_tool_id = String::new();
    let mut current_tool_name = String::new();
    let mut current_tool_input = String::new();
    let mut usage_totals = TokenUsage::default();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(usage) = extract_anthropic_usage(&parsed) {
                        usage_totals.merge_max_assign(&usage);
                    }

                    let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

                    match event_type {
                        "content_block_start" => {
                            if let Some(cb) = parsed.get("content_block") {
                                let block_type =
                                    cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                if block_type == "tool_use" {
                                    current_tool_id = cb
                                        .get("id")
                                        .and_then(|i| i.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    current_tool_name = cb
                                        .get("name")
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    current_tool_input.clear();
                                }
                            }
                        }
                        "content_block_delta" => {
                            if let Some(delta) = parsed.get("delta") {
                                let delta_type =
                                    delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                match delta_type {
                                    "text_delta" => {
                                        if let Some(text) =
                                            delta.get("text").and_then(|t| t.as_str())
                                        {
                                            if !text.is_empty() {
                                                let _ =
                                                    tx.send(StreamEvent::Text(text.to_string()));
                                            }
                                        }
                                    }
                                    "thinking_delta" => {
                                        if let Some(thinking) = delta
                                            .get("thinking")
                                            .and_then(|t| t.as_str())
                                            .or_else(|| delta.get("text").and_then(|t| t.as_str()))
                                        {
                                            let trimmed = thinking.trim();
                                            if !trimmed.is_empty() {
                                                let _ = tx.send(StreamEvent::ThinkingSummary(
                                                    trimmed.to_string(),
                                                ));
                                            }
                                        }
                                    }
                                    "input_json_delta" => {
                                        if let Some(partial) =
                                            delta.get("partial_json").and_then(|p| p.as_str())
                                        {
                                            current_tool_input.push_str(partial);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "content_block_stop" => {
                            if !current_tool_name.is_empty() {
                                let _ = tx.send(StreamEvent::ToolCall(ToolCall {
                                    id: current_tool_id.clone(),
                                    r#type: "function".to_string(),
                                    function: FunctionCall {
                                        name: current_tool_name.clone(),
                                        arguments: current_tool_input.clone(),
                                    },
                                    thought_signature: None,
                                }));
                                current_tool_name.clear();
                                current_tool_id.clear();
                                current_tool_input.clear();
                            }
                        }
                        "error" => {
                            let msg = parsed
                                .get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(|m| m.as_str())
                                .unwrap_or("Unknown error");
                            return Err(format!("Anthropic error: {}", msg).into());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    if !usage_totals.is_empty() {
        let _ = tx.send(StreamEvent::Usage(usage_totals));
    }
    let _ = tx.send(StreamEvent::Done);
    Ok(())
}

fn parse_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    value.and_then(|raw| {
        raw.as_u64().or_else(|| {
            raw.as_i64()
                .and_then(|number| (number >= 0).then_some(number as u64))
        })
    })
}

fn parse_anthropic_usage(usage: &serde_json::Value) -> Option<TokenUsage> {
    let parsed = TokenUsage {
        input_tokens: parse_u64(usage.get("input_tokens")),
        output_tokens: parse_u64(usage.get("output_tokens")),
        total_tokens: parse_u64(usage.get("total_tokens")),
        reasoning_tokens: parse_u64(usage.get("reasoning_tokens")),
        cache_read_tokens: parse_u64(usage.get("cache_read_input_tokens")),
        cache_write_tokens: parse_u64(usage.get("cache_creation_input_tokens")),
    };

    (!parsed.is_empty()).then_some(parsed)
}

fn extract_anthropic_usage(parsed: &serde_json::Value) -> Option<TokenUsage> {
    parsed
        .get("usage")
        .and_then(parse_anthropic_usage)
        .or_else(|| {
            parsed
                .get("message")
                .and_then(|message| message.get("usage"))
                .and_then(parse_anthropic_usage)
        })
}

fn thinking_config_for_model(model: &str) -> Option<serde_json::Value> {
    let lowered = model.to_ascii_lowercase();
    if lowered.contains("claude-opus-4-6") {
        return Some(json!({
            "type": "adaptive",
        }));
    }

    if lowered.contains("claude-sonnet-4-5") {
        return Some(json!({
            "type": "enabled",
            "budget_tokens": 10000,
        }));
    }

    None
}
