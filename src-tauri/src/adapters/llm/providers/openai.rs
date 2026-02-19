use crate::adapters::llm::{
    ChatMessage, FunctionCall, StreamEvent, TokenUsage, ToolCall, ToolDefinition,
};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::mpsc;

#[derive(Debug, Serialize)]
struct OpenAIChatCompletionsRequest {
    model: String,
    messages: Vec<OpenAIMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Value>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<OpenAIStreamOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<OpenRouterReasoningConfig>,
}

#[derive(Debug, Serialize)]
struct OpenAIResponsesRequest {
    model: String,
    input: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Value>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<OpenAIReasoningConfig>,
}

#[derive(Debug, Serialize)]
struct OpenAIMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenAIReasoningConfig {
    effort: String,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
struct OpenRouterReasoningConfig {
    max_tokens: u32,
}

#[derive(Debug, Serialize)]
struct OpenAIStreamOptions {
    include_usage: bool,
}

#[derive(Debug, Default, Clone)]
struct ResponsesToolCallBuffer {
    order: usize,
    item_id: String,
    call_id: String,
    name: String,
    arguments: String,
}

pub async fn chat_stream(
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    tx: mpsc::UnboundedSender<StreamEvent>,
    thinking_budget: Option<u32>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();
    let endpoint = "https://api.openai.com/v1/responses";

    let instructions = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    let body = OpenAIResponsesRequest {
        model: model.to_string(),
        input: build_responses_input(messages),
        instructions: if instructions.is_empty() {
            None
        } else {
            Some(instructions)
        },
        tools: build_responses_tools(tools),
        stream: true,
        reasoning: build_openai_reasoning_config(model, thinking_budget),
    };

    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI API error ({status}): {body}").into());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut current_event: Option<String> = None;
    let mut current_data = String::new();
    let mut tool_calls: HashMap<String, ResponsesToolCallBuffer> = HashMap::new();
    let mut tool_call_counter = 0usize;
    let mut has_reasoning_summary = false;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let mut line = buffer[..line_end].to_string();
            buffer = buffer[line_end + 1..].to_string();
            if line.ends_with('\r') {
                line.pop();
            }

            if line.is_empty() {
                if !current_data.is_empty() {
                    handle_responses_sse_event(
                        &tx,
                        current_event.as_deref(),
                        current_data.trim_end(),
                        &mut tool_calls,
                        &mut tool_call_counter,
                        &mut has_reasoning_summary,
                    )?;
                    current_event = None;
                    current_data.clear();
                }
                continue;
            }

            if let Some(event_name) = line.strip_prefix("event:") {
                current_event = Some(event_name.trim().to_string());
                continue;
            }

            if let Some(data) = line.strip_prefix("data:") {
                current_data.push_str(data.trim_start());
                current_data.push('\n');
            }
        }
    }

    if !current_data.is_empty() {
        handle_responses_sse_event(
            &tx,
            current_event.as_deref(),
            current_data.trim_end(),
            &mut tool_calls,
            &mut tool_call_counter,
            &mut has_reasoning_summary,
        )?;
    }

    emit_buffered_tool_calls(&tx, tool_calls);
    let _ = tx.send(StreamEvent::Done);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn chat_stream_with_endpoint(
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    tx: mpsc::UnboundedSender<StreamEvent>,
    endpoint: &str,
    provider_name: &str,
    thinking_budget: Option<u32>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();

    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&OpenAIChatCompletionsRequest {
            model: model.to_string(),
            messages: build_chat_completion_messages(messages),
            tools: build_chat_completion_tools(tools),
            stream: true,
            stream_options: if provider_name == "OpenRouter" {
                None
            } else {
                Some(OpenAIStreamOptions {
                    include_usage: true,
                })
            },
            reasoning: if provider_name == "OpenRouter" {
                Some(OpenRouterReasoningConfig {
                    max_tokens: thinking_budget.unwrap_or(2048),
                })
            } else {
                None
            },
        })
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("{provider_name} API error ({status}): {body}").into());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut tool_calls: HashMap<usize, (String, String, String)> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let mut line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.ends_with('\r') {
                line.pop();
            }

            if line.is_empty() || line == "data: [DONE]" {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    if let Some(error) = parsed.get("error") {
                        let msg = error
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error");
                        return Err(format!("{provider_name} error: {msg}").into());
                    }
                    maybe_emit_openai_usage(&tx, &parsed);

                    if let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) {
                        for choice in choices {
                            let delta = &choice["delta"];

                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                if !content.is_empty() {
                                    let _ = tx.send(StreamEvent::Text(content.to_string()));
                                }
                            }

                            if provider_name == "OpenRouter" {
                                emit_openrouter_reasoning_delta(&tx, delta);
                            }

                            if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                                for tc in tcs {
                                    let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0)
                                        as usize;
                                    let entry = tool_calls.entry(idx).or_insert_with(|| {
                                        (String::new(), String::new(), String::new())
                                    });

                                    if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                                        entry.0 = id.to_string();
                                    }
                                    if let Some(func) = tc.get("function") {
                                        if let Some(name) =
                                            func.get("name").and_then(|n| n.as_str())
                                        {
                                            if entry.1.is_empty() {
                                                entry.1 = name.to_string();
                                            }
                                        }
                                        if let Some(args) =
                                            func.get("arguments").and_then(|a| a.as_str())
                                        {
                                            entry.2.push_str(args);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut sorted_indices: Vec<usize> = tool_calls.keys().cloned().collect();
    sorted_indices.sort_unstable();

    for idx in sorted_indices {
        if let Some((id, name, args)) = tool_calls.remove(&idx) {
            let tool_name = if name.trim().is_empty() {
                "unknown_tool".to_string()
            } else {
                name
            };
            let tool_args = if args.trim().is_empty() {
                "{}".to_string()
            } else {
                args
            };
            let _ = tx.send(StreamEvent::ToolCall(ToolCall {
                id,
                r#type: "function".to_string(),
                function: FunctionCall {
                    name: tool_name,
                    arguments: tool_args,
                },
                thought_signature: None,
            }));
        }
    }

    let _ = tx.send(StreamEvent::Done);
    Ok(())
}

fn build_chat_completion_messages(messages: &[ChatMessage]) -> Vec<OpenAIMessage> {
    messages
        .iter()
        .map(|m| {
            let content = if m.content.is_empty() && m.tool_calls.is_some() {
                None
            } else {
                Some(m.content.clone())
            };

            OpenAIMessage {
                role: m.role.clone(),
                content,
                tool_calls: m.tool_calls.as_ref().map(|calls| {
                    calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": tc.r#type,
                                "function": {
                                    "name": tc.function.name,
                                    "arguments": tc.function.arguments
                                }
                            })
                        })
                        .collect::<Vec<_>>()
                }),
                tool_call_id: m.tool_call_id.clone(),
            }
        })
        .collect()
}

fn build_chat_completion_tools(tools: Option<&[ToolDefinition]>) -> Option<Vec<Value>> {
    tools.map(|items| {
        items
            .iter()
            .map(|tool| serde_json::to_value(tool).unwrap_or_else(|_| json!({})))
            .collect::<Vec<_>>()
    })
}

fn build_responses_tools(tools: Option<&[ToolDefinition]>) -> Option<Vec<Value>> {
    tools.map(|items| {
        items
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.function.name,
                    "description": tool.function.description,
                    "parameters": tool.function.parameters,
                })
            })
            .collect::<Vec<_>>()
    })
}

fn build_responses_input(messages: &[ChatMessage]) -> Vec<Value> {
    let mut input = Vec::new();

    for message in messages.iter().filter(|m| m.role != "system") {
        match message.role.as_str() {
            "tool" => {
                if let Some(call_id) = message
                    .tool_call_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                {
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": message.content,
                    }));
                } else if !message.content.trim().is_empty() {
                    input.push(json!({
                        "role": "user",
                        "content": message.content,
                    }));
                }
            }
            "assistant" => {
                if !message.content.trim().is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": message.content,
                    }));
                }

                if let Some(tool_calls) = &message.tool_calls {
                    for tc in tool_calls {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": tc.id,
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        }));
                    }
                }
            }
            _ => {
                input.push(json!({
                    "role": message.role,
                    "content": message.content,
                }));
            }
        }
    }

    input
}

fn build_openai_reasoning_config(
    model: &str,
    thinking_budget: Option<u32>,
) -> Option<OpenAIReasoningConfig> {
    if !is_reasoning_model(model) {
        return None;
    }

    Some(OpenAIReasoningConfig {
        effort: "medium".to_string(),
        summary: "auto".to_string(),
        max_tokens: Some(thinking_budget.unwrap_or(2048)),
    })
}

fn is_reasoning_model(model: &str) -> bool {
    let lowered = model.trim().to_ascii_lowercase();
    lowered.starts_with("o1")
        || lowered.starts_with("o3")
        || lowered.starts_with("o4")
        || lowered.starts_with("gpt-5")
}

fn emit_openrouter_reasoning_delta(tx: &mpsc::UnboundedSender<StreamEvent>, delta: &Value) {
    // OpenRouter may include both reasoning_details and reasoning with the same
    // content. Prefer reasoning_details; use reasoning only as fallback.
    let mut emitted = false;

    if let Some(details) = delta.get("reasoning_details").and_then(|v| v.as_array()) {
        for detail in details {
            if let Some(text) = detail.get("text").and_then(|v| v.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    let _ = tx.send(StreamEvent::ThinkingSummary(trimmed.to_string()));
                    emitted = true;
                }
            }
        }
    }

    if !emitted {
        if let Some(summary_text) = delta.get("reasoning").and_then(|v| v.as_str()) {
            let trimmed = summary_text.trim();
            if !trimmed.is_empty() {
                let _ = tx.send(StreamEvent::ThinkingSummary(trimmed.to_string()));
            }
        }
    }
}

fn parse_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|raw| {
        raw.as_u64().or_else(|| {
            raw.as_i64()
                .and_then(|number| (number >= 0).then_some(number as u64))
        })
    })
}

fn parse_openai_usage(usage: &Value) -> Option<TokenUsage> {
    let input_tokens =
        parse_u64(usage.get("input_tokens")).or_else(|| parse_u64(usage.get("prompt_tokens")));
    let output_tokens =
        parse_u64(usage.get("output_tokens")).or_else(|| parse_u64(usage.get("completion_tokens")));
    let total_tokens = parse_u64(usage.get("total_tokens"));
    let reasoning_tokens = parse_u64(usage.get("reasoning_tokens"))
        .or_else(|| {
            parse_u64(
                usage
                    .get("output_tokens_details")
                    .and_then(|details| details.get("reasoning_tokens")),
            )
        })
        .or_else(|| {
            parse_u64(
                usage
                    .get("completion_tokens_details")
                    .and_then(|details| details.get("reasoning_tokens")),
            )
        });
    let cache_read_tokens = parse_u64(usage.get("cached_tokens"))
        .or_else(|| {
            parse_u64(
                usage
                    .get("input_tokens_details")
                    .and_then(|details| details.get("cached_tokens")),
            )
        })
        .or_else(|| {
            parse_u64(
                usage
                    .get("prompt_tokens_details")
                    .and_then(|details| details.get("cached_tokens")),
            )
        });

    let usage = TokenUsage {
        input_tokens,
        output_tokens,
        total_tokens,
        reasoning_tokens,
        cache_read_tokens,
        cache_write_tokens: None,
    };

    (!usage.is_empty()).then_some(usage)
}

fn extract_openai_usage(parsed: &Value) -> Option<TokenUsage> {
    parsed
        .get("usage")
        .and_then(parse_openai_usage)
        .or_else(|| {
            parsed
                .get("response")
                .and_then(|response| response.get("usage"))
                .and_then(parse_openai_usage)
        })
}

fn maybe_emit_openai_usage(tx: &mpsc::UnboundedSender<StreamEvent>, parsed: &Value) {
    if let Some(usage) = extract_openai_usage(parsed) {
        let _ = tx.send(StreamEvent::Usage(usage));
    }
}

fn handle_responses_sse_event(
    tx: &mpsc::UnboundedSender<StreamEvent>,
    event_name: Option<&str>,
    data: &str,
    tool_calls: &mut HashMap<String, ResponsesToolCallBuffer>,
    tool_call_counter: &mut usize,
    has_reasoning_summary: &mut bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if data.trim().is_empty() || data.trim() == "[DONE]" {
        return Ok(());
    }

    let parsed: Value = serde_json::from_str(data)?;

    if let Some(error) = parsed.get("error") {
        let message = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown error");
        return Err(format!("OpenAI error: {message}").into());
    }
    maybe_emit_openai_usage(tx, &parsed);

    let event_type = event_name
        .or_else(|| parsed.get("type").and_then(|value| value.as_str()))
        .unwrap_or_default();

    if event_type.contains("output_text.delta") {
        if let Some(delta) = parsed.get("delta").and_then(|value| value.as_str()) {
            if !delta.is_empty() {
                let _ = tx.send(StreamEvent::Text(delta.to_string()));
            }
        }
        return Ok(());
    }

    // OpenAI may emit both reasoning_summary_text.delta and reasoning_text.delta
    // with the same content. Prefer summary; use raw reasoning only as fallback.
    if event_type.contains("reasoning_summary_text.delta") {
        *has_reasoning_summary = true;
        if let Some(delta) = parsed.get("delta").and_then(|value| value.as_str()) {
            let trimmed = delta.trim();
            if !trimmed.is_empty() {
                let _ = tx.send(StreamEvent::ThinkingSummary(trimmed.to_string()));
            }
        }
        return Ok(());
    }

    if event_type.contains("reasoning_text.delta") {
        if !*has_reasoning_summary {
            if let Some(delta) = parsed.get("delta").and_then(|value| value.as_str()) {
                let trimmed = delta.trim();
                if !trimmed.is_empty() {
                    let _ = tx.send(StreamEvent::ThinkingSummary(trimmed.to_string()));
                }
            }
        }
        return Ok(());
    }

    if event_type.contains("output_item.added") || event_type.contains("output_item.done") {
        if let Some(item) = parsed.get("item") {
            record_function_call_item(
                item,
                parsed.get("output_index"),
                tool_calls,
                tool_call_counter,
            );
        }

        if event_type.contains("output_item.done") {
            maybe_record_response_output(parsed.get("response"), tool_calls, tool_call_counter);
        }

        return Ok(());
    }

    if event_type.contains("function_call_arguments.delta")
        || event_type.contains("function_call_arguments.done")
    {
        record_function_call_arguments_delta(&parsed, event_type, tool_calls, tool_call_counter);
        return Ok(());
    }

    if event_type.contains("response.completed") {
        maybe_record_response_output(parsed.get("response"), tool_calls, tool_call_counter);
    }

    Ok(())
}

fn record_function_call_item(
    item: &Value,
    output_index: Option<&Value>,
    tool_calls: &mut HashMap<String, ResponsesToolCallBuffer>,
    tool_call_counter: &mut usize,
) {
    if item.get("type").and_then(|v| v.as_str()) != Some("function_call") {
        return;
    }

    let key = derive_call_key(item, output_index);
    let entry = tool_calls.entry(key).or_insert_with(|| {
        let order = *tool_call_counter;
        *tool_call_counter += 1;
        ResponsesToolCallBuffer {
            order,
            ..ResponsesToolCallBuffer::default()
        }
    });

    if let Some(item_id) = item.get("id").and_then(|v| v.as_str()) {
        entry.item_id = item_id.to_string();
    }
    if let Some(call_id) = item.get("call_id").and_then(|v| v.as_str()) {
        entry.call_id = call_id.to_string();
    }
    if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
        entry.name = name.to_string();
    }
    if let Some(arguments) = item.get("arguments").and_then(|v| v.as_str()) {
        entry.arguments = arguments.to_string();
    }
}

fn record_function_call_arguments_delta(
    parsed: &Value,
    event_type: &str,
    tool_calls: &mut HashMap<String, ResponsesToolCallBuffer>,
    tool_call_counter: &mut usize,
) {
    let key = derive_call_key(parsed, parsed.get("output_index"));
    let entry = tool_calls.entry(key).or_insert_with(|| {
        let order = *tool_call_counter;
        *tool_call_counter += 1;
        ResponsesToolCallBuffer {
            order,
            ..ResponsesToolCallBuffer::default()
        }
    });

    if let Some(item_id) = parsed.get("item_id").and_then(|v| v.as_str()) {
        entry.item_id = item_id.to_string();
    }
    if let Some(call_id) = parsed.get("call_id").and_then(|v| v.as_str()) {
        entry.call_id = call_id.to_string();
    }
    if let Some(name) = parsed.get("name").and_then(|v| v.as_str()) {
        entry.name = name.to_string();
    }

    if event_type.contains("arguments.done") {
        if let Some(arguments) = parsed.get("arguments").and_then(|v| v.as_str()) {
            entry.arguments = arguments.to_string();
        }
    } else if let Some(delta) = parsed.get("delta").and_then(|v| v.as_str()) {
        entry.arguments.push_str(delta);
    }
}

fn maybe_record_response_output(
    response: Option<&Value>,
    tool_calls: &mut HashMap<String, ResponsesToolCallBuffer>,
    tool_call_counter: &mut usize,
) {
    let Some(output) = response
        .and_then(|resp| resp.get("output"))
        .and_then(|value| value.as_array())
    else {
        return;
    };

    for item in output {
        record_function_call_item(item, None, tool_calls, tool_call_counter);
    }
}

fn derive_call_key(value: &Value, output_index: Option<&Value>) -> String {
    if let Some(item_id) = value.get("item_id").and_then(|v| v.as_str()) {
        return format!("item:{item_id}");
    }
    if let Some(item_id) = value.get("id").and_then(|v| v.as_str()) {
        return format!("id:{item_id}");
    }
    if let Some(call_id) = value.get("call_id").and_then(|v| v.as_str()) {
        return format!("call:{call_id}");
    }
    if let Some(index) = output_index.and_then(|v| v.as_u64()) {
        return format!("output:{index}");
    }
    "unknown".to_string()
}

fn emit_buffered_tool_calls(
    tx: &mpsc::UnboundedSender<StreamEvent>,
    tool_calls: HashMap<String, ResponsesToolCallBuffer>,
) {
    let mut ordered = tool_calls.into_values().collect::<Vec<_>>();
    ordered.sort_by_key(|entry| entry.order);

    for entry in ordered {
        let id = if !entry.call_id.trim().is_empty() {
            entry.call_id.clone()
        } else if !entry.item_id.trim().is_empty() {
            entry.item_id.clone()
        } else {
            uuid::Uuid::new_v4().to_string()
        };

        let name = if entry.name.trim().is_empty() {
            "unknown_tool".to_string()
        } else {
            entry.name
        };

        let arguments = if entry.arguments.trim().is_empty() {
            "{}".to_string()
        } else {
            entry.arguments
        };

        let _ = tx.send(StreamEvent::ToolCall(ToolCall {
            id,
            r#type: "function".to_string(),
            function: FunctionCall { name, arguments },
            thought_signature: None,
        }));
    }
}
