use crate::adapters::llm::{
    ChatMessage, FunctionCall, StreamEvent, TokenUsage, ToolCall, ToolDefinition,
};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

#[derive(Debug, Serialize)]
struct GoogleRequest {
    contents: Vec<GoogleContent>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "systemInstruction")]
    system_instruction: Option<GoogleContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<GoogleTool>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "generationConfig")]
    generation_config: Option<Value>,
}

#[derive(Debug, Serialize)]
struct GoogleContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    parts: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct GoogleTool {
    #[serde(rename = "functionDeclarations")]
    function_declarations: Vec<serde_json::Value>,
}

/// Convert ChatMessage list into Gemini-format contents.
/// Handles: assistant→model, tool→user with functionResponse, thought signatures,
/// and merges consecutive tool messages into a single user turn.
fn build_contents(messages: &[ChatMessage]) -> Vec<GoogleContent> {
    let mut contents: Vec<GoogleContent> = Vec::new();
    let mut pending_fn_responses: Vec<serde_json::Value> = Vec::new();

    for m in messages.iter().filter(|m| m.role != "system") {
        match m.role.as_str() {
            "tool" => {
                // Accumulate functionResponse parts — merged into one user message
                let name = m.tool_name.as_deref().unwrap_or("unknown");
                // Gemini expects functionResponse.response to be a JSON object.
                // Tool output can be array/string/number, so normalize those into { "result": ... }.
                let parsed: Value =
                    serde_json::from_str(&m.content).unwrap_or_else(|_| json!(m.content));
                let response_payload = match parsed {
                    Value::Object(map) => Value::Object(map),
                    other => json!({ "result": other }),
                };

                let mut function_response = json!({
                    "name": name,
                    "response": response_payload
                });
                if let Some(call_id) = m.tool_call_id.as_deref().filter(|id| !id.is_empty()) {
                    if let Some(obj) = function_response.as_object_mut() {
                        obj.insert("id".to_string(), json!(call_id));
                    }
                }

                pending_fn_responses.push(json!({
                    "functionResponse": function_response
                }));
            }
            _ => {
                // Flush pending function responses before any non-tool message
                if !pending_fn_responses.is_empty() {
                    contents.push(GoogleContent {
                        role: Some("user".to_string()),
                        parts: std::mem::take(&mut pending_fn_responses),
                    });
                }

                match m.role.as_str() {
                    "assistant" => {
                        let mut parts = Vec::new();

                        // functionCall parts from tool_calls
                        if let Some(tool_calls) = &m.tool_calls {
                            for tc in tool_calls {
                                let args: serde_json::Value =
                                    serde_json::from_str(&tc.function.arguments)
                                        .unwrap_or(json!({}));
                                let function_call = json!({
                                    "name": tc.function.name,
                                    "args": args
                                });
                                let mut part = json!({
                                    "functionCall": function_call
                                });
                                if let Some(sig) =
                                    tc.thought_signature.as_deref().filter(|s| !s.is_empty())
                                {
                                    if let Some(obj) = part.as_object_mut() {
                                        obj.insert("thoughtSignature".to_string(), json!(sig));
                                    }
                                }
                                parts.push(part);
                            }
                        }

                        // Text part (only if there's actual text)
                        if !m.content.is_empty() {
                            parts.push(json!({"text": m.content}));
                        }

                        // Gemini 3 thought signatures — echo back verbatim
                        if let Some(sigs) = &m.thought_signatures {
                            for sig in sigs {
                                parts.push(json!({"thoughtSignature": sig}));
                            }
                        }

                        // Must have at least one part
                        if parts.is_empty() {
                            parts.push(json!({"text": ""}));
                        }

                        contents.push(GoogleContent {
                            role: Some("model".to_string()),
                            parts,
                        });
                    }
                    _ => {
                        // user message
                        contents.push(GoogleContent {
                            role: Some("user".to_string()),
                            parts: vec![json!({"text": m.content})],
                        });
                    }
                }
            }
        }
    }

    // Flush remaining function responses
    if !pending_fn_responses.is_empty() {
        contents.push(GoogleContent {
            role: Some("user".to_string()),
            parts: pending_fn_responses,
        });
    }

    contents
}

pub async fn chat_stream(
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    tx: mpsc::UnboundedSender<StreamEvent>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();

    let system_instruction = messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| GoogleContent {
            role: None,
            parts: vec![json!({"text": m.content})],
        });

    let contents = build_contents(messages);

    let google_tools = tools.map(|t| {
        vec![GoogleTool {
            function_declarations: t
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.function.name,
                        "description": tool.function.description,
                        "parameters": tool.function.parameters
                    })
                })
                .collect(),
        }]
    });

    let base_url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse",
        model
    );

    let request_body = GoogleRequest {
        contents,
        system_instruction,
        tools: google_tools,
        generation_config: thinking_config_for_model(model),
    };

    log::debug!(
        "Google request: {}",
        serde_json::to_string_pretty(&request_body).unwrap_or_default()
    );

    let response = if api_key.trim().starts_with("AIza") {
        let url_with_key = format!("{base_url}&key={}", api_key.trim());
        client
            .post(&url_with_key)
            .json(&request_body)
            .send()
            .await?
    } else {
        client
            .post(&base_url)
            .bearer_auth(api_key.trim())
            .json(&request_body)
            .send()
            .await?
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Google API error ({}): {}", status, body).into());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
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
                    if let Some(usage) = extract_google_usage(&parsed) {
                        usage_totals.merge_max_assign(&usage);
                    }

                    // Check for API errors
                    if let Some(error) = parsed.get("error") {
                        let msg = error
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error");
                        return Err(format!("Google API error: {}", msg).into());
                    }

                    if let Some(candidates) = parsed.get("candidates").and_then(|c| c.as_array()) {
                        if let Some(candidate) = candidates.first() {
                            if let Some(content) = candidate.get("content") {
                                if let Some(parts) = content.get("parts").and_then(|p| p.as_array())
                                {
                                    for part in parts {
                                        let is_thought = part
                                            .get("thought")
                                            .and_then(|t| t.as_bool())
                                            .unwrap_or(false);

                                        if let Some(fc) = part.get("functionCall") {
                                            let id = fc
                                                .get("id")
                                                .and_then(|i| i.as_str())
                                                .filter(|i| !i.is_empty())
                                                .map(ToOwned::to_owned)
                                                .unwrap_or_else(|| {
                                                    uuid::Uuid::new_v4().to_string()
                                                });
                                            let name = fc
                                                .get("name")
                                                .and_then(|n| n.as_str())
                                                .unwrap_or("")
                                                .to_string();
                                            let args = fc.get("args").cloned().unwrap_or(json!({}));
                                            let thought_signature = fc
                                                .get("thoughtSignature")
                                                .and_then(|s| s.as_str())
                                                .or_else(|| {
                                                    part.get("thoughtSignature")
                                                        .and_then(|s| s.as_str())
                                                })
                                                .map(ToOwned::to_owned);
                                            let _ = tx.send(StreamEvent::ToolCall(ToolCall {
                                                id,
                                                r#type: "function".to_string(),
                                                function: FunctionCall {
                                                    name,
                                                    arguments: serde_json::to_string(&args)
                                                        .unwrap_or_default(),
                                                },
                                                thought_signature,
                                            }));
                                        }
                                        // Text content (or thought summary text)
                                        else if let Some(text) =
                                            part.get("text").and_then(|t| t.as_str())
                                        {
                                            if !text.is_empty() {
                                                if is_thought {
                                                    let _ = tx.send(StreamEvent::ThinkingSummary(
                                                        text.to_string(),
                                                    ));
                                                } else {
                                                    let _ = tx
                                                        .send(StreamEvent::Text(text.to_string()));
                                                }
                                            }
                                        }
                                        // Thought signature (Gemini 3)
                                        else if let Some(sig) =
                                            part.get("thoughtSignature").and_then(|s| s.as_str())
                                        {
                                            let _ = tx.send(StreamEvent::ThoughtSignature(
                                                sig.to_string(),
                                            ));
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

    if !usage_totals.is_empty() {
        let _ = tx.send(StreamEvent::Usage(usage_totals));
    }
    let _ = tx.send(StreamEvent::Done);
    Ok(())
}

fn parse_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|raw| {
        raw.as_u64().or_else(|| {
            raw.as_i64()
                .and_then(|number| (number >= 0).then_some(number as u64))
        })
    })
}

fn parse_google_usage(usage: &Value) -> Option<TokenUsage> {
    let parsed = TokenUsage {
        input_tokens: parse_u64(usage.get("promptTokenCount")),
        output_tokens: parse_u64(usage.get("candidatesTokenCount")),
        total_tokens: parse_u64(usage.get("totalTokenCount")),
        reasoning_tokens: parse_u64(usage.get("thoughtsTokenCount")),
        cache_read_tokens: parse_u64(usage.get("cachedContentTokenCount")),
        cache_write_tokens: None,
    };

    (!parsed.is_empty()).then_some(parsed)
}

fn extract_google_usage(parsed: &Value) -> Option<TokenUsage> {
    parsed
        .get("usageMetadata")
        .and_then(parse_google_usage)
        .or_else(|| {
            parsed
                .get("response")
                .and_then(|response| response.get("usageMetadata"))
                .and_then(parse_google_usage)
        })
}

fn thinking_config_for_model(model: &str) -> Option<Value> {
    let lowered = model.to_ascii_lowercase();
    if lowered.contains("gemini-2.5") {
        return Some(json!({
            "thinkingConfig": {
                "includeThoughts": true,
                "thinkingBudget": 8192
            }
        }));
    }

    if lowered.contains("gemini-3") {
        return Some(json!({
            "thinkingConfig": {
                "includeThoughts": true,
                "thinkingLevel": "medium"
            }
        }));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::build_contents;
    use crate::adapters::llm::{ChatMessage, FunctionCall, ToolCall};
    use serde_json::json;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            tool_name: None,
            thought_signatures: None,
        }
    }

    #[test]
    fn wraps_non_object_tool_output_for_function_response() {
        let mut tool_msg = msg("tool", r#"["a","b"]"#);
        tool_msg.tool_name = Some("kb_list".to_string());
        tool_msg.tool_call_id = Some("call_123".to_string());

        let contents = build_contents(&[tool_msg]);
        let part = contents[0].parts[0]
            .get("functionResponse")
            .cloned()
            .unwrap_or_default();

        assert_eq!(contents[0].role.as_deref(), Some("user"));
        assert_eq!(part.get("name"), Some(&json!("kb_list")));
        assert_eq!(part.get("id"), Some(&json!("call_123")));
        assert_eq!(
            part.get("response"),
            Some(&json!({
                "result": ["a", "b"]
            }))
        );
    }

    #[test]
    fn keeps_object_tool_output_as_response_object() {
        let mut tool_msg = msg("tool", r#"{"created":"notes/new.md"}"#);
        tool_msg.tool_name = Some("kb_create".to_string());

        let contents = build_contents(&[tool_msg]);
        let part = contents[0].parts[0]
            .get("functionResponse")
            .cloned()
            .unwrap_or_default();

        assert_eq!(
            part.get("response"),
            Some(&json!({
                "created": "notes/new.md"
            }))
        );
    }

    #[test]
    fn includes_thought_signature_on_function_call_part() {
        let assistant_msg = ChatMessage {
            role: "assistant".to_string(),
            content: String::new(),
            tool_calls: Some(vec![ToolCall {
                id: "call_1".to_string(),
                r#type: "function".to_string(),
                function: FunctionCall {
                    name: "kb_search".to_string(),
                    arguments: r#"{"query":"rust"}"#.to_string(),
                },
                thought_signature: Some("sig_abc".to_string()),
            }]),
            tool_call_id: None,
            tool_name: None,
            thought_signatures: None,
        };

        let contents = build_contents(&[assistant_msg]);
        let part = &contents[0].parts[0];

        assert_eq!(part.get("thoughtSignature"), Some(&json!("sig_abc")));
        assert_eq!(
            part.get("functionCall")
                .and_then(|fc| fc.get("thoughtSignature")),
            None
        );
        assert_eq!(
            part.get("functionCall")
                .and_then(|fc| fc.get("name"))
                .cloned(),
            Some(json!("kb_search"))
        );
    }
}
