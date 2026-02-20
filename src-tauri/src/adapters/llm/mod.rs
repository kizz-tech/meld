pub mod providers;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

use crate::core::ports::llm::{DynError, LlmChatRequest, LlmPort};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Tool name for tool-response messages (needed by Gemini functionResponse)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Gemini 3 thought signatures — opaque blobs echoed back across turns
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signatures: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub r#type: String,
    pub function: FunctionCall,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub r#type: String,
    pub function: FunctionDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug)]
pub enum StreamEvent {
    Text(String),
    ToolCall(ToolCall),
    Usage(TokenUsage),
    Recovery(RecoveryEvent),
    /// Gemini 3 thought signature to echo back in subsequent turns
    ThoughtSignature(String),
    /// Incremental thinking/reasoning summary from model stream
    ThinkingSummary(String),
    Done,
    #[allow(dead_code)]
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct TokenUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

impl TokenUsage {
    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none()
            && self.output_tokens.is_none()
            && self.total_tokens.is_none()
            && self.reasoning_tokens.is_none()
            && self.cache_read_tokens.is_none()
            && self.cache_write_tokens.is_none()
    }

    pub fn saturating_add_assign(&mut self, other: &TokenUsage) {
        self.input_tokens = add_optional(self.input_tokens, other.input_tokens);
        self.output_tokens = add_optional(self.output_tokens, other.output_tokens);
        self.total_tokens = add_optional(self.total_tokens, other.total_tokens);
        self.reasoning_tokens = add_optional(self.reasoning_tokens, other.reasoning_tokens);
        self.cache_read_tokens = add_optional(self.cache_read_tokens, other.cache_read_tokens);
        self.cache_write_tokens = add_optional(self.cache_write_tokens, other.cache_write_tokens);
    }

    pub fn merge_max_assign(&mut self, other: &TokenUsage) {
        self.input_tokens = max_optional(self.input_tokens, other.input_tokens);
        self.output_tokens = max_optional(self.output_tokens, other.output_tokens);
        self.total_tokens = max_optional(self.total_tokens, other.total_tokens);
        self.reasoning_tokens = max_optional(self.reasoning_tokens, other.reasoning_tokens);
        self.cache_read_tokens = max_optional(self.cache_read_tokens, other.cache_read_tokens);
        self.cache_write_tokens = max_optional(self.cache_write_tokens, other.cache_write_tokens);
    }
}

fn add_optional(current: Option<u64>, delta: Option<u64>) -> Option<u64> {
    match (current, delta) {
        (Some(lhs), Some(rhs)) => Some(lhs.saturating_add(rhs)),
        (None, Some(rhs)) => Some(rhs),
        (Some(lhs), None) => Some(lhs),
        (None, None) => None,
    }
}

fn max_optional(current: Option<u64>, candidate: Option<u64>) -> Option<u64> {
    match (current, candidate) {
        (Some(lhs), Some(rhs)) => Some(lhs.max(rhs)),
        (None, Some(rhs)) => Some(rhs),
        (Some(lhs), None) => Some(lhs),
        (None, None) => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RecoveryEvent {
    Retry {
        provider: String,
        model: String,
        attempt: u32,
        max_attempts: u32,
        retry_in_ms: u64,
        error: String,
    },
    Fallback {
        from_model_id: String,
        to_model_id: String,
        reason: String,
    },
}

fn is_retriable_provider_error(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    msg.contains("429")
        || msg.contains("500")
        || msg.contains("502")
        || msg.contains("503")
        || msg.contains("504")
        || msg.contains("timeout")
        || msg.contains("timed out")
        || msg.contains("temporar")
        || msg.contains("rate limit")
}

fn is_non_retriable_auth_error(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    msg.contains("401")
        || msg.contains("403")
        || msg.contains("unauthorized")
        || msg.contains("forbidden")
        || msg.contains("invalid api key")
}

fn is_tool_routing_unsupported_error(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    msg.contains("no endpoints found that support tool use")
        || (msg.contains("tool use") && msg.contains("provider-selection"))
}

fn should_retry_provider_error(message: &str) -> bool {
    if is_non_retriable_auth_error(message) || is_tool_routing_unsupported_error(message) {
        return false;
    }
    is_retriable_provider_error(message)
}

async fn run_chat_with_retries(
    provider: &dyn crate::adapters::providers::LlmProvider,
    model: &str,
    api_key: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    tx: &mpsc::UnboundedSender<StreamEvent>,
    thinking_budget: Option<u32>,
) -> Result<(), String> {
    let retry_delays_secs = [1_u64, 2_u64, 4_u64];
    let max_attempts = retry_delays_secs.len() + 1;
    let mut last_error = String::new();

    for attempt in 0..max_attempts {
        let result = provider
            .chat(crate::adapters::providers::ChatRequest {
                api_key,
                model,
                messages,
                tools,
                tx: tx.clone(),
                thinking_budget,
            })
            .await;

        match result {
            Ok(()) => return Ok(()),
            Err(err) => {
                let message = err.to_string();
                last_error = message.clone();
                if !should_retry_provider_error(&message) {
                    return Err(message);
                }

                if attempt + 1 >= max_attempts {
                    break;
                }
                let delay = retry_delays_secs.get(attempt).copied().unwrap_or(4);
                let _ = tx.send(StreamEvent::Recovery(RecoveryEvent::Retry {
                    provider: provider.id().to_string(),
                    model: model.to_string(),
                    attempt: (attempt + 1) as u32,
                    max_attempts: max_attempts as u32,
                    retry_in_ms: delay * 1000,
                    error: message,
                }));
                sleep(Duration::from_secs(delay)).await;
            }
        }
    }

    Err(last_error)
}

pub async fn chat_stream(
    api_key: &str,
    provider: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    tx: mpsc::UnboundedSender<StreamEvent>,
    thinking_budget: Option<u32>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let provider_id = provider.trim();
    let model_name = model.trim();
    let model_id = if provider_id.contains('/') && !provider_id.contains(' ') {
        // Backward-compat: old configs could persist OpenRouter model slug as provider,
        // e.g. provider="deepseek/deepseek-r1-0528", model="free".
        let stitched_model = if model_name.is_empty() {
            provider_id.to_string()
        } else {
            format!("{provider_id}:{model_name}")
        };
        format!("openrouter:{stitched_model}")
    } else {
        match crate::adapters::providers::split_model_id(model_name) {
            Ok((split_provider, _)) if split_provider.eq_ignore_ascii_case(provider_id) => {
                model_name.to_string()
            }
            _ => format!("{provider_id}:{model_name}"),
        }
    };

    let registry = crate::adapters::providers::ProviderRegistry::default();
    let (resolved_provider, resolved_model) = registry
        .resolve_llm(&model_id)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

    if tools.is_some() && !resolved_provider.supports_tools() {
        return Err(format!(
            "Provider '{}' does not support tool calls",
            resolved_provider.id()
        )
        .into());
    }

    if !resolved_provider.supports_streaming() {
        return Err(format!(
            "Provider '{}' does not support streaming",
            resolved_provider.id()
        )
        .into());
    }

    match run_chat_with_retries(
        resolved_provider,
        resolved_model,
        api_key,
        messages,
        tools,
        &tx,
        thinking_budget,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(mut primary_error) => {
            if tools.is_some() && is_tool_routing_unsupported_error(&primary_error) {
                primary_error = format!(
                    "{primary_error}. The selected model does not support tool use on OpenRouter. Choose a tool-capable model."
                );
            }

            let mut settings = crate::adapters::config::Settings::load_global();
            let fallback_model_id = settings.fallback_chat_model_id();

            if let Some(fallback_model_id) = fallback_model_id {
                if fallback_model_id == model_id {
                    return Err(primary_error.into());
                }

                if let Ok((fallback_provider, fallback_model)) =
                    registry.resolve_llm(&fallback_model_id)
                {
                    let fallback_tools = tools;

                    if fallback_tools.is_some() && !fallback_provider.supports_tools() {
                        return Err(format!(
                            "Primary failed ({primary_error}); fallback '{}' does not support tool calls",
                            fallback_provider.id()
                        )
                        .into());
                    }
                    if !fallback_provider.supports_streaming() {
                        return Err(format!(
                            "Primary failed ({primary_error}); fallback '{}' does not support streaming",
                            fallback_provider.id()
                        )
                        .into());
                    }

                    let fallback_api_key = crate::adapters::oauth::resolve_provider_credential(
                        &mut settings,
                        fallback_provider.id(),
                    )
                    .await
                    .ok()
                    .or_else(|| {
                        if fallback_provider.id() == resolved_provider.id() {
                            Some(api_key.to_string())
                        } else {
                            None
                        }
                    });

                    if let Some(fallback_key) = fallback_api_key {
                        let _ = tx.send(StreamEvent::Recovery(RecoveryEvent::Fallback {
                            from_model_id: model_id.clone(),
                            to_model_id: fallback_model_id.clone(),
                            reason: primary_error.clone(),
                        }));
                        return run_chat_with_retries(
                            fallback_provider,
                            fallback_model,
                            &fallback_key,
                            messages,
                            fallback_tools,
                            &tx,
                            thinking_budget,
                        )
                        .await
                        .map_err(|fallback_error| {
                            format!(
                                "Primary model '{}' failed: {}. Fallback model '{}' failed: {}",
                                model_id, primary_error, fallback_model_id, fallback_error
                            )
                            .into()
                        });
                    }
                }
            }

            Err(primary_error.into())
        }
    }
}

pub struct ChatLlmAdapter;

impl Default for ChatLlmAdapter {
    fn default() -> Self {
        Self
    }
}

impl ChatLlmAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl LlmPort for ChatLlmAdapter {
    fn chat_stream<'a>(
        &'a self,
        request: LlmChatRequest<'a>,
    ) -> BoxFuture<'a, Result<(), DynError>> {
        Box::pin(async move {
            chat_stream(
                request.api_key,
                request.provider,
                request.model,
                request.messages,
                request.tools,
                request.tx,
                request.thinking_budget,
            )
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_non_retriable_auth_error, is_retriable_provider_error, should_retry_provider_error,
    };

    #[test]
    fn retriable_error_detection_handles_rate_limit_and_timeout() {
        assert!(is_retriable_provider_error("429 Too Many Requests"));
        assert!(is_retriable_provider_error("request timed out"));
        assert!(is_retriable_provider_error("HTTP 503 service unavailable"));
    }

    #[test]
    fn auth_error_detection_handles_non_retriable_cases() {
        assert!(is_non_retriable_auth_error("401 unauthorized"));
        assert!(is_non_retriable_auth_error("403 Forbidden"));
        assert!(is_non_retriable_auth_error("invalid api key"));
    }

    #[test]
    fn tool_routing_errors_are_not_retried_even_if_wrapped_in_5xx() {
        let message = "OpenRouter API error (500): {\"error\":{\"message\":\"No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection\",\"code\":404}}";
        assert!(is_retriable_provider_error(message));
        assert!(!should_retry_provider_error(message));
    }
}
