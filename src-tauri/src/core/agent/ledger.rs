use serde_json::Value;

use crate::adapters::llm::TokenUsage;
use crate::core::ports::store::{RunFinishRecord, RunStartRecord, StorePort};

use super::state::AgentState;

pub(super) fn append_run_event_ledger(
    store: &dyn StorePort,
    run_id: &str,
    iteration: usize,
    channel: &str,
    event_type: &str,
    payload: &Value,
) {
    store.log_event(run_id, iteration, channel, event_type, payload);
}

pub(super) fn start_run_ledger(
    store: &dyn StorePort,
    run_id: &str,
    conversation_id: i64,
    provider: &str,
    model: &str,
    policy_version: &str,
    policy_fingerprint: &str,
) {
    store.start_run(RunStartRecord {
        run_id,
        conversation_id,
        provider,
        model,
        policy_version,
        policy_fingerprint,
    });
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finish_run_ledger(
    store: &dyn StorePort,
    run_id: &str,
    status: AgentState,
    tool_calls: u32,
    write_calls: u32,
    verify_failures: u32,
    duration_ms: u64,
    token_usage: Option<&TokenUsage>,
) {
    store.finish_run(RunFinishRecord {
        run_id,
        status,
        tool_calls,
        write_calls,
        verify_failures,
        duration_ms,
        input_tokens: token_usage.and_then(|usage| usage.input_tokens),
        output_tokens: token_usage.and_then(|usage| usage.output_tokens),
        total_tokens: token_usage.and_then(|usage| usage.total_tokens),
        reasoning_tokens: token_usage.and_then(|usage| usage.reasoning_tokens),
        cache_read_tokens: token_usage.and_then(|usage| usage.cache_read_tokens),
        cache_write_tokens: token_usage.and_then(|usage| usage.cache_write_tokens),
    });
}
