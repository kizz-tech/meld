use std::time::{Duration, Instant};

use crate::core::ports::llm::ChatMessage;

#[derive(Debug, Clone)]
pub struct RunBudget {
    pub max_iterations: u32,
    pub max_tool_calls: u32,
    pub token_budget: Option<u64>,
    pub time_budget_ms: u64,
    pub llm_response_timeout_ms: u64,
}

impl Default for RunBudget {
    fn default() -> Self {
        Self {
            max_iterations: 15,
            max_tool_calls: 30,
            token_budget: None,
            time_budget_ms: 300_000,
            llm_response_timeout_ms: 180_000,
        }
    }
}

pub(super) fn approximate_token_count(messages: &[ChatMessage]) -> u64 {
    messages
        .iter()
        .map(|msg| {
            let content_tokens = (msg.content.chars().count() as u64 / 4) + 8;
            let tool_name_tokens = msg.tool_name.as_ref().map(|name| name.len() as u64 / 4);
            content_tokens + tool_name_tokens.unwrap_or(0)
        })
        .sum()
}

pub(super) fn budget_timeout_reason(
    budget: &RunBudget,
    run_started: Instant,
    iteration: usize,
    tool_calls: u32,
    messages: &[ChatMessage],
) -> Option<String> {
    if run_started.elapsed() > Duration::from_millis(budget.time_budget_ms) {
        return Some("time_budget_exceeded".to_string());
    }

    if iteration as u32 >= budget.max_iterations {
        return Some("max_iterations_reached".to_string());
    }

    if tool_calls >= budget.max_tool_calls {
        return Some("max_tool_calls_reached".to_string());
    }

    if let Some(token_budget) = budget.token_budget {
        let token_count = approximate_token_count(messages);
        if token_count >= token_budget {
            return Some("token_budget_exceeded".to_string());
        }
    }

    None
}

pub(super) fn approximate_model_context_limit(model: &str) -> u64 {
    let normalized = model.to_ascii_lowercase();
    if normalized.contains("gemini-2.5")
        || normalized.contains("gemini-3")
        || normalized.contains("gemini-1.5")
    {
        1_000_000
    } else if normalized.contains("claude") {
        200_000
    } else if normalized.contains("gpt-5")
        || normalized.contains("gpt-4.1")
        || normalized.contains("gpt-4o")
    {
        128_000
    } else if normalized.contains("qwen") {
        131_072
    } else {
        64_000
    }
}
